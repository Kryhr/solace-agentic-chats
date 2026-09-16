import assert from "node:assert/strict";
import { test } from "node:test";
import type { TrustLevel } from "@solace/shared";
import {
  CONTINUE_SHELL_TOOL,
  CONTINUE_WRITE_TOOLS,
  buildContinueArgs,
  buildContinueConfig,
  continueMcpServersYaml,
  continuePermissionFlags,
  findForkedSessionId,
  parseContinueTranscript,
  stageUserServers,
  transcriptLength,
} from "./continue";

/**
 * The authoritative flag vocabulary, taken from `cn --help` on the installed 1.5.47 build. A
 * flag outside this set is a hard commander rejection before the turn starts, which at least
 * fails loudly - but an option that silently does nothing (see the --model test below) does not,
 * so the set is pinned here rather than trusted.
 */
const KNOWN_FLAGS = new Set([
  "--config",
  "--org",
  "--readonly",
  "--auto",
  "--verbose",
  "--rule",
  "--mcp",
  "--model",
  "--prompt",
  "--allow",
  "--ask",
  "--exclude",
  "--agent",
  "-p",
  "--print",
  "--format",
  "--silent",
  "--resume",
  "--fork",
]);

const OFFERED_LEVELS: TrustLevel[] = ["plan", "acceptEdits", "bypassPermissions"];

test("every emitted flag is one Continue actually defines", () => {
  for (const level of ["plan", "manual", "acceptEdits", "bypassPermissions", "auto"] as TrustLevel[]) {
    const args = buildContinueArgs({ trustLevel: level, configPath: "C:\\tmp\\config.yaml", sessionId: "sid" });
    for (const arg of args) {
      if (!arg.startsWith("-")) continue;
      assert.ok(KNOWN_FLAGS.has(arg), `${level} passes unknown flag "${arg}"`);
    }
  }
});

test("the prompt never reaches argv", () => {
  // The whole point of buildContinueArgs not taking a prompt. Codex and Copilot took theirs on
  // argv here and that produced a real spawn ENAMETOOLONG outage; Continue reads stdin, so this
  // pins that nothing ever starts passing it positionally.
  const args = buildContinueArgs({ trustLevel: "bypassPermissions" });
  assert.ok(!args.includes("--prompt"));
  // Every element is a flag or a value we supplied - none is free text.
  assert.deepEqual(args, ["--auto", "-p"]);
});

test("-p is the last argument", () => {
  // Not cosmetic: `cn -p --format json` fails with "A prompt is required when using the
  // -p/--print flag" while `cn --format json -p` reads stdin fine. Putting -p before another
  // option breaks Continue's own stdin detection, so its position is a correctness property.
  for (const level of OFFERED_LEVELS) {
    const args = buildContinueArgs({ trustLevel: level, sessionId: "sid", configPath: "C:\\c.yaml" });
    assert.equal(args[args.length - 1], "-p", `${level} did not end with -p`);
  }
});

test("--format json is never used", () => {
  // It is not a machine-readable protocol: it appends a system instruction telling the MODEL to
  // reply in JSON and wraps the result. Using it would corrupt the answer text and still yield no
  // tool calls, usage or session id.
  const args = buildContinueArgs({ trustLevel: "plan", sessionId: "s", configPath: "C:\\c.yaml" });
  assert.ok(!args.includes("--format"));
  assert.ok(!args.includes("json"));
});

test("--model is never passed, because it cannot select a configured model", () => {
  // Verified live: with two models ("alpha", "beta") in config.yaml pointing at two different
  // local endpoints, `cn --model beta` still hit alpha's endpoint - the first chat-role model
  // always wins. `--model` only ADDS a model from the hub, and an unresolvable slug is silently
  // ignored rather than rejected. Passing it would look like model selection and do nothing.
  for (const level of OFFERED_LEVELS) {
    assert.ok(!buildContinueArgs({ trustLevel: level }).includes("--model"));
  }
});

test("plan mode is read-only and never grants a write or the shell", () => {
  const flags = continuePermissionFlags("plan");
  assert.deepEqual(flags, ["--readonly"]);
  assert.ok(!flags.includes("--auto"));
  assert.ok(!flags.includes("--allow"));
});

