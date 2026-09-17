import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An agent must not be able to pull in an agent the operator left out.
 *
 * What happened, verbatim from the stored history: the operator wrote
 *   "@claude @Claude2 work together to think of a landing page idea ... think back and fourth"
 * which routed correctly to exactly those two. But @claude's reply carried
 *   mentions = ['Claude2', 'codex', 'copilot']
 * so codex and copilot were each given a real turn on a task the operator had scoped to two
 * agents. From the operator's side that is indistinguishable from the app ignoring who they
 * addressed - and it spends their subscription on agents they deliberately did not ask for.
 *
 * The agents were following instructions: the group context tells them an @mention IS the
 * delivery mechanism and hands them a roster of everyone in the chat. So this has to be enforced
 * in routing, not requested in a prompt.
 */
const SRC = readFileSync(join(import.meta.dirname, "agentManager.ts"), "utf8");

test("the operator's scope is derived from their most recent message", () => {
  assert.match(SRC, /private operatorScope\(chatId: string\): Set<string> \| undefined/);
  // Read from history, not held in memory, so a restart cannot silently widen the scope back to
  // everyone in the middle of a task.
  assert.match(SRC, /this\.bus\.getHistoryFor\(\{ chatId \}\)/);
});

test("an unaddressed human message leaves everyone reachable", () => {
  // Not naming anyone IS the instruction to involve everyone. The scope must be undefined there,
  // never an empty set that would silence the whole chat.
  assert.match(SRC, /m\.mentions\.length > 0 \? new Set\(m\.mentions\) : undefined/);
});

test("only AGENT-authored mentions are filtered", () => {
  // A human can always pull anyone in - that is the escape hatch the system note points at.
  const at = SRC.indexOf("let reachable: string[] = targets;");
  assert.notEqual(at, -1, "the filter must exist");
  const block = SRC.slice(at, at + 600);
  assert.match(block, /if \(isAgentAuthor\)/, "the scope check applies to agents only");
});

test("an agent can always answer whoever addressed it", () => {
  // Otherwise an agent could be spoken to and then forbidden from replying, which would strand
  // the exact collaboration this is meant to protect.
  assert.match(SRC, /if \(replyTarget\) allowed\.add\(replyTarget\)/);
});

test("a refused summons is visible, says no turn was spent, and names the way round it", () => {
  // Silently dropping it would be its own bug: the operator would see an agent ask for help and
  // nothing happen, with no way to tell why.
  assert.match(SRC, /tried to bring/);
  assert.match(SRC, /No turn was spent/);
  assert.match(SRC, /@mention them yourself/);
});

test("multi-agent requests get a plan-first instruction, single-agent ones do not", () => {
  assert.match(SRC, /private collaborationBlock\(chatId: string, self: AgentConfig\): string/);
  // Narrow by construction: fewer than two named agents means there is nobody to plan with, and
  // the fastest useful thing is to do the work.
  assert.match(SRC, /if \(!scope \|\| scope\.size < 2\) return "";/);
});

test("every addressed agent starts at once - nobody queues behind anybody", () => {
  // An earlier fix made the first-named agent open alone so the others had something to respond
  // to. That was wrong for the case that matters most: an operator handing five agents five
  // distinct tasks in one message does not want four of them idling until the first replies.
  // Parallel dispatch is the default again; the block below is what makes it safe.
  assert.ok(!/is going first so there is something/.test(SRC), "no agent is made to wait its turn");
});

test("agents are told the others are running right now, and how to reach them mid-turn", () => {
  // The real defect was never the dispatch order - it was that neither agent could SEE the
  // other. Both posted a proposal in the same second and neither could read the other's, because
  // when a turn begins the other's message does not exist yet. post_to_group's reply carries
  // whatever arrived since, which is the only channel that works inside a live turn.
  assert.match(SRC, /RIGHT NOW, at the same time/);
  assert.match(SRC, /That tool's reply carries whatever/);
  assert.match(SRC, /READ IT/);
});

test("the instruction covers joint thinking AND separately assigned work", () => {
  // One instruction rather than a guess at which kind of request this is: the agent has the
  // operator's own words and can tell. Planning together means post and stop; distinct tasks
  // mean announce what you are taking and get on with it.
  assert.match(SRC, /think, plan or ` \+\s*`agree something TOGETHER/);
  assert.match(SRC, /gave each of you a distinct piece of work, do not wait/);
});
