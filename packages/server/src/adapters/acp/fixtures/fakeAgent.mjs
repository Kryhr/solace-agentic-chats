/**
 * A scriptable stand-in for an ACP agent, used by connection.test.ts.
 *
 * It exists so the transport can be exercised against a REAL child process over REAL pipes -
 * partial reads, split lines, process death mid-request - rather than against an in-memory
 * stream that would not reproduce any of them. It is not a Kimi simulator and deliberately
 * knows nothing about session semantics; the recorded Kimi frames in kimi-acp-session.jsonl are
 * what pins the real shapes.
 *
 * Behaviour is chosen by the method name of whatever it is sent:
 *
 *   echo              -> responds with the params it received
 *   size              -> responds with the character length of params.text (proves a large
 *                        prompt survived the pipe intact rather than merely being accepted)
 *   split             -> responds in MANY tiny stdout writes, splitting the JSON mid-token
 *   burst             -> emits three notifications and a response in ONE write
 *   ask               -> sends US a request and reports what we answered
 *   noise             -> writes a non-JSON line, then a normal response
 *   boom              -> exits immediately without responding
 *   fail              -> responds with a JSON-RPC error
 *   noNewline         -> writes its response with NO trailing newline, then ends the stream
 */
import { stdin, stdout } from "node:process";

let buffer = "";
let nextId = 1000;
const pendingOurs = new Map();

const write = (obj) => stdout.write(`${JSON.stringify(obj)}\n`);

stdin.setEncoding("utf-8");
stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

function handle(message) {
  // A response to something WE asked.
  if (message.method === undefined && message.id !== undefined) {
    const entry = pendingOurs.get(message.id);
    if (entry) {
      pendingOurs.delete(message.id);
      entry(message);
    }
    return;
  }

  const { id, method, params } = message;
  switch (method) {
    case "echo":
      write({ jsonrpc: "2.0", id, result: params });
      return;
    case "size":
      write({ jsonrpc: "2.0", id, result: { length: String(params?.text ?? "").length } });
      return;
    case "split": {
      const payload = `${JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true, marker: "split-response" } })}\n`;
      // One character at a time: every possible split point, including inside a string literal
      // and between the two characters of an escape sequence.
      for (const ch of payload) stdout.write(ch);
      return;
    }
    case "burst": {
      const parts = [
        JSON.stringify({ jsonrpc: "2.0", method: "note", params: { n: 1 } }),
        JSON.stringify({ jsonrpc: "2.0", method: "note", params: { n: 2 } }),
        JSON.stringify({ jsonrpc: "2.0", method: "note", params: { n: 3 } }),
        JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } }),
      ];
      stdout.write(`${parts.join("\n")}\n`);
      return;
    }
    case "ask": {
      const ourId = nextId++;
      pendingOurs.set(ourId, (response) => {
        write({ jsonrpc: "2.0", id, result: { answered: response.result ?? null, failed: response.error ?? null } });
      });
      write({ jsonrpc: "2.0", id: ourId, method: params?.ask ?? "client/question", params: { q: "?" } });
      return;
    }
    case "noise":
      stdout.write("this line is not JSON at all\n");
      write({ jsonrpc: "2.0", id, result: { ok: true } });
      return;
    case "boom":
      process.exit(7);
      return;
    case "fail":
      write({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required: 403 quota" } });
      return;
    case "noNewline":
      // Writes its last response WITHOUT a trailing newline and then exits, which is what a
      // real agent that dies straight after answering looks like. The response only becomes a
      // message when the transport flushes on stream end, so this pins that behaviour.
      stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { ok: "no-trailing-newline" } }), () => process.exit(0));
      return;
    default:
      write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}
