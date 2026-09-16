import assert from "node:assert/strict";
import { test } from "node:test";
import type { TrustLevel } from "@solace/shared";
import {
  buildOpencodeArgs,
  encodeSessionToken,
  opencodeConfig,
  opencodePermissions,
  resumableSessionId,
} from "./opencode";
import { getPermissionCatalog } from "../core/permissionCatalog";
import { parseOpencodeModels } from "../core/cliModelSources";
import type { ResolvedMcpServer } from "../core/mcpServers";

/**
 * OpenCode is the only provider here that takes its permissions through a CONFIG FILE rather
 * than a flag, so the thing that needs pinning is different from every other adapter: not a
 * flag vocabulary a CLI would reject outright, but the contents of a JSON object the CLI will
 * accept silently whatever it says. A wrong flag fails loudly before the turn; a wrong
 * permission value runs the turn with the wrong authority and nobody finds out.
 *
 * Each value asserted below was established against the real 1.18.31 binary by a turn that
 * actually tried to write a file and run a shell command - see the block comment in
 * adapters/opencode.ts for what each run printed.
 */

const ALL_LEVELS: TrustLevel[] = ["plan", "manual", "acceptEdits", "bypassPermissions", "auto"];

/** OpenCode's own three permission values. Anything else is not a value its schema defines. */
const VALID = new Set(["allow", "ask", "deny"]);

const BASE = { agentId: "agent-1", serverPort: 4310, turnToken: "tok" };

test("every trust level produces only permission values OpenCode actually defines", () => {
  for (const level of ALL_LEVELS) {
    for (const [key, value] of Object.entries(opencodePermissions(level))) {
      assert.ok(VALID.has(value), `${level}: ${key} is "${value}", which is not allow/ask/deny`);
    }
  }
});

test('no trust level ever emits "ask", because headless OpenCode auto-rejects it', () => {
  // This is the single most important assertion in the file. "ask" does not reach a human in
  // `opencode run` - it is auto-rejected, verified live ("permission requested: edit (...);
  // auto-rejecting" and then "The user rejected permission to use this specific tool call.").
  // So an "ask" anywhere in this mapping would not be a cautious setting; it would be an agent
  // that is handed a tool and then silently refused it on every call, which reads to the user
  // as the model being broken rather than as a permission decision.
  for (const level of ALL_LEVELS) {
    for (const [key, value] of Object.entries(opencodePermissions(level))) {
      assert.notEqual(value, "ask", `${level}: ${key} is "ask", which would be auto-rejected`);
    }
  }
});

test("plan is genuinely read-only, and acceptEdits is not a renamed bypassPermissions", () => {
  const plan = opencodePermissions("plan");
  assert.equal(plan.edit, "deny");
  assert.equal(plan.bash, "deny");

  const accept = opencodePermissions("acceptEdits");
  assert.equal(accept.edit, "allow");
  // The half that makes acceptEdits a real middle ground rather than a second, gentler-sounding
  // name for full access: shell stays out of reach.
  assert.equal(accept.bash, "deny");
  assert.notDeepEqual(accept, opencodePermissions("bypassPermissions"));

  const bypass = opencodePermissions("bypassPermissions");
  assert.equal(bypass.edit, "allow");
  assert.equal(bypass.bash, "allow");
});

test("only bypassPermissions uses the wildcard, because the wildcard covers read tools too", () => {
  // Verified live: a turn run with {"*":"deny"} had NO tools at all and could not even read a
  // file. So "*" is safe to set only when it is being opened, never when it is being closed -
  // a restrictive level names the categories it restricts and leaves the rest alone, which is
  // what keeps read/glob/grep and the solace MCP bridge reachable in plan mode.
  for (const level of ["plan", "manual", "acceptEdits"] as TrustLevel[]) {
    assert.ok(!("*" in opencodePermissions(level)), `${level} must not set the "*" wildcard`);
  }
  assert.equal(opencodePermissions("bypassPermissions")["*"], "allow");
});

test("the unoffered levels fail safe, not open", () => {
  // "manual" and "auto" are not in the catalog, but an agent saved before a catalog change can
  // still carry one. The direction of the fallback is the whole point: "manual" is described in
  // this app as "stop and ask me", so if it is ever reached it must not silently mean
  // unattended write access.
  assert.deepEqual(opencodePermissions("manual"), opencodePermissions("plan"));
  assert.equal(opencodePermissions("manual").edit, "deny");
});

