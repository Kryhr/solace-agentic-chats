/**
 * A scriptable stand-in for `claude -p --input-format stream-json --output-format stream-json`.
 *
 * It exists so the persistent transport can be exercised against a REAL child process over REAL
 * pipes - stdin held open across turns, frames split across chunk boundaries, a process that
 * dies mid-turn - rather than against an in-memory stream that reproduces none of that. Every
 * frame it emits has the shape the real CLI emits; what it does NOT do is think, which is the
 * whole point: volume testing a transport must not cost a subscription.
 *
 * It is not a Claude simulator and must never be mistaken for evidence about the real CLI. The
 * real binary was driven separately, once - see PERSISTENT-SESSIONS.md - and that run is what
 * the claims about Claude Code rest on. This file is what the EDGE CASES rest on.
 *
 * The prompt text chooses the behaviour:
 *
 *   anything            -> one assistant text frame, then a result frame (a normal turn)
 *   "SLOW"              -> a tool_use frame, then nothing until interrupted or killed
 *   "THINK"             -> a thinking block, then text, then result
 *   "SPLIT"             -> the reply written one character at a time across many writes
 *   "NOISE"             -> a non-JSON line first, then a normal turn
 *   "DIE"               -> exits immediately, mid-turn, without a result frame
 *   "FORK"              -> answers under a DIFFERENT session_id, as a real resume-fork would
 */
import { stdin, stdout } from "node:process";

const SESSION_ID = process.env.FAKE_SESSION_ID ?? "fake-session";
const FORKED_ID = `${SESSION_ID}-forked`;

let buffer = "";
let sessionId = SESSION_ID;
let announced = false;
/** Set while a "SLOW" turn is pending, so an interrupt has something real to stop. */
let pendingSlowTurn = false;

const write = (obj) => stdout.write(`${JSON.stringify(obj)}\n`);

const assistant = (blocks) =>
  write({ type: "assistant", session_id: sessionId, message: { model: "fake-model-1", content: blocks } });

const result = (subtype = "success") =>
  write({
    type: "result",
    subtype,
    session_id: sessionId,
    total_cost_usd: 0.0001,
    modelUsage: { "fake-model-1": { inputTokens: 11, outputTokens: 7, cacheReadInputTokens: 3 } },
  });

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

// The real CLI's documented behaviour: "Closing the stream tells the CLI to finish the current
// turn and exit." Reproduced so close() can be tested for what it actually does.
stdin.on("end", () => {
  if (pendingSlowTurn) {
    pendingSlowTurn = false;
    result("interrupted");
  }
  process.exit(0);
});

function handle(message) {
  if (message.type === "control_request") {
    const subtype = message.request?.subtype;
    if (subtype === "interrupt") {
      write({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
      if (pendingSlowTurn) {
        pendingSlowTurn = false;
        // A real interrupt still produces the terminal frame for the turn it stopped - the turn
        // ended, it just did not end by finishing.
        result("interrupted");
      }
      return;
    }
    write({
      type: "control_response",
      response: { subtype: "error", request_id: message.request_id, error: `unsupported: ${subtype}` },
    });
    return;
  }

  if (message.type !== "user") return;
  const text = message.message?.content?.[0]?.text ?? "";

  if (!announced) {
    announced = true;
    // The real CLI's first frame. It carries no content this app reports, which is exactly why
    // it must still register as a heartbeat rather than as silence.
    write({ type: "system", subtype: "init", session_id: sessionId, tools: [] });
  }

  if (text.includes("DIE")) {
    process.exit(3);
  }
  if (text.includes("FORK")) {
    sessionId = FORKED_ID;
    assistant([{ type: "text", text: "answering in a forked session" }]);
    result();
    return;
  }
  if (text.includes("SLOW")) {
    pendingSlowTurn = true;
    assistant([{ type: "tool_use", name: "Bash", input: { command: "sleep 600" } }]);
    return;
  }
  if (text.includes("THINK")) {
    assistant([{ type: "thinking", thinking: "weighing it up" }, { type: "text", text: "considered answer" }]);
    result();
    return;
  }
  if (text.includes("NOISE")) {
    stdout.write("this line is not JSON at all\n");
    assistant([{ type: "text", text: "answer after noise" }]);
    result();
    return;
  }
  if (text.includes("SPLIT")) {
    const payload =
      `${JSON.stringify({ type: "assistant", session_id: sessionId, message: { model: "fake-model-1", content: [{ type: "text", text: 'a "quoted" \\ reply' }] } })}\n` +
      `${JSON.stringify({ type: "result", subtype: "success", session_id: sessionId, total_cost_usd: 0.0001 })}\n`;
    for (const ch of payload) stdout.write(ch);
    return;
  }

  // The normal case: echo back what it was told, plus this process's pid. The pid in the ANSWER
  // is what makes "no respawn happened" a checkable claim rather than an impression - two turns
  // that report the same pid were served by the same process.
  assistant([{ type: "text", text: `pid=${process.pid} heard: ${text}` }]);
  result();
}
