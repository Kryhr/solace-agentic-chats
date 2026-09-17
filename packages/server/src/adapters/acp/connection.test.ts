import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { AcpConnection, AcpRpcError, AcpTransportError, NdJsonFramer } from "./connection";
import type { JsonRpcMessage } from "./protocol";


const FAKE_AGENT = join(__dirname, "fixtures", "fakeAgent.mjs");
const RECORDED = join(__dirname, "fixtures", "kimi-acp-session.jsonl");

function connect() {
  const notifications: { method: string; params: unknown }[] = [];
  const malformed: string[] = [];
  const connection = new AcpConnection({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: __dirname,
    onNotification: (method, params) => notifications.push({ method, params }),
    onMalformedLine: (line) => malformed.push(line),
  });
  return { connection, notifications, malformed };
}

/* -------------------------------------------------------------------------- */
/* Framing                                                                     */
/* -------------------------------------------------------------------------- */

test("the framer reassembles a message split across arbitrary chunk boundaries", () => {
  const seen: JsonRpcMessage[] = [];
  const framer = new NdJsonFramer((m) => seen.push(m));
  const payload = `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: 'a "quoted" \\ value', n: 42 } })}\n`;
  // Every single-character boundary, including inside the string literal and between the two
  // characters of an escape sequence - the cases that break a naive split-on-newline parser.
  for (const ch of payload) framer.push(ch);
  assert.equal(seen.length, 1);
  assert.deepEqual((seen[0].result as { text: string }).text, 'a "quoted" \\ value');
});

test("the framer emits several messages that arrived in one chunk, in order", () => {
  const seen: JsonRpcMessage[] = [];
  const framer = new NdJsonFramer((m) => seen.push(m));
  framer.push(
    [
      JSON.stringify({ jsonrpc: "2.0", method: "a" }),
      JSON.stringify({ jsonrpc: "2.0", method: "b" }),
      JSON.stringify({ jsonrpc: "2.0", method: "c" }),
    ].join("\n") + "\n",
  );
  assert.deepEqual(seen.map((m) => m.method), ["a", "b", "c"]);
});

test("the framer tolerates CRLF line endings", () => {
  const seen: JsonRpcMessage[] = [];
  const framer = new NdJsonFramer((m) => seen.push(m));
  framer.push(`${JSON.stringify({ jsonrpc: "2.0", method: "x" })}\r\n`);
  assert.deepEqual(seen.map((m) => m.method), ["x"]);
});

test("a final line with no trailing newline is only delivered on flush, and is not lost", () => {
  const seen: JsonRpcMessage[] = [];
  const framer = new NdJsonFramer((m) => seen.push(m));
  framer.push(JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} }));
  assert.equal(seen.length, 0, "an unterminated line is not a message yet");
  framer.flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, 9);
});

test("a non-JSON line is reported rather than thrown on, and does not derail the lines after it", () => {
  const seen: JsonRpcMessage[] = [];
  const bad: string[] = [];
  const framer = new NdJsonFramer((m) => seen.push(m), (l) => bad.push(l));
  framer.push(`KIMI_RAN_SHELL\n${JSON.stringify({ jsonrpc: "2.0", method: "after" })}\n`);
  assert.deepEqual(bad, ["KIMI_RAN_SHELL"]);
  assert.deepEqual(seen.map((m) => m.method), ["after"]);
});

/* -------------------------------------------------------------------------- */
/* Framing against the REAL recorded frames                                    */
/* -------------------------------------------------------------------------- */

test("every recorded frame from a live `kimi acp` session parses, byte-for-byte, through the framer", () => {
  // These are the actual bytes a real kimi acp 0.43.1 process wrote on 2026-09-16, not a
  // hand-written approximation. Fed through in 7-byte chunks so the recorded content is split
  // at boundaries that never line up with the message boundaries.
  const raw = readFileSync(RECORDED, "utf-8");
  const seen: JsonRpcMessage[] = [];
  const bad: string[] = [];
  const framer = new NdJsonFramer((m) => seen.push(m), (l) => bad.push(l));
  for (let i = 0; i < raw.length; i += 7) framer.push(raw.slice(i, i + 7));
  framer.flush();

  assert.deepEqual(bad, [], "no recorded line should fail to parse");
  const lines = raw.split("\n").filter((l) => l.trim()).length;
  assert.equal(seen.length, lines);

  // And the frames really are the ones this adapter depends on, so the fixture cannot rot into
  // a file of unrelated JSON without a test noticing.
  const updates = seen.filter((m) => m.method === "session/update");
  const kinds = new Set(updates.map((m) => ((m.params as { update: { sessionUpdate: string } }).update.sessionUpdate)));
  assert.ok(kinds.has("agent_message_chunk"), "recorded agent_message_chunk");
  assert.ok(kinds.has("usage_update"), "recorded usage_update");
  assert.ok(seen.some((m) => m.error?.code === -32000), "recorded the -32000 quota refusal");
});

/* -------------------------------------------------------------------------- */
/* Request / response correlation                                              */
/* -------------------------------------------------------------------------- */

test("responses are correlated by id even when they arrive out of order", async () => {
  const { connection } = connect();
  try {
    // "split" responds one character at a time and so finishes last despite being sent first.
    const slow = connection.request<{ marker: string }>("split", {});
    const fast = connection.request<{ v: number }>("echo", { v: 1 });
    assert.deepEqual(await fast, { v: 1 });
    assert.equal((await slow).marker, "split-response");
  } finally {
    connection.close();
  }
});

