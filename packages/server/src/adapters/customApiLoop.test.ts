import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { looksLikeToolRejection, runCustomApiTurn } from "./custom-api";
import type { AdapterEvent, RunTurnOptions } from "./types";
import type { ToolExecutor, ToolResult } from "../core/agentTools";

/**
 * Covers the agentic loop in adapters/custom-api.ts with a fake endpoint, so every branch that
 * depends on what a server sends back - streamed tool calls, a non-streaming server, a server
 * that rejects `tools` outright, an abort mid-turn - is exercised without needing one of each
 * kind of local runtime installed. The real-Ollama check is a separate, manual end-to-end run.
 */

// ---- fake SSE plumbing -----------------------------------------------------------------------

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n`).join("") + "data: [DONE]\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function textDelta(text: string) {
  return { choices: [{ delta: { content: text } }] };
}

/** One tool call split across two fragments, the way a real server streams arguments. */
function toolCallDeltas(id: string, name: string, args: string, index = 0) {
  const half = Math.ceil(args.length / 2);
  return [
    { choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args.slice(0, half) } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(half) } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
}

interface Recorded {
  body: any;
}

function harness(responses: (() => Response)[]) {
  const requests: Recorded[] = [];
  const events: AdapterEvent[] = [];
  const executed: { name: string; args: string }[] = [];
  let call = 0;

  const fetchImpl = (async (_url: string, init: any) => {
    requests.push({ body: JSON.parse(init.body) });
    const make = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return make();
  }) as unknown as typeof fetch;

  const executor: ToolExecutor = {
    async execute(name: string, args: string): Promise<ToolResult> {
      executed.push({ name, args });
      return { content: `result of ${name}`, isError: false, exitCode: name === "run_shell_command" ? 0 : undefined };
    },
  };

  const base: RunTurnOptions & { fetchImpl: typeof fetch; executor: ToolExecutor } = {
    cwd: process.cwd(),
    prompt: "do the thing",
    trustLevel: "auto",
    agentId: "agent-1",
    agentHandle: "local",
    model: "test-model",
    baseUrl: "http://127.0.0.1:9/v1",
    turnToken: "tok",
    onEvent: (event) => events.push(event),
    fetchImpl,
    executor,
  };

  return { requests, events, executed, base };
}

const textOf = (events: AdapterEvent[]) =>
  events.filter((e): e is Extract<AdapterEvent, { type: "text" }> => e.type === "text").map((e) => e.text).join("");
const toolEvents = (events: AdapterEvent[]) =>
  events.filter((e): e is Extract<AdapterEvent, { type: "tool-use" }> => e.type === "tool-use");
const types = (events: AdapterEvent[]) => events.map((e) => e.type);

// ---- the loop --------------------------------------------------------------------------------

describe("custom-api tool loop", () => {
  test("a plain answer with no tool calls is one request and streams its text", async () => {
    const h = harness([() => sse([textDelta("hello "), textDelta("world")])]);
    await runCustomApiTurn(h.base);
    assert.equal(h.requests.length, 1);
    assert.equal(textOf(h.events), "hello world");
    assert.equal(h.executed.length, 0);
    assert.ok(types(h.events).includes("done"));
  });

  test("tools are offered on every request", async () => {
    const h = harness([() => sse([textDelta("hi")])]);
    await runCustomApiTurn(h.base);
    const tools = h.requests[0].body.tools;
    assert.ok(Array.isArray(tools) && tools.length >= 6);
    assert.equal(h.requests[0].body.tool_choice, "auto");
    const names = tools.map((t: any) => t.function.name);
    for (const expected of ["read_file", "write_file", "edit_file", "list_directory", "search_file_content", "run_shell_command"]) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
  });

  test("a streamed tool call is executed and its result fed back, then the loop ends", async () => {
    let round = 0;
    const h = harness([
      () => {
        round += 1;
        return round === 1
          ? sse(toolCallDeltas("call_a", "read_file", JSON.stringify({ path: "x.txt" })))
          : sse([textDelta("the file says hi")]);
      },
    ]);
    await runCustomApiTurn(h.base);

    assert.equal(h.requests.length, 2, "one request to get the tool call, one to get the answer");
    assert.deepEqual(h.executed, [{ name: "read_file", args: JSON.stringify({ path: "x.txt" }) }]);

    // The second request must carry the assistant's tool_calls AND a matching role:"tool" reply.
    const second = h.requests[1].body.messages;
    const assistant = second[second.length - 2];
    const toolMsg = second[second.length - 1];
    assert.equal(assistant.role, "assistant");
    assert.equal(assistant.tool_calls[0].id, "call_a");
    assert.equal(assistant.tool_calls[0].function.name, "read_file");
    assert.equal(toolMsg.role, "tool");
    assert.equal(toolMsg.tool_call_id, "call_a");
    assert.equal(toolMsg.content, "result of read_file");

    assert.equal(textOf(h.events), "the file says hi");
  });

  test("the tool-use event carries the real tool name and parsed arguments", async () => {
    let round = 0;
    const h = harness([
      () => {
        round += 1;
        return round === 1
          ? sse(toolCallDeltas("c1", "write_file", JSON.stringify({ path: "a.txt", content: "z" })))
          : sse([textDelta("done")]);
      },
    ]);
    await runCustomApiTurn(h.base);
    const tools = toolEvents(h.events);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].toolName, "write_file");
    assert.deepEqual(tools[0].input, { path: "a.txt", content: "z" });
  });

  test("a shell command emits a second event carrying the real output and exit code", async () => {
    let round = 0;
    const h = harness([
      () => {
        round += 1;
        return round === 1
          ? sse(toolCallDeltas("c1", "run_shell_command", JSON.stringify({ command: "git status" })))
          : sse([textDelta("clean")]);
      },
    ]);
    await runCustomApiTurn(h.base);
    const tools = toolEvents(h.events);
    assert.equal(tools.length, 2);
    assert.equal(tools[1].toolName, "run_shell_command");
    const input = tools[1].input as any;
    assert.equal(input.command, "git status");
    assert.equal(input.exit_code, 0);
    assert.equal(input.aggregated_output, "result of run_shell_command");
  });

  test("several tool calls in one response all run, in order", async () => {
    let round = 0;
    const h = harness([
      () => {
        round += 1;
        if (round > 1) return sse([textDelta("all read")]);
        return sse([
          ...toolCallDeltas("c1", "read_file", JSON.stringify({ path: "a" }), 0).slice(0, 2),
          ...toolCallDeltas("c2", "read_file", JSON.stringify({ path: "b" }), 1),
        ]);
      },
    ]);
    await runCustomApiTurn(h.base);
    assert.equal(h.executed.length, 2);
    assert.equal(JSON.parse(h.executed[0].args).path, "a");
    assert.equal(JSON.parse(h.executed[1].args).path, "b");
  });

  test("the loop is bounded and says so when it hits the bound", async () => {
    // A model that asks for a tool forever.
    const h = harness([() => sse(toolCallDeltas("c", "read_file", JSON.stringify({ path: "x" })))]);
    await runCustomApiTurn(h.base);
    assert.equal(h.requests.length, 16, "MAX_TOOL_ITERATIONS");
    const note = toolEvents(h.events).find((e) => e.description.startsWith("note: stopped after"));
    assert.ok(note, "hitting the bound must be reported, not hidden");
    assert.match(note!.description, /16 tool rounds/);
  });

  test("a non-streaming JSON response is handled (several local runtimes ignore stream:true)", async () => {
    const h = harness([
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "plain json answer" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ]);
    await runCustomApiTurn(h.base);
    assert.equal(textOf(h.events), "plain json answer");
    const usage = h.events.find((e) => e.type === "usage") as any;
    assert.deepEqual(usage.usage, { inputTokens: 11, outputTokens: 7 });
  });

  test("a non-streaming response can carry tool calls too", async () => {
    let round = 0;
    const h = harness([
      () => {
        round += 1;
        if (round > 1) return sse([textDelta("ok")]);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  // Deliberately an OBJECT, not the spec's JSON string: some local servers do this.
                  tool_calls: [{ id: "n1", type: "function", function: { name: "list_directory", arguments: { path: "." } } }],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    ]);
    await runCustomApiTurn(h.base);
    assert.deepEqual(h.executed, [{ name: "list_directory", args: JSON.stringify({ path: "." }) }]);
  });

  test("usage is summed across rounds, not overwritten by the last one", async () => {
    let round = 0;
    const h = harness([
      () => {
        round += 1;
        return round === 1
          ? sse([
              ...toolCallDeltas("c", "read_file", JSON.stringify({ path: "x" })),
              { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
            ])
          : sse([textDelta("answer"), { choices: [], usage: { prompt_tokens: 200, completion_tokens: 20 } }]);
      },
    ]);
    await runCustomApiTurn(h.base);
    const usage = h.events.find((e) => e.type === "usage") as any;
    assert.deepEqual(usage.usage, { inputTokens: 300, outputTokens: 30 });
  });

  test("no usage event at all when the endpoint never reported one", async () => {
    const h = harness([() => sse([textDelta("hi")])]);
    await runCustomApiTurn(h.base);
    assert.ok(!types(h.events).includes("usage"), "a fabricated zero-token turn is worse than none");
  });

  test("reasoning_content is emitted as reasoning, not as the agent's answer", async () => {
    const h = harness([() => sse([{ choices: [{ delta: { reasoning_content: "thinking…" } }] }, textDelta("answer")])]);
    await runCustomApiTurn(h.base);
    assert.equal(textOf(h.events), "answer");
    const reasoning = h.events.find((e) => e.type === "reasoning") as any;
    assert.equal(reasoning.text, "thinking…");
  });

  test('a content delta containing the literal "[DONE]" is not dropped', async () => {
    const h = harness([() => sse([textDelta("the sentinel is data: [DONE] in SSE")])]);
    await runCustomApiTurn(h.base);
    assert.match(textOf(h.events), /\[DONE\]/);
  });
});

// ---- the no-tool-support path ------------------------------------------------------------------

describe("endpoints that cannot do tool calling", () => {
  test("Ollama's real refusal is detected, reported, and retried without tools", async () => {
    let round = 0;
    const h = harness([
      () => {
        round += 1;
        if (round === 1) {
          return new Response(JSON.stringify({ error: "registry.ollama.ai/library/llama2 does not support tools" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return sse([textDelta("I can only chat.")]);
      },
    ]);
    await runCustomApiTurn(h.base);

    assert.equal(h.requests.length, 2);
    assert.ok(h.requests[0].body.tools, "the first attempt offers tools");
    assert.equal(h.requests[1].body.tools, undefined, "the retry must not");

    const note = toolEvents(h.events).find((e) => e.description.startsWith("note:"));
    assert.ok(note, "the downgrade must be visible, never silent");
    assert.match(note!.description, /rejected the tool definitions/);
    assert.match(note!.description, /cannot read, write or run anything/);
    assert.equal(textOf(h.events), "I can only chat.");
    // Reported as a note, not an "error" - the turn did produce a real answer.
    assert.ok(!types(h.events).includes("error"));
  });

  test("a tool rejection never silently retries twice", async () => {
    const h = harness([
      () => new Response(JSON.stringify({ error: "tools are not supported" }), { status: 400, headers: { "content-type": "application/json" } }),
    ]);
    await runCustomApiTurn(h.base);
    // First request with tools, retry without, and the retry's own 400 surfaces as a real error.
    assert.equal(h.requests.length, 2);
    assert.ok(types(h.events).includes("error"));
  });

  test("an unrelated 4xx is reported as the error it is, not as missing tool support", async () => {
    const h = harness([() => new Response("invalid api key", { status: 401, headers: { "content-type": "text/plain" } })]);
    await runCustomApiTurn(h.base);
    assert.equal(h.requests.length, 1, "no tool-less retry for an auth failure");
    const error = h.events.find((e) => e.type === "error") as any;
    assert.match(error.message, /401/);
  });

  test("looksLikeToolRejection is narrow", () => {
    assert.ok(looksLikeToolRejection(400, "model does not support tools"));
    assert.ok(looksLikeToolRejection(400, `{"error":"llama2:7b does not support tools"}`));
    assert.ok(looksLikeToolRejection(422, "tools are not supported by this model"));
    assert.ok(looksLikeToolRejection(400, "unknown parameter: tools"));
    assert.ok(looksLikeToolRejection(400, "Unsupported parameter tool_choice"));

    // Must NOT fire for anything else, or a capable endpoint gets silently downgraded.
    assert.equal(looksLikeToolRejection(401, "invalid api key"), false);
    assert.equal(looksLikeToolRejection(404, "model not found"), false);
    assert.equal(looksLikeToolRejection(429, "rate limit exceeded"), false);
    assert.equal(looksLikeToolRejection(500, "does not support tools"), false, "5xx is a server fault, not a capability");
    assert.equal(looksLikeToolRejection(400, "your prompt mentioned tools"), false);
  });
});

// ---- configuration and cancellation -------------------------------------------------------------

describe("custom-api turn preconditions", () => {
  test("no base URL is an actionable error and makes no request", async () => {
    const h = harness([() => sse([textDelta("x")])]);
    await runCustomApiTurn({ ...h.base, baseUrl: undefined });
    assert.equal(h.requests.length, 0);
    const error = h.events.find((e) => e.type === "error") as any;
    assert.match(error.message, /no base URL/);
  });

  test("no model is an actionable error and makes no request", async () => {
    const h = harness([() => sse([textDelta("x")])]);
    await runCustomApiTurn({ ...h.base, model: undefined });
    assert.equal(h.requests.length, 0);
    const error = h.events.find((e) => e.type === "error") as any;
    assert.match(error.message, /set a model id/);
  });

  test("an unreachable endpoint is reported with the endpoint in the message", async () => {
    const h = harness([]);
    await runCustomApiTurn({
      ...h.base,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const error = h.events.find((e) => e.type === "error") as any;
    assert.match(error.message, /failed to reach .*chat\/completions/);
  });

  test("an abort emits cancelled, never a fake error", async () => {
    const controller = new AbortController();
    const h = harness([]);
    await runCustomApiTurn({
      ...h.base,
      signal: controller.signal,
      fetchImpl: (async () => {
        controller.abort();
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }) as unknown as typeof fetch,
    });
    assert.ok(types(h.events).includes("cancelled"));
    assert.ok(!types(h.events).includes("error"), "an abort is something we did, not a failure");
  });

  test("an abort between tool rounds stops the loop as cancelled", async () => {
    const controller = new AbortController();
    const h = harness([
      () => {
        controller.abort();
        return sse(toolCallDeltas("c", "read_file", JSON.stringify({ path: "x" })));
      },
    ]);
    await runCustomApiTurn({ ...h.base, signal: controller.signal });
    assert.ok(types(h.events).includes("cancelled"));
    assert.equal(h.executed.length, 0, "no tool runs after the turn was cancelled");
  });

  test("the system prompt states the working directory and the permission mode", async () => {
    const h = harness([() => sse([textDelta("hi")])]);
    await runCustomApiTurn({ ...h.base, trustLevel: "plan", cwd: "C:/tmp/agent-cwd" });
    const system = h.requests[0].body.messages[0];
    assert.equal(system.role, "system");
    assert.match(system.content, /C:\/tmp\/agent-cwd/);
    assert.match(system.content, /PLAN mode/);
  });
});