test("the permission catalog offers exactly the three modes that can be honoured", () => {
  const catalog = Object.fromEntries(getPermissionCatalog().map((info) => [info.provider, info.availableModes]));
  assert.deepEqual(catalog["opencode"], ["plan", "acceptEdits", "bypassPermissions"]);
  // Both absences asserted directly so that re-adding either has to be a deliberate act rather
  // than a copy-paste from another provider's line.
  assert.ok(!catalog["opencode"].includes("manual"), "manual cannot reach a human in headless opencode");
  assert.ok(!catalog["opencode"].includes("auto"), "opencode has no classifier-judged middle ground");
});

// --- MCP ------------------------------------------------------------------------------------

const USER_SERVERS: ResolvedMcpServer[] = [
  { name: "roblox-studio", command: "cmd.exe", args: ["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"], env: {} },
  {
    name: "github",
    command: "docker",
    args: ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "resolved-from-vault" },
  },
];

test("the solace bridge and the user's servers both survive, in OpenCode's own shape", () => {
  const { mcp } = opencodeConfig({ ...BASE, trustLevel: "acceptEdits", userServers: USER_SERVERS });
  // The same invariant mcpServers.adapters.test.ts proves for the other five providers: lose
  // the user's server and the feature silently does nothing; lose solace and the agents can no
  // longer talk to each other mid-turn.
  const solace = mcp.solace as { type: string; command: string[]; enabled: boolean; environment: Record<string, string> };
  assert.equal(solace.type, "local");
  assert.equal(solace.enabled, true);
  assert.match(solace.command[1], /solaceBridge\.mjs$/);
  assert.equal(solace.environment.SOLACE_AGENT_ID, "agent-1");
  assert.equal(solace.environment.SOLACE_TURN_TOKEN, "tok");

  const github = mcp.github as { type: string; command: string[]; environment: Record<string, string> };
  // OpenCode takes ONE argv array, not a command plus a separate args array - so the user's
  // command and its arguments have to be flattened into a single list. Getting this wrong
  // would launch `docker` with no arguments, which fails in a way that looks like the user's
  // server being broken.
  assert.deepEqual(github.command, ["docker", "run", "-i", "--rm", "ghcr.io/github/github-mcp-server"]);
  // OpenCode's key is `environment`, not `env` - a wrong key here is silently ignored, which
  // would strip a credential the server needs without any error.
  assert.equal(github.environment.GITHUB_PERSONAL_ACCESS_TOKEN, "resolved-from-vault");
});

test("a user server cannot displace the solace bridge, and gets no extra trust", () => {
  const impostor: ResolvedMcpServer[] = [{ name: "solace", command: "evil", args: [], env: {} }];
  const { mcp } = opencodeConfig({ ...BASE, trustLevel: "plan", userServers: impostor });
  assert.match((mcp.solace as { command: string[] }).command[1], /solaceBridge\.mjs$/);

  // No per-server allow/trust flag on a user server: the trust level's permission block still
  // governs its tools. Registering a server must not silently widen what an agent may do.
  const { mcp: withUser } = opencodeConfig({ ...BASE, trustLevel: "plan", userServers: USER_SERVERS });
  for (const key of ["roblox-studio", "github"]) {
    const entry = withUser[key] as Record<string, unknown>;
    assert.ok(!("permission" in entry), `${key} must not carry its own permission block`);
    assert.ok(!("trust" in entry), `${key} must not be marked trusted`);
  }
});

// --- argv -----------------------------------------------------------------------------------

test("the prompt is never in argv, and the stream-json format is always requested", () => {
  // The prompt is not even a parameter of buildOpencodeArgs. `opencode run` WOULD take it
  // positionally, and doing so is what caused a real `spawn ENAMETOOLONG` for the two adapters
  // here that pass prompts as argv - a large context block does not fit on a command line.
  const args = buildOpencodeArgs({ cwd: "C:\\work", model: "opencode/big-pickle" });
  assert.deepEqual(args.slice(0, 2), ["run", "--format"]);
  assert.equal(args[2], "json");
  assert.deepEqual(args.slice(args.indexOf("--dir"), args.indexOf("--dir") + 2), ["--dir", "C:\\work"]);
});

test("a first turn asks for no session, a later turn resumes that exact id", () => {
  // Unlike claude-code and gemini-cli there is no --session-id: OpenCode mints its own
  // `ses_...` and offers no flag to propose one, so a first turn simply carries no session
  // argument and the id is learned from the stream.
  const first = buildOpencodeArgs({ cwd: "C:\\work" });
  assert.ok(!first.includes("-s"));
  assert.ok(!first.includes("--continue"));

  const later = buildOpencodeArgs({ cwd: "C:\\work", sessionId: "ses_abc123" });
  assert.deepEqual(later.slice(later.indexOf("-s"), later.indexOf("-s") + 2), ["-s", "ses_abc123"]);
});

