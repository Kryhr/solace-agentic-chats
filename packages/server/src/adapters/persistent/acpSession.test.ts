import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { AcpConnection } from "../acp/connection";
import type { AdapterEvent, RunTurnOptions } from "../types";
import { ACP_PROVIDERS, createAcpTransport, refuseByDefault, type AcpProviderSpec } from "./acpSession";
import type { OpenSessionOptions } from "./types";

/**
 * ONE persistent-session implementation, driven as Kimi, as Gemini and as Qwen.
 *
 * Two kinds of test here, and they prove different things:
 *
 *   - against the SCRIPTED agent: that the session layer does the right thing with a prompt
 *     stream, a cancel, a permission request and a resume. The scripted agent is not evidence
 *     about any real CLI.
 *   - against the RECORDED frames: that the same code, given the EXACT bytes a real
 *     `gemini --acp` and `qwen --acp` sent on this machine on 2026-09-16, reads their
 *     capabilities correctly and reports their real refusal verbatim. Neither CLI is signed in,
 *     so `session/new` really is refused - and a transport that swallowed that, or dressed it up
 *     as something else, would be the exact failure this repo refuses.
 */

const FAKE = join(__dirname, "fixtures", "fakeAcpAgent.mjs");
const CAPTURES = join(__dirname, "..", "acp", "fixtures");

const scripted: AcpProviderSpec = {
  provider: "kimi",
  command: "scripted",
  args: [],
  disabledReason: "test fixture",
};

function transportFor(spec: AcpProviderSpec, env: NodeJS.ProcessEnv = {}, decide = refuseByDefault) {
  return createAcpTransport(spec, true, decide, (_spec, options, handlers) => {
    return new AcpConnection({
      // process.execPath and a .mjs entry, never an npm .cmd shim - see core/spawnCli.ts.
      command: process.execPath,
      args: [FAKE],
      cwd: options.cwd,
      env: { ...process.env, ...env },
      onNotification: handlers.onNotification,
      onRequest: handlers.onRequest,
    });
  });
}

const open = (spec = scripted, env: NodeJS.ProcessEnv = {}, overrides: Partial<OpenSessionOptions> = {}, decide = refuseByDefault) =>
  transportFor(spec, env, decide).open({
    cwd: __dirname,
    agentId: "agent-1",
    agentHandle: "tester",
    trustLevel: "acceptEdits",
    ...overrides,
  });

function turn(prompt: string, signal?: AbortSignal): { options: RunTurnOptions; events: AdapterEvent[] } {
  const events: AdapterEvent[] = [];
  return {
    events,
    options: {
      cwd: __dirname,
      prompt,
      trustLevel: "acceptEdits",
      agentId: "agent-1",
      agentHandle: "tester",
      onEvent: (e) => events.push(e),
      signal,
    },
  };
}

const textOf = (events: AdapterEvent[]) =>
  events.filter((e): e is Extract<AdapterEvent, { type: "text" }> => e.type === "text").map((e) => e.text);

/* -------------------------------------------------------------------------- */
/* The claim                                                                   */
/* -------------------------------------------------------------------------- */

test("a second prompt reaches the same ACP process on the same session", async () => {
  const session = await open();
  const pid = session.pid;
  assert.ok(pid);
  const first = turn("first");
  await session.send(first.options);
  const second = turn("second");
  await session.send(second.options);
  assert.equal(session.pid, pid);
  assert.match(textOf(first.events)[0], new RegExp(`^pid=${pid} heard: first$`));
  assert.match(textOf(second.events)[0], new RegExp(`^pid=${pid} heard: second$`));
  await session.close("agent-removed");
});

test("a turn ends on the prompt's stop reason, not on the process exiting", async () => {
  const session = await open();
  const t = turn("hello");
  await session.send(t.options);
  assert.ok(session.alive());
  assert.equal(t.events.at(-1)?.type, "done");
  await session.close("agent-removed");
});

/* -------------------------------------------------------------------------- */
/* Translating the update stream                                               */
/* -------------------------------------------------------------------------- */

test("a thought chunk is reasoning and a message chunk is text - never the same thing", async () => {
  const session = await open();
  const t = turn("hello");
  await session.send(t.options);
  assert.deepEqual(
    t.events.filter((e) => e.type === "reasoning").map((e) => (e as { text: string }).text),
    ["thinking about it"],
  );
  assert.equal(textOf(t.events).length, 1);
  await session.close("agent-removed");
});

test("usage_update is NOT reported as turn usage - it is context occupancy", async () => {
  // used/size is how full the context window is, not what the turn spent. Putting it in the
  // usage column would be a number in a place that means something else, which is the kind of
  // invented figure this repo exists to not produce.
  const session = await open();
  const t = turn("hello");
  await session.send(t.options);
  assert.equal(t.events.some((e) => e.type === "usage"), false);
  assert.ok(t.events.some((e) => e.type === "heartbeat"), "it is still a sign of life");
  await session.close("agent-removed");
});