test("acceptEdits allows edits but removes the shell entirely", () => {
  // Verified behaviourally: the Write landed on disk with no approval, and `Bash` was absent from
  // the CLI's own "Tools prepared" list, so the model cannot see the shell at all.
  const flags = continuePermissionFlags("acceptEdits");
  for (const tool of CONTINUE_WRITE_TOOLS) {
    const at = flags.indexOf(tool);
    assert.ok(at > 0 && flags[at - 1] === "--allow", `${tool} is not preceded by --allow`);
  }
  const excludeAt = flags.indexOf(CONTINUE_SHELL_TOOL);
  assert.ok(excludeAt > 0 && flags[excludeAt - 1] === "--exclude");
  assert.ok(!flags.includes("--auto"), "acceptEdits must not grant full auto");
});

test("only bypassPermissions reaches --auto", () => {
  assert.deepEqual(continuePermissionFlags("bypassPermissions"), ["--auto"]);
  for (const level of ["plan", "acceptEdits", "manual", "auto"] as TrustLevel[]) {
    assert.ok(!continuePermissionFlags(level).includes("--auto"), `${level} reached --auto`);
  }
});

test("a trust level Continue cannot express falls back to read-only, never to auto", () => {
  // "manual" and "auto" are not offered in the catalog. If one arrives anyway (a hand-edited
  // state file), the failure must be restrictive: granting MORE than was asked for is the one
  // outcome that is never acceptable.
  for (const level of ["manual", "auto"] as TrustLevel[]) {
    assert.deepEqual(continuePermissionFlags(level), ["--readonly"]);
  }
});

test("a first turn forks nothing and a resumed turn forks the prior session", () => {
  assert.ok(!buildContinueArgs({ trustLevel: "plan" }).includes("--fork"));
  const resumed = buildContinueArgs({ trustLevel: "plan", sessionId: "abc-123" });
  assert.deepEqual(resumed.slice(0, 2), ["--fork", "abc-123"]);
  // --resume is deliberately not used: it resumes whatever the LAST session was, so two Continue
  // agents running in the same workspace would resume each other's conversation.
  assert.ok(!resumed.includes("--resume"));
});

test("--config is passed only when a config was staged", () => {
  assert.ok(!buildContinueArgs({ trustLevel: "plan" }).includes("--config"));
  const withConfig = buildContinueArgs({ trustLevel: "plan", configPath: "C:\\tmp\\x\\config.yaml" });
  assert.deepEqual(withConfig.slice(0, 2), ["--config", "C:\\tmp\\x\\config.yaml"]);
});

/* -------------------------------------------------------------------------- */
/* Config staging                                                              */
/* -------------------------------------------------------------------------- */

const USER_CONFIG = "name: Mine\nversion: 1.0.0\nschema: v1\nmodels:\n  - name: m\n    provider: ollama\n    model: llama3\n";

test("the user's config text is preserved byte-for-byte ahead of our block", () => {
  const merged = buildContinueConfig(USER_CONFIG, continueMcpServersYaml("agent-1", 4310));
  assert.ok(merged);
  assert.ok(merged.startsWith(USER_CONFIG), "the user's own config was altered");
  assert.ok(merged.includes("mcpServers:"));
});

test("a config with no trailing newline still produces a well-formed document", () => {
  const merged = buildContinueConfig("models:\n  - name: m", continueMcpServersYaml("a", 4310));
  assert.ok(merged);
  assert.ok(merged.includes("\nmcpServers:"), "our block ran onto the user's last line");
});

test("we refuse to append when the user already declares mcpServers", () => {
  // Appending would create a duplicate top-level key, which YAML either rejects or resolves in an
  // order we do not control. Losing the bridge is survivable; corrupting the config an agent
  // needs to reach a model at all is not.
  const withServers = `${USER_CONFIG}mcpServers:\n  - name: theirs\n    command: node\n`;
  assert.equal(buildContinueConfig(withServers, continueMcpServersYaml("a", 4310)), undefined);
});

test("no config, empty config or whitespace-only config stages nothing", () => {
  for (const input of [undefined, "", "   \n\n"]) {
    assert.equal(buildContinueConfig(input, continueMcpServersYaml("a", 4310)), undefined);
  }
});