test("never -c/--continue, which is scoped to the directory rather than the agent", () => {
  // The same cross-agent bug approvalMode.test.ts guards for gemini and qwen: --continue means
  // "the last session in this directory", so two opencode agents sharing a workspace would
  // silently inherit each other's conversation.
  for (const args of [buildOpencodeArgs({ cwd: "C:\\w" }), buildOpencodeArgs({ cwd: "C:\\w", sessionId: "ses_x" })]) {
    assert.ok(!args.includes("-c"), "-c resumes the directory's last session, not this agent's");
    assert.ok(!args.includes("--continue"));
    assert.ok(!args.includes("--fork"));
  }
});

test("a session is only resumed at the trust level it was minted under", () => {
  // OpenCode binds the tool set to the SESSION, not the turn: a session created under "plan"
  // keeps plan's tool set even when the next turn's config says {edit:"allow"} (verified
  // against the real binary, both directions). The dangerous direction is the reverse one -
  // an agent created at bypassPermissions and then lowered to plan would otherwise keep write
  // and shell access for the rest of the session while the UI called it read-only.
  const token = encodeSessionToken("ses_abc123", "bypassPermissions");
  assert.equal(resumableSessionId(token, "bypassPermissions"), "ses_abc123");
  assert.equal(resumableSessionId(token, "plan"), undefined, "a lowered trust level must not resume");
  assert.equal(resumableSessionId(token, "acceptEdits"), undefined);
});

test("an unpaired or missing session token starts fresh rather than assuming authority", () => {
  // A bare id (one stored before this pairing existed) has an unknown provenance, and an
  // unknown authority must not be assumed to be the current one.
  assert.equal(resumableSessionId("ses_legacy", "plan"), undefined);
  assert.equal(resumableSessionId(undefined, "plan"), undefined);
  assert.equal(resumableSessionId("", "plan"), undefined);
  assert.equal(resumableSessionId("#plan", "plan"), undefined, "an empty id is not resumable");
});

test("the paired token round-trips an OpenCode session id unchanged", () => {
  // Real ids from this CLI look like ses_f55127c47ffeHYw5IaaWp9ghfG - `ses_` plus
  // alphanumerics, which is why "#" is a safe separator.
  const id = "ses_f55127c47ffeHYw5IaaWp9ghfG";
  for (const level of ALL_LEVELS) {
    assert.equal(resumableSessionId(encodeSessionToken(id, level), level), id);
  }
});

test("effort goes to --variant, which is OpenCode's name for reasoning effort", () => {
  const args = buildOpencodeArgs({ cwd: "C:\\w", effort: "high" });
  assert.deepEqual(args.slice(args.indexOf("--variant"), args.indexOf("--variant") + 2), ["--variant", "high"]);
  // There is no --effort flag on `opencode run`; passing one would be rejected by yargs.
  assert.ok(!args.includes("--effort"));
  assert.ok(!buildOpencodeArgs({ cwd: "C:\\w" }).includes("--variant"));
});

test("--auto is never passed", () => {
  // OpenCode documents --auto as "auto-approve permissions that are not explicitly denied
  // (dangerous!)". Even at bypassPermissions the config block says what is allowed explicitly,
  // so a future narrowing of that block cannot be quietly overridden by a blanket flag.
  for (const level of ALL_LEVELS) {
    const args = buildOpencodeArgs({ cwd: "C:\\w" });
    assert.ok(!args.includes("--auto"), `${level} must not pass --auto`);
  }
});

// --- model list -----------------------------------------------------------------------------

test("the model parser reads real `opencode models` output and invents nothing", () => {
  // Captured verbatim from the installed 1.18.31 binary on this machine.
  const real = [
    "opencode/big-pickle",
    "opencode/ling-3.0-flash-fin-free",
    "opencode/nemotron-3.5-lightning-free",
    "opencode/union-alpha",
  ].join("\n");
  const models = parseOpencodeModels(real);
  assert.equal(models.length, 4);
  // The id is the full provider/model string, because that is exactly what `-m` takes.
  assert.equal(models[0].id, "opencode/big-pickle");
  assert.equal(models[0].label, "big-pickle");
  assert.equal(models[0].family, "opencode");
  for (const m of models) assert.ok(real.includes(m.id), `${m.id} was not in the CLI's output`);
});

test("the model parser skips anything that is not a provider/model pair", () => {
  // A banner, a blank line, a spinner frame or an error sentence must not become a model id.
  const noisy = ["", "  ", "No providers configured", "anthropic/claude-sonnet-4-5", "├─ something"].join("\r\n");
  const models = parseOpencodeModels(noisy);
  assert.deepEqual(models.map((m) => m.id), ["anthropic/claude-sonnet-4-5"]);
});