test("a tool call is reported with the provider's own name and arguments", async () => {
  const session = await open();
  const t = turn("SLOW");
  const running = session.send(t.options);
  await waitFor(() => t.events.some((e) => e.type === "tool-use"));
  const tool = t.events.find((e) => e.type === "tool-use") as Extract<AdapterEvent, { type: "tool-use" }>;
  assert.equal(tool.toolName, "shell");
  assert.deepEqual(tool.input, { command: "sleep 600" });
  await session.interrupt();
  await running;
  await session.close("agent-removed");
});

/* -------------------------------------------------------------------------- */
/* Cancel, permission, failure                                                 */
/* -------------------------------------------------------------------------- */

test("a cancel stops the turn by protocol and the process survives it", async () => {
  const session = await open();
  const t = turn("SLOW");
  const running = session.send(t.options);
  await waitFor(() => t.events.some((e) => e.type === "tool-use"));
  const pid = session.pid;
  assert.equal(await session.interrupt(), true);
  await running;
  assert.ok(t.events.some((e) => e.type === "cancelled"));
  assert.ok(session.alive(), "cancel is a notification, not a kill");
  assert.equal(session.pid, pid);
  // And the session is immediately usable again, with its context intact - the whole point.
  const next = turn("after cancel");
  await session.send(next.options);
  assert.match(textOf(next.events)[0], /heard: after cancel/);
  await session.close("agent-removed");
});

test("aborting the turn's signal cancels by protocol", async () => {
  const session = await open();
  const controller = new AbortController();
  const t = turn("SLOW", controller.signal);
  const running = session.send(t.options);
  await waitFor(() => t.events.some((e) => e.type === "tool-use"));
  controller.abort();
  await running;
  assert.ok(t.events.some((e) => e.type === "cancelled"));
  assert.ok(session.alive());
  await session.close("agent-removed");
});

test("interrupt reports false when there is no turn to cancel", async () => {
  const session = await open();
  assert.equal(await session.interrupt(), false);
  await session.close("agent-removed");
});

test("a permission request is answered, and the default answer REFUSES", async () => {
  const session = await open();
  const t = turn("ASK");
  await session.send(t.options);
  // The agent reports back what we told it, so this checks the answer actually arrived rather
  // than merely that nothing threw. Fail closed: an unwired approval gate that allowed
  // everything would be a permission system that silently did nothing.
  assert.ok(textOf(t.events).includes("permission: selected no"));
  await session.close("agent-removed");
});

test("an injected decider can allow, and the agent sees the option it chose", async () => {
  const session = await open(scripted, {}, {}, async (params) => ({
    outcome: { outcome: "selected", optionId: params.options.find((o) => o.kind === "allow_once")!.optionId },
  }));
  const t = turn("ASK");
  await session.send(t.options);
  assert.ok(textOf(t.events).includes("permission: selected yes"));
  await session.close("agent-removed");
});

test("a provider error is reported in the provider's own words, and ends the turn cleanly", async () => {
  const session = await open();
  const t = turn("REFUSE");
  await session.send(t.options);
  const error = t.events.find((e) => e.type === "error") as Extract<AdapterEvent, { type: "error" }>;
  assert.equal(error.message, "Authentication required: 403 quota");
  assert.equal(t.events.at(-1)?.type, "done");
  assert.ok(session.alive(), "one refused prompt does not end the session");
  await session.close("agent-removed");
});

/* -------------------------------------------------------------------------- */
/* Resume                                                                      */
/* -------------------------------------------------------------------------- */

test("a stored session id is resumed when the agent says it can load sessions", async () => {
  const session = await open(scripted, {}, { sessionId: "previously-stored" });
  assert.equal(session.providerSessionId, "previously-stored");
  await session.close("agent-removed");
});

test("a stored id the agent no longer knows starts a new session instead of failing the turn", async () => {
  const session = await open(scripted, { SOLACE_ACP_RESUME_FAILS: "1" }, { sessionId: "gone" });
  assert.equal(session.providerSessionId, "scripted-session-1");
  const t = turn("hello");
  await session.send(t.options);
  assert.ok(textOf(t.events)[0].includes("heard: hello"));
  await session.close("agent-removed");
});

/* -------------------------------------------------------------------------- */
/* Against the REAL captured frames                                            */
/* -------------------------------------------------------------------------- */

for (const [provider, capture, refusal] of [
  ["gemini-cli", "gemini-session-new-unauthenticated.jsonl", "Gemini API key is missing or not configured."],
  ["qwen-code", "qwen-session-new-unauthenticated.jsonl", "Authentication required: Use Qwen Code CLI to authenticate first."],
] as const) {
  test(`${provider}: the same code handshakes with its real captured frames and reports its real refusal`, async () => {
    const spec = ACP_PROVIDERS.find((p) => p.provider === provider)!;
    await assert.rejects(
      () => open(spec, { SOLACE_ACP_REPLAY: join(CAPTURES, capture) }),
      (err: Error) => {
        // Verbatim. This is what the CLI actually says when it is not signed in, and it is the
        // only part of the failure a human can act on.
        assert.equal(err.message, refusal);
        return true;
      },
    );
  });
}

