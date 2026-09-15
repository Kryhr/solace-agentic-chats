import assert from "node:assert/strict";
import { test } from "node:test";
import type { TrustLevel } from "@solace/shared";
import {
  buildCopilotArgs,
  copilotPermissionFlags,
  isNotSignedInError,
  solaceMcpConfig,
} from "./copilot-cli";
import { getPermissionCatalog } from "../core/permissionCatalog";
import { parseCopilotBuiltInCatalog } from "../core/cliModelSources";

const BASE = {
  loader: "C:\\npm\\node_modules\\@github\\copilot\\npm-loader.js",
  prompt: "do the thing",
  newSessionId: "new-id",
  agentId: "agent-1",
  serverPort: 4310,
};

// The authoritative permission vocabulary, taken from `copilot help permissions` on the
// installed 1.0.83 build. A deny pattern outside this set is silently meaningless rather than
// an error, which is the failure mode worth pinning: a typo'd `--deny-tool=shel` would leave an
// agent with full shell access and nothing would say so.
const DENY_KINDS = new Set(["write", "shell"]);

test("every trust level produces only permission flags Copilot actually defines", () => {
  for (const level of ["plan", "manual", "acceptEdits", "bypassPermissions", "auto"] as TrustLevel[]) {
    for (const flag of copilotPermissionFlags(level)) {
      const deny = /^--deny-tool=(.+)$/.exec(flag);
      if (deny) {
        assert.ok(DENY_KINDS.has(deny[1]), `${level} denies unknown permission kind "${deny[1]}"`);
      }
    }
  }
});

test("plan mode can neither write nor run a shell command", () => {
  // Verified behaviourally against the real CLI: a plan-mode turn asked to create a file and
  // run `echo` did neither - apply_patch came back "Plan mode does not permit changes outside
  // ..." and powershell "denied due to the following rules: `shell`". This pins the flags that
  // produced that, because a regression here is silent and only shows up as an agent the user
  // trusted to be read-only quietly editing their repo.
  const flags = copilotPermissionFlags("plan");
  assert.ok(flags.includes("--deny-tool=write"));
  assert.ok(flags.includes("--deny-tool=shell"));
  assert.deepEqual(flags.slice(0, 2), ["--mode", "plan"]);
  assert.ok(!flags.includes("--allow-all"));
});

test("acceptEdits allows edits but still gates the shell", () => {
  const flags = copilotPermissionFlags("acceptEdits");
  assert.ok(flags.includes("--deny-tool=shell"));
  assert.ok(!flags.includes("--deny-tool=write"));
  // Denial outranks --allow-all-tools in Copilot's own documented precedence, so the two
  // together are not a contradiction - that is exactly what makes this level expressible.
  assert.ok(flags.includes("--allow-all-tools"));
});

test("only the fully-trusting levels ever reach --allow-all", () => {
  for (const level of ["bypassPermissions", "auto"] as TrustLevel[]) {
    assert.deepEqual(copilotPermissionFlags(level), ["--allow-all"]);
  }
  for (const level of ["plan", "manual", "acceptEdits"] as TrustLevel[]) {
    assert.ok(!copilotPermissionFlags(level).includes("--allow-all"), `${level} must not get --allow-all`);
  }
});

test("manual falls back to the safest flags rather than a wider guess", () => {
  // Copilot has no external approval hook (its --assisted-approval is an LLM judge, not a
  // human), so "manual" is not offered in the catalog and this case is unreachable in practice.
  // If it is ever reached anyway, it must land on the restrictive end.
  assert.deepEqual(copilotPermissionFlags("manual"), copilotPermissionFlags("plan"));
});

test("the permission catalog only offers modes the mapping can honour", () => {
  const catalog = Object.fromEntries(getPermissionCatalog().map((info) => [info.provider, info.availableModes]));
  assert.deepEqual(catalog["copilot-cli"], ["plan", "acceptEdits", "bypassPermissions"]);
  // Asserted directly, so re-adding either has to be a deliberate act rather than a
  // copy-paste from another provider's line. "manual" would claim a human approval gate that
  // does not exist; "auto" would be a second name for bypassPermissions.
  assert.ok(!catalog["copilot-cli"].includes("manual"));
  assert.ok(!catalog["copilot-cli"].includes("auto"));
});

test("a first turn registers our session id and a later turn resumes the same one", () => {
  // Copilot's --session-id is BOTH "set the UUID for a new session" and "resume an existing
  // session by ID", so unlike gemini/qwen there is no second flag to switch to - the id simply
  // carries over. Confirmed live in both directions against the real CLI.
  const first = buildCopilotArgs({ ...BASE, trustLevel: "plan" });
  assert.equal(first[first.indexOf("--session-id") + 1], "new-id");

  const later = buildCopilotArgs({ ...BASE, trustLevel: "plan", sessionId: "old-id" });
  assert.equal(later[later.indexOf("--session-id") + 1], "old-id");
  assert.ok(!later.includes("--resume"));
});

test("never resumes a machine-scoped 'most recent' session", () => {
  // The bug this guards against is silent and cross-agent, and is the same trap as codex's
  // --last and qwen's -c: Copilot's --continue resumes the most recent session on the MACHINE,
  // so two Copilot agents in one workspace would inherit each other's conversation.
  for (const args of [
    buildCopilotArgs({ ...BASE, trustLevel: "bypassPermissions" }),
    buildCopilotArgs({ ...BASE, trustLevel: "bypassPermissions", sessionId: "old-id" }),
  ]) {
    assert.ok(!args.includes("--continue"));
    assert.ok(!args.includes("-c"));
  }
});

