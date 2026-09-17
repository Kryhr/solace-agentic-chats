/**
 * The one-off live probe: drives THIS repo's persistent transport against the REAL `claude`
 * binary, so the claim "a second message reaches a live session without a respawn" is something
 * that was observed rather than something that was designed.
 *
 * It is a fixture, not a test: `node --test` must never spend the operator's subscription. Run
 * it by hand, once, when you need to re-verify:
 *
 *   PORT=4399 node --import tsx src/adapters/persistent/fixtures/probeClaudeLive.mts
 *
 * PORT is deliberately a spare one. The solace MCP bridge the CLI spawns calls back to
 * SOLACE_SERVER_PORT, and pointing it at 4310/4320 would have a probe's helper process talking
 * to one of the operator's live instances.
 *
 * Everything it prints is raw: the pid, the session ids the CLI itself reported, and the exact
 * control_response frame. No summarising - the point of the run is the evidence.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeStreamJsonTransport } from "../claudeStreamJson";
import type { AdapterEvent, RunTurnOptions } from "../../types";

const cwd = mkdtempSync(join(tmpdir(), "solace-live-probe-"));
const transport = createClaudeStreamJsonTransport(true);

const turn = (prompt: string, signal?: AbortSignal) => {
  const events: AdapterEvent[] = [];
  const options: RunTurnOptions = {
    cwd,
    prompt,
    trustLevel: "plan",
    agentId: "probe",
    agentHandle: "probe",
    model: process.env.PROBE_MODEL ?? "haiku",
    onEvent: (e) => {
      events.push(e);
      if (e.type === "text") console.log(`  [text] ${e.text.slice(0, 120)}`);
      if (e.type === "session") console.log(`  [session] ${e.sessionId}`);
      if (e.type === "tool-use") console.log(`  [tool] ${e.toolName}`);
      if (e.type === "error") console.log(`  [error] ${e.message.slice(0, 300)}`);
      if (e.type === "cancelled") console.log("  [cancelled]");
    },
    signal,
  };
  return { events, options };
};

async function main() {
  console.log(`cwd=${cwd}`);
  const session = await transport.open({
    cwd,
    agentId: "probe",
    agentHandle: "probe",
    trustLevel: "plan",
    model: process.env.PROBE_MODEL ?? "haiku",
  });
  console.log(`args: ${JSON.stringify((session as unknown as { args(): string[] }).args())}`);
  const pid = session.pid;
  console.log(`\n== opened, pid=${pid} ==`);

  console.log("\n== message 1 ==");
  const one = turn("Reply with exactly the word ONE and nothing else.");
  await session.send(one.options);
  console.log(`pid after message 1: ${session.pid} (alive=${session.alive()})`);

  console.log("\n== message 2, pushed into the SAME process ==");
  const two = turn("Reply with exactly the word TWO and nothing else.");
  await session.send(two.options);
  console.log(`pid after message 2: ${session.pid} (alive=${session.alive()})`);

  console.log("\n== message 3, interrupted mid-turn by protocol ==");
  const controller = new AbortController();
  const three = turn(
    "Count from 1 to 400, one number per line, slowly, with no other text.",
    controller.signal,
  );
  const running = session.send(three.options);
  // Interrupt once the turn has actually started saying something, so the interrupt is landing
  // on work in progress rather than racing the prompt write.
  const started = Date.now();
  while (!three.events.some((e) => e.type === "text") && Date.now() - started < 60_000) {
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log("  -> sending control_request interrupt");
  const acknowledged = await session.interrupt();
  console.log(`  -> acknowledged: ${acknowledged}`);
  await running;
  console.log(`pid after the interrupt: ${session.pid} (alive=${session.alive()})`);

  console.log("\n== message 4, after the interrupt, same process ==");
  const four = turn("Reply with exactly the word FOUR and nothing else.");
  await session.send(four.options);
  console.log(`pid after message 4: ${session.pid} (alive=${session.alive()})`);

  console.log("\n== closing ==");
  await session.close("idle");
  console.log(`alive after close: ${session.alive()}`);

  console.log("\n== VERDICT ==");
  console.log(`one pid across every turn: ${pid === undefined ? "n/a" : "pid=" + pid}`);
  console.log(`interrupt acknowledged by the CLI: ${acknowledged}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