test("a JSON-RPC error response rejects with AcpRpcError carrying the machine-readable code", async () => {
  const { connection } = connect();
  try {
    await assert.rejects(
      () => connection.request("fail", {}),
      (err: unknown) => {
        assert.ok(err instanceof AcpRpcError);
        assert.equal(err.code, -32000);
        assert.match(err.message, /quota/);
        return true;
      },
    );
  } finally {
    connection.close();
  }
});

test("notifications and a response batched into one write are all delivered", async () => {
  const { connection, notifications } = connect();
  try {
    await connection.request("burst", {});
    assert.deepEqual(notifications.map((n) => (n.params as { n: number }).n), [1, 2, 3]);
  } finally {
    connection.close();
  }
});

test("a non-JSON line on stdout is surfaced separately and the request still completes", async () => {
  const { connection, malformed } = connect();
  try {
    await connection.request("noise", {});
    assert.deepEqual(malformed, ["this line is not JSON at all"]);
  } finally {
    connection.close();
  }
});

test("a response written with no trailing newline before the stream ends is still delivered", async () => {
  const { connection } = connect();
  try {
    assert.deepEqual(await connection.request("noNewline", {}), { ok: "no-trailing-newline" });
  } finally {
    connection.close();
  }
});

/* -------------------------------------------------------------------------- */
/* The prompt-size claim                                                       */
/* -------------------------------------------------------------------------- */

test("a prompt far beyond the Windows command-line ceiling crosses the transport intact", async () => {
  // The old `kimi -p` adapter had to REFUSE a prompt over ~32,764 characters, because the
  // prompt was an argv element and CreateProcess rejects a longer command line. Over JSON-RPC
  // there is no such limit. 200,000 characters is deliberately far past it.
  const { connection } = connect();
  try {
    const text = "é".repeat(200_000);
    const result = await connection.request<{ length: number }>("size", { text });
    // Length, not just acceptance: this fails if the pipe truncated or re-encoded the payload.
    assert.equal(result.length, 200_000);
  } finally {
    connection.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Inbound requests - the half that makes an approval gate possible            */
/* -------------------------------------------------------------------------- */

test("a request the agent makes of us is answered with our handler's result", async () => {
  const seen: string[] = [];
  const connection = new AcpConnection({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: __dirname,
    onRequest: async (method) => {
      seen.push(method);
      return { outcome: { outcome: "selected", optionId: "approve_once" } };
    },
  });
  try {
    const result = await connection.request<{ answered: { outcome: { optionId: string } } }>("ask", {
      ask: "session/request_permission",
    });
    assert.deepEqual(seen, ["session/request_permission"]);
    assert.equal(result.answered.outcome.optionId, "approve_once");
  } finally {
    connection.close();
  }
});

test("a handler that throws still answers, so the agent's turn cannot deadlock", async () => {
  const connection = new AcpConnection({
    command: process.execPath,
    args: [FAKE_AGENT],
    cwd: __dirname,
    onRequest: async () => {
      throw new Error("handler exploded");
    },
  });
  try {
    const result = await connection.request<{ failed: { code: number; message: string } }>("ask", {});
    assert.equal(result.failed.code, -32603);
    assert.match(result.failed.message, /handler exploded/);
  } finally {
    connection.close();
  }
});

test("with no handler at all, an inbound request is refused rather than left hanging", async () => {
  const connection = new AcpConnection({ command: process.execPath, args: [FAKE_AGENT], cwd: __dirname });
  try {
    const result = await connection.request<{ failed: { code: number } }>("ask", {});
    assert.equal(result.failed.code, -32601);
  } finally {
    connection.close();
  }
});

/* -------------------------------------------------------------------------- */
/* Process death                                                               */
/* -------------------------------------------------------------------------- */

test("an in-flight request rejects with AcpTransportError when the agent dies mid-turn", async () => {
  const { connection } = connect();
  try {
    await assert.rejects(
      () => connection.request("boom", {}),
      (err: unknown) => {
        assert.ok(err instanceof AcpTransportError, "a dead process is a transport failure, not a protocol error");
        assert.match(err.message, /exited with code 7/);
        return true;
      },
    );
  } finally {
    connection.close();
  }
});

test("every pending request rejects when the agent dies, not just the one that killed it", async () => {
  const { connection } = connect();
  try {
    const a = connection.request("split", {});
    const b = connection.request("echo", { v: 2 });
    const dead = connection.request("boom", {});
    const results = await Promise.allSettled([a, b, dead]);
    // `b` may legitimately have been answered before the exit landed; what must never happen is
    // a promise that is still pending after the process is gone.
    for (const r of results) assert.notEqual(r.status, undefined);
    assert.equal(results[2].status, "rejected");
  } finally {
    connection.close();
  }
});

test("a request issued after the agent is gone fails fast instead of hanging forever", async () => {
  const { connection } = connect();
  await assert.rejects(() => connection.request("boom", {}));
  await assert.rejects(
    () => connection.request("echo", {}),
    (err: unknown) => err instanceof AcpTransportError,
  );
  connection.close();
});

test("failing to spawn the agent at all rejects rather than hanging", async () => {
  const connection = new AcpConnection({
    command: join(__dirname, "definitely-not-an-executable-xyz"),
    args: [],
    cwd: __dirname,
  });
  await assert.rejects(
    () => connection.request("echo", {}),
    (err: unknown) => err instanceof AcpTransportError,
  );
  connection.close();
});

test("close() is safe to call twice", () => {
  const { connection } = connect();
  connection.close();
  connection.close();
});
