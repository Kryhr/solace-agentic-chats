/**
 * The live ACP probe: drives THIS repo's generic ACP persistent session against a REAL agent.
 *
 * It defaults to `opencode acp` with one of OpenCode's genuinely FREE models, because that is
 * the one ACP agent on this machine that can actually run a turn at no cost - Kimi is out of
 * quota, and Gemini and Qwen are not signed in. That makes it the only place the ACP prompt
 * stream (session/update -> AdapterEvents, session/cancel, a second prompt on one process) can
 * be observed end to end rather than inferred from a capture.
 *
 * It is a fixture, not a test: `node --test` must never depend on a network call. Run by hand:
 *
 *   PORT=4399 PROBE_MODEL=opencode/mimo-v2.5-free \
 *     node --import tsx src/adapters/persistent/fixtures/probeAcpLive.mts
 *
 * PORT is a spare one on purpose - see probeClaudeLive.mts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcpTransport, type AcpProviderSpec } from "../acpSession";
import type { AdapterEvent, RunTurnOptions } from "../../types";

const cwd = mkdtempSync(join(tmpdir(), "solace-acp-probe-"));

const spec: AcpProviderSpec = {
  provider: (process.env.PROBE_PROVIDER as AcpProviderSpec["provider"]) ?? "opencode",
  command: process.env.PROBE_COMMAND ?? "opencode",
  args: (process.env.PROBE_ARGS ?? "acp").split(" ").filter(Boolean),
  disabledReason: "live probe",
};

// Allow-once, so a turn that wants to run a tool is not silently stonewalled during a probe. The
// production default is the opposite (refuseByDefault) - an unwired approval gate must fail
// closed - and this override exists only to see the full stream.
const transport = createAcpTransport(spec, true, async (params) => {
  const allow = params.options.find((o) => o.kind === "allow_once") ?? params.options[0];
  console.log(`  [permission] ${params.toolCall?.title ?? params.toolCall?.toolCallId} -> ${allow?.optionId}`);
  return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } };
});

const turn = (prompt: string, signal?: AbortSignal) => {
  const events: AdapterEvent[] = [];
  const options: RunTurnOptions = {
    cwd,
    prompt,
    trustLevel: "acceptEdits",
    agentId: "probe",
    agentHandle: "probe",
    onEvent: (e) => {
      events.push(e);
      if (e.type === "text") console.log(`  [text] ${e.text.slice(0, 160)}`);
      if (e.type === "reasoning") console.log(`  [reasoning] ${e.text.slice(0, 80)}`);
      if (e.type === "tool-use") console.log(`  [tool] ${e.toolName}`);
      if (e.type === "session") console.log(`  [session] ${e.sessionId}`);
      if (e.type === "error") console.log(`  [error] ${e.message.slice(0, 300)}`);
      if (e.type === "cancelled") console.log("  [cancelled]");
    },
    signal,
  };
  return { events, options };
};

async function main() {
  console.log(`cwd=${cwd}`);
  console.log(`agent: ${spec.command} ${spec.args.join(" ")}`);
  const session = await transport.open({ cwd, agentId: "probe", agentHandle: "probe", trustLevel: "acceptEdits", model: process.env.PROBE_MODEL });
  const pid = session.pid;
  console.log(`\n== opened, pid=${pid}, acp session=${session.providerSessionId} ==`);

  console.log("\n== prompt 1 ==");
  await session.send(turn("Reply with exactly the word ONE and nothing else.").options);
  console.log(`pid after prompt 1: ${session.pid} (alive=${session.alive()})`);

  console.log("\n== prompt 2, pushed into the SAME process and the SAME session ==");
  await session.send(turn("What word did I ask you to say a moment ago? Answer in one word.").options);
  console.log(`pid after prompt 2: ${session.pid} (alive=${session.alive()})`);
  console.log(`acp session after prompt 2: ${session.providerSessionId}`);

  console.log("\n== prompt 3, cancelled mid-turn by protocol ==");
  const three = turn("Count from 1 to 400, one number per line, with no other text.");
  const running = session.send(three.options);
  const started = Date.now();
  while (!three.events.some((e) => e.type === "text" || e.type === "tool-use") && Date.now() - started < 90_000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log("  -> sending session/cancel");
  console.log(`  -> accepted: ${await session.interrupt()}`);
  await running;
  console.log(`pid after the cancel: ${session.pid} (alive=${session.alive()})`);

  console.log("\n== prompt 4, after the cancel, same process ==");
  await session.send(turn("Reply with exactly the word FOUR and nothing else.").options);
  console.log(`pid after prompt 4: ${session.pid} (alive=${session.alive()})`);

  console.log("\n== closing ==");
  await session.close("idle");
  console.log(`alive after close: ${session.alive()}`);
  console.log(`\n== VERDICT ==\none pid across every prompt: ${pid}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