test("Windows paths and hostile names survive as valid YAML scalars", () => {
  // JSON is a subset of YAML, so JSON.stringify is both correct and injection-proof here - a
  // backslash-laden Windows path or a name containing a quote or a colon cannot break out of its
  // scalar and invent new keys.
  const yaml = continueMcpServersYaml("agent-1", 4310, "tok", [
    { name: 'we"ird: name', command: "C:\\Program Files\\node.exe", args: ["C:\\a b\\s.mjs"], env: { K: 'v"al' } },
  ]);
  assert.ok(yaml.includes('"C:\\\\Program Files\\\\node.exe"'));
  assert.ok(yaml.includes('"we\\"ird: name"'));
  // Exactly one top-level key, whatever the inputs contained.
  assert.equal(yaml.split("\n").filter((line) => /^\S/.test(line)).length, 1);
});

test("the solace bridge is always first and a user server cannot displace it", () => {
  const yaml = continueMcpServersYaml("agent-1", 4310, "tok", [
    { name: "solace", command: "evil", args: [], env: {} },
    { name: "other", command: "node", args: ["x.mjs"], env: {} },
  ]);
  const names = [...yaml.matchAll(/^ {2}- name: "(.+)"$/gm)].map((m) => m[1]);
  assert.deepEqual(names, ["solace", "other"], "a server named solace displaced the bridge");
  assert.ok(!yaml.includes("evil"));
});

test("plan mode registers the solace bridge but none of the user's own MCP servers", () => {
  // Continue's permission modes do not gate MCP tools at all: verified live, a Write was
  // cancelled under --readonly while an MCP tool call in the same mode executed and fed its
  // result back into a second model round-trip. Registering a third-party server for a
  // "read-only" agent would therefore hand it an ungated capability the UI says it does not have.
  assert.equal(stageUserServers("plan"), false);
  for (const level of ["acceptEdits", "bypassPermissions"] as TrustLevel[]) {
    assert.equal(stageUserServers(level), true);
  }
  const userServers = [{ name: "third-party", command: "node", args: ["x.mjs"], env: {} }];
  const planYaml = continueMcpServersYaml("a", 4310, "tok", userServers, stageUserServers("plan"));
  assert.ok(!planYaml.includes("third-party"), "a user server was registered for a read-only agent");
  // The bridge itself is still there - teammate chat is bookkeeping, not a machine capability.
  assert.ok(planYaml.includes('"solace"'));
  const openYaml = continueMcpServersYaml("a", 4310, "tok", userServers, stageUserServers("acceptEdits"));
  assert.ok(openYaml.includes("third-party"));
});

test("the turn token is passed to the bridge only when there is one", () => {
  assert.ok(continueMcpServersYaml("a", 4310, "tok-1").includes("SOLACE_TURN_TOKEN"));
  assert.ok(!continueMcpServersYaml("a", 4310).includes("SOLACE_TURN_TOKEN"));
});

/* -------------------------------------------------------------------------- */
/* Transcript parsing                                                          */
/* -------------------------------------------------------------------------- */

// A real Continue session transcript, trimmed but otherwise verbatim from a run captured against
// the installed 1.5.47 build on 2026-09-16.
const REAL_SESSION = {
  sessionId: "11111111-1111-1111-1111-111111111111",
  title: "Untitled Session",
  workspaceDirectory: "C:\\work",
  history: [
    { message: { role: "user", content: "Read note.txt" }, contextItems: [] },
    {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: '{"filepath":"note.txt"}' } }],
        usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62, model: "mock-model", cost_cents: 0 },
      },
      toolCallStates: [
        {
          toolCallId: "call_1",
          toolCall: { id: "call_1", type: "function", function: { name: "Read", arguments: '{"filepath":"note.txt"}' } },
          status: "done",
          parsedArgs: { filepath: "note.txt" },
          output: [{ content: "Content of note.txt:\nhello\n", name: "Tool Result" }],
        },
      ],
    },
    {
      message: {
        role: "assistant",
        content: "The file says hello.",
        usage: { prompt_tokens: 200, completion_tokens: 9, total_tokens: 209, model: "mock-model", cost_cents: 0 },
      },
    },
  ],
  usage: { totalCost: 0.000292, promptTokens: 250, completionTokens: 21 },
};