test("every ACP provider ships with its live transport switched OFF, with a reason", () => {
  // The handshake is captured and real for all three. A prompt reaching a model is not, for
  // three different account reasons. Until one has been driven end to end, the honest state is
  // off - and the reason is a sentence a human can read, not an absence.
  for (const spec of ACP_PROVIDERS) {
    const transport = createAcpTransport(spec);
    assert.equal(transport.enabled, false, `${spec.provider} must not be enabled`);
    assert.ok(transport.disabledReason && transport.disabledReason.length > 40, `${spec.provider} must say why`);
  }
});

test("the four providers differ only in the argv that starts them", () => {
  // One implementation, four agents. If this list ever grows a second field that differs, the
  // claim "provider-agnostic by design" has stopped being true and should stop being made.
  assert.deepEqual(
    ACP_PROVIDERS.map((p) => [p.provider, p.command, ...p.args]),
    [
      ["opencode", "opencode", "acp"],
      ["kimi", "kimi", "acp"],
      ["gemini-cli", "gemini", "--acp"],
      ["qwen-code", "qwen", "--acp"],
    ],
  );
});

test("the solace bridge is offered to the agent, in the shape the ACP schema actually wants", async () => {
  // Moving a provider onto the live transport must not cost it the ability to speak to the group
  // mid-turn, which is what the solace MCP bridge gives every spawn-per-turn adapter.
  //
  // The two shape details are the ones that fail SILENTLY when wrong: the stdio member of the
  // SDK's mcpServer union is UNTAGGED, so a `type:"stdio"` field makes an agent drop the server
  // with a log warning, and `env` is an ARRAY of {name,value}, so a plain object serialises fine
  // and the server starts with none of its variables set.
  const seen: { name: string; command: string; args: string[]; env: unknown }[] = [];
  const transport = createAcpTransport(scripted, true, refuseByDefault, (_spec, options, handlers) => {
    const connection = new AcpConnection({
      command: process.execPath,
      args: [FAKE],
      cwd: options.cwd,
      onNotification: handlers.onNotification,
      onRequest: handlers.onRequest,
    });
    const request = connection.request.bind(connection);
    connection.request = (async (method: string, params: unknown) => {
      if (method === "session/new") seen.push(...((params as { mcpServers: typeof seen }).mcpServers ?? []));
      return request(method, params);
    }) as typeof connection.request;
    return connection;
  });
  const session = await transport.open({ cwd: __dirname, agentId: "agent-1", agentHandle: "t", trustLevel: "acceptEdits", sessionToken: "tok" });
  const solace = seen.find((s) => s.name === "solace");
  assert.ok(solace, "the group-chat bridge must be offered to every ACP session");
  assert.equal(solace.command, process.execPath, "the server's own interpreter, not a bare 'node' off the agent's PATH");
  assert.match(solace.args[0], /solaceBridge\.mjs$/);
  assert.equal("type" in solace, false, "the stdio member is UNTAGGED - a type field makes agents drop it");
  assert.ok(Array.isArray(solace.env), "env is an array of {name,value}, not a Record");
  assert.deepEqual(
    (solace.env as { name: string; value: string }[]).find((e) => e.name === "SOLACE_TURN_TOKEN"),
    { name: "SOLACE_TURN_TOKEN", value: "tok" },
  );
  await session.close("agent-removed");
});

test("the configured model is applied through ACP's own config option", async () => {
  // There is no --model flag for an ACP agent: the model is a session setting the agent itself
  // advertises in session/new's configOptions. Both real agents observed so far do it this way.
  const session = await open(scripted, {}, { model: "scripted/model-b" });
  const t = turn("hello");
  await session.send(t.options);
  assert.deepEqual(
    t.events.filter((e) => e.type === "model").map((e) => (e as { model: string }).model),
    ["scripted/model-b"],
    "the model the session was actually switched to is reported",
  );
  await session.close("agent-removed");
});

test("a model the agent does not offer is skipped rather than sent blind", async () => {
  // An agent that accepted an unknown value and ignored it would leave the UI naming a model that
  // is not answering. The configured model staying unapplied is visible in what the agent
  // reports; a silently wrong one is not.
  const session = await open(scripted, {}, { model: "some/model-nobody-has" });
  const t = turn("hello");
  await session.send(t.options);
  assert.equal(t.events.some((e) => e.type === "model"), false, "nothing is claimed about the model");
  assert.ok(textOf(t.events)[0].includes("heard: hello"), "and the session still works");
  await session.close("agent-removed");
});

/* -------------------------------------------------------------------------- */

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

