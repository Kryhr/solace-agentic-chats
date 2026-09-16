import assert from "node:assert/strict";
import { test } from "node:test";
import type { TrustLevel } from "@solace/shared";
import {
  KILO_PERMISSION_VALUES,
  buildKiloArgs,
  encodeSessionToken,
  isNotSignedInError,
  kiloConfig,
  kiloErrorMessage,
  kiloPermissions,
  resumableSessionId,
} from "./kilo";

const ALL_LEVELS: TrustLevel[] = ["plan", "manual", "acceptEdits", "bypassPermissions", "auto"];

const BASE = { cwd: "C:\\work\\proj" };
const CONFIG_BASE = { agentId: "agent-1", serverPort: 4310 };

test("every trust level emits only permission values kilo actually accepts", () => {
  // This is the single most important test in the file, and it exists because of a verified
  // failure mode rather than as boilerplate: Kilo SILENTLY DROPS an invalid permission value.
  // `{"permission":{"edit":"bogus"}}` makes the entire permission block vanish from the
  // resolved config - no error, no warning, exit 0 - leaving the agent at Kilo's permissive
  // defaults while this app still believes it is restricted. A typo here would not fail loudly;
  // it would quietly grant authority.
  const valid = new Set<string>(KILO_PERMISSION_VALUES);
  for (const level of ALL_LEVELS) {
    for (const [category, value] of Object.entries(kiloPermissions(level))) {
      assert.ok(valid.has(value), `${level} sets ${category}="${value}", which kilo would drop`);
    }
  }
});

test("the permission vocabulary is exactly what the binary validates", () => {
  assert.deepEqual([...KILO_PERMISSION_VALUES], ["allow", "ask", "deny"]);
});

test("plan mode can neither write nor run a shell command", () => {
  const p = kiloPermissions("plan");
  assert.equal(p.edit, "deny");
  assert.equal(p.bash, "deny");
});

test("plan and acceptEdits never set the wildcard", () => {
  // A "*" of "deny" would strip even the read-only tools (verified for OpenCode, the same
  // engine), leaving an agent that cannot so much as read a file - and a "*" of "allow" would
  // silently re-grant what the named categories just denied. The restrictive levels name only
  // the categories they restrict and leave everything else at Kilo's own default.
  for (const level of ["plan", "acceptEdits", "manual"] as TrustLevel[]) {
    assert.equal(kiloPermissions(level)["*"], undefined, `${level} set a wildcard`);
  }
});

test("acceptEdits is a real middle ground, not a renamed bypassPermissions", () => {
  const p = kiloPermissions("acceptEdits");
  assert.equal(p.edit, "allow");
  assert.equal(p.bash, "deny");
});

test("only bypassPermissions allows shell", () => {
  for (const level of ALL_LEVELS) {
    const allowsBash = kiloPermissions(level).bash === "allow";
    const expected = level === "bypassPermissions" || level === "auto";
    assert.equal(allowsBash, expected, `${level} bash=${kiloPermissions(level).bash}`);
  }
});

test("manual collapses onto the safe end, never onto the permissive one", () => {
  // "manual" is not offered for this provider (see KILO-REGISTRATION.md) because a headless
  // "ask" never reaches a human. An agent saved under it before a catalog change must still
  // run - and must run with the LEAST authority. The inverse bug would be a mode labelled
  // "stop and ask me" silently granting unattended write and shell access.
  assert.deepEqual(kiloPermissions("manual"), kiloPermissions("plan"));
});

test("no trust level ever emits \"ask\", which would be auto-rejected rather than asked", () => {
  // Inherited from opencode.ts's behavioural finding on the same engine: headless `run`
  // auto-rejects an "ask" permission and prints "auto-rejecting" rather than queuing it for a
  // person. Emitting "ask" would therefore produce an agent that is asked to work and then
  // silently refused every tool - strictly worse than denying the tool outright, because the
  // model burns a turn discovering it.
  for (const level of ALL_LEVELS) {
    for (const [category, value] of Object.entries(kiloPermissions(level))) {
      assert.notEqual(value, "ask", `${level} sets ${category}="ask"`);
    }
  }
});

test("the prompt is never passed as an argument", () => {
  // `kilo run` takes [message..] positionally, and a large context block passed that way is
  // what caused a real spawn ENAMETOOLONG outage for the argv-based adapters in this repo.
  // Verified live that kilo reads stdin instead: a piped prompt minted a session and reached
  // the model call with no prompt in argv at all.
  const args = buildKiloArgs({ ...BASE, model: "kilo/~anthropic/claude-sonnet-latest" });
  assert.ok(args.join(" ").length < 300, "argv should stay small regardless of prompt size");
  assert.ok(!args.includes("run") || args[0] === "run");
});

test("uses the structured json format, not a prose instruction to the model", () => {
  const args = buildKiloArgs(BASE);
  const at = args.indexOf("--format");
  assert.notEqual(at, -1);
  assert.equal(args[at + 1], "json");
});

test("dir is passed explicitly, not left to the spawn cwd alone", () => {
  const args = buildKiloArgs(BASE);
  const at = args.indexOf("--dir");
  assert.notEqual(at, -1);
  assert.equal(args[at + 1], BASE.cwd);
});

