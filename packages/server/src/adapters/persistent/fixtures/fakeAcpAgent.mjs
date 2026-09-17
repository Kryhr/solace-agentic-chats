/**
 * A scriptable ACP agent for the persistent-session layer, over real pipes.
 *
 * Two modes, and the difference between them matters:
 *
 *   SCRIPT mode (default) - invents its own frames, so the transport can be driven through cases
 *     no capture contains: a multi-chunk update stream, a cancel mid-prompt, a permission request
 *     coming back at us, a second prompt on the same session.
 *
 *   REPLAY mode (SOLACE_ACP_REPLAY=<path to a captured .jsonl>) - answers `initialize` and
 *     `session/new` with the EXACT bytes a real `gemini --acp` / `qwen --acp` sent on this
 *     machine. Nothing is paraphrased: the fixtures record both directions of a real probe, and
 *     this replays the "in" side verbatim. That is what lets the capability handling be checked
 *     against a real agent's answer without either CLI being signed in.
 */
import { readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";

const replayPath = process.env.SOLACE_ACP_REPLAY;
/** method -> the recorded response frame for it, taken from the capture's "in" lines. */
const replay = new Map();
if (replayPath) {
  const lines = readFileSync(replayPath, "utf-8").split("\n").filter((l) => l.trim());
  /** id -> method, learned from the "out" lines, so a recorded response can be matched to what
   * was asked without assuming ids are stable between the capture and this run. */
  const askedFor = new Map();
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.dir === "out" && entry.msg?.id !== undefined && entry.msg?.method) askedFor.set(entry.msg.id, entry.msg.method);
    else if (entry.dir === "in" && entry.msg?.id !== undefined) {
      const method = askedFor.get(entry.msg.id);
      if (method && !replay.has(method)) replay.set(method, entry.msg);
    }
  }
}

const SESSION_ID = "scripted-session-1";
let buffer = "";

let pendingPrompt = null;
let promptCount = 0;

const write = (obj) => stdout.write(`${JSON.stringify(obj)}\n`);
const update = (u) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION_ID, update: u } });

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
  const { id, method, params } = message;

  // A response to something WE asked - today only session/request_permission, which was
  // blocking a prompt. Resolving that prompt with what we were told is how the test can check
  // that the answer actually reached the agent rather than being written into the void.
  if (method === undefined && id !== undefined) {
    if (pendingPrompt !== null) {
      const outcome = message.result?.outcome?.outcome ?? "no-answer";
      const optionId = message.result?.outcome?.optionId ?? "";
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `permission: ${outcome} ${optionId}`.trim() } });
      write({ jsonrpc: "2.0", id: pendingPrompt, result: { stopReason: "end_turn" } });
      pendingPrompt = null;
    }
    return;
  }

  if (replay.has(method)) {
    const recorded = replay.get(method);
    // Verbatim, except for the id, which belongs to THIS conversation rather than the capture's.
    write({ ...recorded, id });
    return;
  }

  switch (method) {
    case "initialize":
      write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "scripted-acp", version: "0.0.1" },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            sessionCapabilities: { close: {}, resume: {} },
          },
        },
      });
      return;
    case "session/new":
      // configOptions with a `model` select, which is how BOTH real agents observed so far
      // (kimi 0.43.1 and opencode acp 1.18.31) offer model selection: there is no --model flag
      // for an ACP agent, it is a session setting.
      write({
        jsonrpc: "2.0",
        id,
        result: {
          sessionId: SESSION_ID,
          configOptions: [
            {
              type: "select",
              id: "model",
              name: "Model",
              category: "model",
              currentValue: "scripted/model-a",
              options: [
                { value: "scripted/model-a", name: "A" },
                { value: "scripted/model-b", name: "B" },
              ],
            },
          ],
          modes: null,
        },
      });
      return;
    case "session/set_config_option":
      if (params?.optionId === "model" && ["scripted/model-a", "scripted/model-b"].includes(params?.value)) {
        write({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      write({ jsonrpc: "2.0", id, error: { code: -32602, message: `no such option value: ${params?.value}` } });
      return;
    case "session/resume":
      if (process.env.SOLACE_ACP_RESUME_FAILS) {
        write({ jsonrpc: "2.0", id, error: { code: -32000, message: "No such session" } });
        return;
      }
      write({ jsonrpc: "2.0", id, result: {} });
      return;
    case "session/prompt": {
      promptCount += 1;

      const text = params?.prompt?.[0]?.text ?? "";
      if (text.includes("SLOW")) {
        update({ sessionUpdate: "tool_call", toolCallId: "t1", name: "shell", rawInput: { command: "sleep 600" } });
        pendingPrompt = id;
        return;
      }
      if (text.includes("REFUSE")) {
        write({ jsonrpc: "2.0", id, error: { code: -32000, message: "Authentication required: 403 quota" } });
        return;
      }
      if (text.includes("ASK")) {
        // The agent asking US for permission - the inbound half of ACP, and the reason a real
        // approval gate is possible for a CLI whose headless flag has none.
        const ourId = 9000 + promptCount;
        write({
          jsonrpc: "2.0",
          id: ourId,
          method: "session/request_permission",
          params: {
            sessionId: SESSION_ID,
            toolCall: { toolCallId: "t9", title: "rm -rf /" },
            options: [
              { optionId: "yes", name: "Allow", kind: "allow_once" },
              { optionId: "no", name: "Deny", kind: "reject_once" },
            ],
          },
        });
        pendingPrompt = id;
        return;
      }
      // The ordinary case, deliberately spread over several notifications, ending with the size
      // of this process's pid inside the text so "one process served both turns" is checkable.
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking about it" } });
      update({ sessionUpdate: "usage_update", used: 12, size: 262144 });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `pid=${process.pid} heard: ${text}` } });
      write({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      return;
    }
    case "session/cancel":

      if (pendingPrompt !== null) {
        write({ jsonrpc: "2.0", id: pendingPrompt, result: { stopReason: "cancelled" } });
        pendingPrompt = null;
      }
      return;
    case "session/close":
      write({ jsonrpc: "2.0", id, result: {} });
      return;
    default:
      write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

stdin.on("end", () => process.exit(0));