test("the prompt is passed to the loader, never to a cmd.exe shim", () => {
  // Copilot is the one adapter here that MUST put the prompt in argv: it has no stdin channel
  // for it (`-p -` is taken as the literal prompt "-"). That is only safe because argv[0] is
  // the package's own npm-loader.js run under `node` - a native .exe - instead of copilot.cmd,
  // whose cmd.exe command line would be truncated at the first newline. If this invariant ever
  // breaks, multi-line prompts start silently losing everything after line one.
  const args = buildCopilotArgs({ ...BASE, trustLevel: "plan", prompt: "line one\nline two" });
  assert.equal(args[0], BASE.loader);
  assert.ok(args[0].endsWith("npm-loader.js"));
  assert.ok(!args[0].endsWith(".cmd"));
  assert.equal(args[args.indexOf("-p") + 1], "line one\nline two");
});

test("only the prompt may contain a newline", () => {
  // The mcp-config JSON is the live risk: JSON.stringify with an indent argument would
  // introduce newlines into an argument that is not the prompt.
  const args = buildCopilotArgs({
    ...BASE,
    trustLevel: "acceptEdits",
    prompt: "multi\nline",
    model: "gpt-5.6-luna",
    effort: "medium",
    turnToken: "tok",
  });
  for (const [i, arg] of args.entries()) {
    if (i === args.indexOf("-p") + 1) continue;
    assert.ok(!/[\r\n]/.test(arg), `newline in non-prompt argument: ${JSON.stringify(arg)}`);
  }
});

test("the mcp config carries the bridge identity the server checks", () => {
  const args = buildCopilotArgs({ ...BASE, trustLevel: "acceptEdits", turnToken: "tok-123" });
  const config = JSON.parse(args[args.indexOf("--additional-mcp-config") + 1]);
  const solace = config.mcpServers.solace;
  // Without these the bridge has no identity and the server refuses every tool call, which
  // presents as an agent that simply never talks to the group rather than as an error.
  assert.equal(solace.env.SOLACE_AGENT_ID, "agent-1");
  assert.equal(solace.env.SOLACE_SERVER_PORT, "4310");
  assert.equal(solace.env.SOLACE_TURN_TOKEN, "tok-123");
  // No turn token must mean the key is absent, not present-and-empty: an empty string would be
  // sent as a real credential and rejected, instead of the server seeing none at all.
  const without = JSON.parse(solaceMcpConfig("agent-1", 4310));
  assert.ok(!("SOLACE_TURN_TOKEN" in without.mcpServers.solace.env));
});

test("the mcp bridge is wired at every trust level, including plan", () => {
  // Talking to your teammates mid-turn is not a privileged operation - gating it on trust
  // level would mean most agents silently never reached the group at all.
  for (const level of ["plan", "acceptEdits", "bypassPermissions"] as TrustLevel[]) {
    const args = buildCopilotArgs({ ...BASE, trustLevel: level });
    const config = JSON.parse(args[args.indexOf("--additional-mcp-config") + 1]);
    assert.ok(config.mcpServers.solace, `solace bridge missing at trust level ${level}`);
  }
});

test("model and effort are only passed when actually chosen", () => {
  const bare = buildCopilotArgs({ ...BASE, trustLevel: "plan" });
  assert.ok(!bare.includes("--model"));
  assert.ok(!bare.includes("--effort"));
  const full = buildCopilotArgs({ ...BASE, trustLevel: "plan", model: "gpt-5.6-luna", effort: "high" });
  assert.equal(full[full.indexOf("--model") + 1], "gpt-5.6-luna");
  assert.equal(full[full.indexOf("--effort") + 1], "high");
});

test("a not-signed-in run is recognised from Copilot's own words", () => {
  // Copilot writes this to stderr and exits 1 WITHOUT emitting any JSON at all - not even the
  // terminal `result` event - because its auth check runs before the JSONL pump is attached.
  // stderr is therefore the only evidence there is, so this matcher is what stands between the
  // user seeing "run `copilot login`" and seeing a blank failure.
  assert.ok(
    isNotSignedInError(
      "Error: No authentication information found.\n\nCopilot can be authenticated with GitHub using an OAuth Token",
    ),
  );
  assert.ok(isNotSignedInError("Error: Authentication token found but could not be validated."));
  assert.ok(!isNotSignedInError("Error: Model \"zzz\" from --model flag is not available."));
  assert.ok(!isNotSignedInError(""));
});

test("the model catalog parser invents nothing and reads ids only from its input", () => {
  // Real response shape from models.getBuiltInCatalog on the installed 1.0.83 runtime.
  const parsed = parseCopilotBuiltInCatalog({
    models: [{ id: "claude-sonnet-5" }, { id: "gpt-5.6-luna" }, { id: "gemini-3.8-flash" }, { id: "claude-sonnet-5" }],
  });
  assert.deepEqual(parsed.map((m) => m.id), ["claude-sonnet-5", "gpt-5.6-luna", "gemini-3.8-flash"]);
  // Grouped by the vendor/version prefix the ids themselves carry, not by a hand-kept table.
  assert.equal(parsed[0].family, "claude");
  assert.equal(parsed[1].family, "gpt-5.6");
  assert.equal(parsed[2].family, "gemini-3.8");
  // No display names exist in the response, so the id is the label rather than a prettified
  // guess at what the provider calls it.
  assert.equal(parsed[0].label, "claude-sonnet-5");
  // Anything that isn't the documented shape yields nothing rather than a fabricated entry.
  assert.deepEqual(parseCopilotBuiltInCatalog({}), []);
  assert.deepEqual(parseCopilotBuiltInCatalog(null), []);
  assert.deepEqual(parseCopilotBuiltInCatalog({ models: [{ notAnId: "x" }] }), []);
});