test("a real transcript yields the tool call, the resolved model and summed token usage", () => {
  const { events, usage, model } = parseContinueTranscript(REAL_SESSION);
  assert.equal(model, "mock-model");
  const tools = events.filter((e) => e.type === "tool-use");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type === "tool-use" && tools[0].toolName, "Read");
  // Unflattened structured input, so core/toolLabel.ts can label it from the real values.
  assert.deepEqual(tools[0].type === "tool-use" ? tools[0].input : undefined, { filepath: "note.txt" });
  // Summed across the turn's assistant messages, NOT taken from session.usage - that field is
  // cumulative over the whole session including any forked parent, so it over-reports every turn
  // after the first.
  assert.deepEqual(usage, { inputTokens: 250, outputTokens: 21 });
});

test("cost is never reported", () => {
  // Continue's cost_cents / totalCost were 0 for a locally-configured model. Emitting 0 would
  // tell every non-hub user their turns were free.
  const { usage } = parseContinueTranscript(REAL_SESSION);
  assert.ok(usage && !("totalCostUsd" in usage && usage.totalCostUsd !== undefined));
});

test("a resumed turn does not replay the forked parent's tool calls", () => {
  // --fork seeds the new session with the parent's entire history, so without the offset an
  // agent's tenth turn would re-report every tool call from its first nine.
  const prior = transcriptLength(REAL_SESSION);
  assert.equal(prior, 3);
  const next = { ...REAL_SESSION, history: [...REAL_SESSION.history, { message: { role: "user", content: "again" } }] };
  const { events } = parseContinueTranscript(next, prior);
  assert.equal(events.length, 0, "the parent's tool calls were replayed");
});

test("a tool call the permission mode cancelled is reported, not silently dropped", () => {
  // This is the ONLY way a blocked write surfaces: Continue prints nothing at all on stdout and
  // still exits 0, so if the adapter dropped this the user would see an empty turn with no reason.
  const blocked = {
    history: [
      {
        message: { role: "assistant", content: "", usage: { prompt_tokens: 5, completion_tokens: 1 } },
        toolCallStates: [
          {
            toolCallId: "call_w",
            toolCall: { id: "call_w", type: "function", function: { name: "Write", arguments: "{}" } },
            status: "canceled",
            parsedArgs: { filepath: "x.txt" },
            output: [{ content: "Command blocked by security policy" }],
          },
        ],
      },
    ],
  };
  const { events } = parseContinueTranscript(blocked);
  assert.equal(events.length, 1);
  assert.ok(events[0].type === "tool-use" && events[0].description.includes("blocked by permission mode"));
});

test("a malformed or truncated transcript costs a tool line, not a thrown turn", () => {
  for (const input of [undefined, null, 42, "nonsense", {}, { history: "not an array" }, { history: [null, 7] }]) {
    const result = parseContinueTranscript(input);
    assert.deepEqual(result.events, []);
    assert.equal(result.usage, undefined);
  }
  assert.equal(transcriptLength(undefined), 0);
});

test("a transcript with no usage block reports no usage rather than zeroes", () => {
  const { usage } = parseContinueTranscript({ history: [{ message: { role: "assistant", content: "hi" } }] });
  assert.equal(usage, undefined);
});

/* -------------------------------------------------------------------------- */
/* Fork session discovery                                                      */
/* -------------------------------------------------------------------------- */

test("no new session file means no session id is invented", () => {
  assert.equal(findForkedSessionId(["a", "b"], ["a", "b"], "C:\\nope", "C:\\work"), undefined);
});

test("the new session is found even when the sessions directory is unreadable", () => {
  // readSessionFile returns undefined for a path that does not exist, so the workspace filter
  // matches nothing and the candidate pool is used as-is - continuity survives rather than being
  // dropped because bookkeeping was unavailable.
  assert.equal(findForkedSessionId(["a"], ["a", "new-1"], "C:\\does\\not\\exist", "C:\\work"), "new-1");
});