test("a first turn requests no session; a later turn resumes with -s", () => {
  assert.ok(!buildKiloArgs(BASE).includes("-s"));

  const resumed = buildKiloArgs({ ...BASE, sessionId: "ses_f54e81818ffeG52RGsQtmif4uj" });
  assert.equal(resumed[resumed.indexOf("-s") + 1], "ses_f54e81818ffeG52RGsQtmif4uj");
});

test("never uses --continue or --fork", () => {
  const args = buildKiloArgs({ ...BASE, sessionId: "ses_abc" });
  // --continue means "the last session for this directory", so two kilo agents sharing a
  // workspace would resume each other's conversation. --fork would branch a new session off
  // the old one every turn, so an agent would split its own history instead of continuing it.
  assert.ok(!args.includes("-c"));
  assert.ok(!args.includes("--continue"));
  assert.ok(!args.includes("--fork"));
});

test("effort is passed as --variant, kilo's own name for it", () => {
  const args = buildKiloArgs({ ...BASE, effort: "high" });
  assert.equal(args[args.indexOf("--variant") + 1], "high");
  assert.ok(!args.includes("--effort"));
});

test("model and effort are omitted entirely when the caller did not ask", () => {
  const bare = buildKiloArgs(BASE);
  assert.ok(!bare.includes("-m"));
  assert.ok(!bare.includes("--variant"));
});

test("the solace bridge is registered in kilo's confirmed mcp shape", () => {
  // Shape confirmed against the real binary: with exactly this structure `kilo mcp list` listed
  // the server and actually tried to spawn it. Keys are OpenCode's own - `type: "local"`,
  // `command` as a single argv ARRAY (not a command string plus args), `environment` not `env`.
  const { mcp } = kiloConfig({ ...CONFIG_BASE, trustLevel: "plan" });
  const solace = mcp.solace as Record<string, unknown>;
  assert.equal(solace.type, "local");
  assert.ok(Array.isArray(solace.command), "command must be a single argv array");
  assert.equal(solace.enabled, true);
  assert.ok(solace.environment, "env must be spelled `environment`");
  assert.equal((solace.environment as Record<string, string>).SOLACE_AGENT_ID, "agent-1");
});

test("a user server cannot displace the solace bridge by reusing its name", () => {
  const { mcp } = kiloConfig({
    ...CONFIG_BASE,
    trustLevel: "plan",
    userServers: [{ name: "solace", command: "evil", args: [], env: {} } as never],
  });
  const solace = mcp.solace as Record<string, unknown>;
  assert.ok(!JSON.stringify(solace.command).includes("evil"), "user server displaced the bridge");
});

test("a user server is registered without being pre-allowed", () => {
  const { mcp, permission } = kiloConfig({
    ...CONFIG_BASE,
    trustLevel: "plan",
    userServers: [{ name: "mine", command: "node", args: ["x.js"], env: { A: "1" } } as never],
  });
  const mine = mcp.mine as Record<string, unknown>;
  assert.deepEqual(mine.command, ["node", "x.js"]);
  // Registering a server must not widen what the agent may do: the trust level's permission
  // block still governs its tools, so plan mode stays denied.
  assert.equal(permission.edit, "deny");
});

test("a session is not resumed under a trust level it was not minted under", () => {
  // The dangerous direction: if Kilo binds an agent's tool set at session creation (as OpenCode
  // verifiably does - same engine), an agent created at bypassPermissions and lowered to plan
  // would keep write and shell access while the UI said read-only. Starting fresh costs the
  // conversation memory; resuming would cost the user's revoked authority.
  const token = encodeSessionToken("ses_abc", "bypassPermissions");
  assert.equal(resumableSessionId(token, "bypassPermissions"), "ses_abc");
  assert.equal(resumableSessionId(token, "plan"), undefined);
});

test("a token with no recorded trust level is never resumed", () => {
  // An unknown authority must not be assumed to be the current one.
  assert.equal(resumableSessionId("ses_abc", "plan"), undefined);
  assert.equal(resumableSessionId(undefined, "plan"), undefined);
  assert.equal(resumableSessionId("", "plan"), undefined);
});

test("the unauthenticated failure is recognised from kilo's real message", () => {
  // Verbatim from a real unauthenticated run of the installed 7.7.2 binary.
  assert.ok(isNotSignedInError("You need to sign in to use this model."));
  assert.ok(!isNotSignedInError("the file could not be written"));
});

test("an error event is unwrapped to its sentence, not its HTTP headers", () => {
  // The real captured event's `data` block carried the full HTTP response headers - a
  // Content-Security-Policy several kilobytes long. That must not reach a chat bubble.
  const real = {
    name: "APIError",
    data: {
      message: "You need to sign in to use this model.",
      statusCode: 401,
      responseHeaders: { "content-security-policy-report-only": "default-src 'self'; ".repeat(200) },
    },
  };
  const msg = kiloErrorMessage(real);
  assert.equal(msg, "You need to sign in to use this model.");
  assert.ok(!msg.includes("content-security-policy"));
});

test("an error with no message falls back to its name rather than going blank", () => {
  assert.equal(kiloErrorMessage({ name: "APIError" }), "APIError");
  assert.equal(kiloErrorMessage({}), "kilo reported an error with no message");
  assert.equal(kiloErrorMessage(undefined), "kilo reported an error with no message");
});
