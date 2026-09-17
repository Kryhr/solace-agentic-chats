import type { SettingsStore } from "./settingsStore";
import { basename, classifyToolCall } from "./toolLabel";

/**
 * The progress digest: one short line, every few minutes of a long turn, saying what that turn
 * has ACTUALLY done so far.
 *
 * The measured problem (ROADMAP.md, root cause B): the group only ever sees an agent's final
 * answer, so a turn that thinks and builds for twelve minutes is twelve minutes of silence
 * followed by a 1,300-character dump. Two agents working in parallel therefore cannot
 * coordinate, and twice that produced two independent builds of the same landing page.
 *
 * ============================================================================================
 * THE RULE THIS FILE EXISTS TO ENFORCE, and the reason every function below is shaped the way
 * it is: a digest line is COUNTED from real tool-use events. It is never summarised, never
 * generated, and no model is asked to write it or shown it before it is posted.
 * ============================================================================================
 *
 * Concretely, that means three things:
 *
 *  1. The only input is `(toolName, input)` exactly as the provider emitted it - the same pair
 *     toolLabel.describeToolCall already turns into a human label. Classification goes through
 *     classifyToolCall, which reads the SAME table, so "what counts as a write" cannot drift
 *     from "what is labelled as writing".
 *  2. Every clause in the output is a number and a noun, both of which came out of that data.
 *     There is no free text field anywhere in the tally, so there is nothing for a sentence to
 *     be written into even by accident.
 *  3. If nothing countable happened, nothing is posted. Silence is more honest than "still
 *     working" - which is a sentence nothing verified, and precisely the kind of unbacked
 *     reassurance this codebase spends most of its comments keeping out.
 *
 * What it deliberately does NOT say:
 *  - anything about whether the work is going well, nearly done, or blocked;
 *  - anything about what the agent intends to do next;
 *  - that a server is UP. A started server is an action the tool arguments prove happened; a
 *    listening server is a state only a real check can establish (root cause E, and 18% of
 *    "it's live" claims were contradicted within fifteen messages). So the line says "server
 *    started on :4321", which is what the evidence supports, and leaves "is it up" to the
 *    URL checker and the server registry.
 */

/** How often the digest wakes up to see whether a line is due. Not the cadence - the cadence is
 * a user setting read live on each of these ticks. A short tick only decides how promptly a due
 * line appears; it never causes an extra one, because emission is gated on the cadence and on
 * the line having actually changed. */
export const DIGEST_TICK_MS = 15_000;

/**
 * The shortest gap between two digest lines for one turn, whatever the cadence.
 *
 * A milestone (the first file written, the first test run, the first server started) makes a
 * line eligible before the cadence has elapsed, because "codex has started writing files" is
 * worth knowing immediately when someone else is about to write the same ones. Without a floor,
 * a turn that writes a file, runs tests and starts a server inside ten seconds would post three
 * lines in ten seconds - trading silence for chatter, which is the other failure.
 */
export const MILESTONE_MIN_GAP_MS = 60_000;

/** Everything counted for one turn. Every field is a number or a set of real paths/ports taken
 * from tool arguments: there is deliberately no string field that could hold a sentence. */
export interface DigestTally {
  filesWritten: Set<string>;
  filesRead: Set<string>;
  testRuns: number;
  commandRuns: number;
  searches: number;
  serverPorts: Set<number>;
}

export function emptyTally(): DigestTally {
  return {
    filesWritten: new Set(),
    filesRead: new Set(),
    testRuns: 0,
    commandRuns: 0,
    searches: 0,
    serverPorts: new Set(),
  };
}

/**
 * Is this shell command a test run?
 *
 * Matched against the real command string a provider reported, by a list of the actual ways
 * test suites are invoked. Deliberately narrow: a command this does not recognise is counted as
 * an ordinary command run, which understates the turn. Guessing the other way would produce
 * "2 test runs" for a turn that ran none, and a digest that invents a test run is worse than no
 * digest at all.
 */
export function isTestCommand(command: string): boolean {
  const c = command.trim().toLowerCase();
  if (!c) return false;
  return [
    `(npm|pnpm|yarn|bun)\\s+(run\\s+)?test\\b`,
    `node\\s+(--\\S+\\s+)*--test\\b`,
    `(npx\\s+|bunx\\s+)?(jest|vitest|mocha|ava|tap|playwright\\s+test|cypress\\s+run)\\b`,
    `(pytest|py\\.test)\\b`,
    `python3?\\s+-m\\s+(pytest|unittest)\\b`,
    `(go|cargo|dotnet|mvn|gradle|swift)\\s+test\\b`,
    `(rspec|phpunit|rake\\s+test|ctest)\\b`,
  ].some((body) => atCommandHead(body).test(c));
}

/**
 * The program name has to be at the HEAD of a command, not merely somewhere in the string.
 *
 * Caught by its own test: `git commit -m 'serve the page on :4321'` matched a bare `serve` and
 * was about to be reported to the whole group as a server started on :4321 - a fabricated fact
 * derived from a commit message. A head anchor is the difference between reading the command
 * and reading the text that happens to be inside it.
 *
 * Start of string, or immediately after a shell separator. A command wrapped in something
 * (`sudo npm test`, `cross-env npm test`) is therefore NOT matched and is counted as an
 * ordinary command run - undercounting, which is the only direction of error allowed here.
 */
function atCommandHead(body: string): RegExp {
  return new RegExp(`(?:^|&&|\\|\\||;|\\|)\\s*(?:npx\\s+|bunx\\s+)?${body}`, "i");
}

/**
 * The ports a server-starting command explicitly named, or [] for everything else.
 *
 * Two conditions, both required, and both about evidence rather than likelihood:
 *
 *  - the command has to match one of the shapes below, which are real dev-server invocations;
 *  - the port has to be WRITTEN IN THE COMMAND. A `npm run dev` with the port in a config file
 *    is a server start we cannot name a port for, and "server started on :3000" guessed from a
 *    framework's default is the sort of confident wrong number that sends somebody to the wrong
 *    URL. Such a command is counted as an ordinary command run instead.
 */
export function serverStartPorts(command: string): number[] {
  const c = command.trim();
  const looksLikeServer = [
    `(npm|pnpm|yarn|bun)\\s+(run\\s+)?(dev|start|serve|preview)\\b`,
    `(vite|serve|http-server|live-server|next|nuxt|remix|astro|webpack-dev-server)\\b`,
    `python3?\\s+-m\\s+http\\.server\\b`,
    `(uvicorn|gunicorn|hypercorn|daphne)\\b`,
    `flask\\s+run\\b`,
    `rails\\s+s(erver)?\\b`,
    `php\\s+-S\\b`,
    `dotnet\\s+run\\b`,
  ].some((body) => atCommandHead(body).test(c));
  if (!looksLikeServer) return [];

  const ports = new Set<number>();
  const patterns = [
    /--port[=\s]+(\d{2,5})\b/gi,
    /(?:^|\s)-p[=\s]+(\d{2,5})\b/g,
    /\bPORT[=\s]+(\d{2,5})\b/g,
    /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)?:(\d{2,5})\b/g,
  ];
  for (const re of patterns) {
    for (const match of c.matchAll(re)) {
      const port = Number(match[1]);
      // Ports below 1024 are privileged and essentially never what a dev server is told to use,
      // and anything above 65535 is not a port at all - both are far more likely to be some
      // other number in the command line that happened to sit after a colon.
      if (port >= 1024 && port <= 65535) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** Fold one real tool call into a tally. Returns the milestone it crossed, if any. */
export function recordInto(tally: DigestTally, toolName: string, input?: unknown): "files" | "tests" | "server" | undefined {
  const action = classifyToolCall(toolName, input);
  let milestone: "files" | "tests" | "server" | undefined;

  if (action.kind === "write") {
    const before = tally.filesWritten.size;
    for (const path of action.paths) tally.filesWritten.add(path);
    // A write whose arguments named no path still happened, and is still worth counting - but
    // it cannot be counted by path, so it is not counted at all rather than counted as a
    // fictitious one. This is the understating-not-overstating trade, again.
    if (before === 0 && tally.filesWritten.size > 0) milestone = "files";
  } else if (action.kind === "read") {
    for (const path of action.paths) tally.filesRead.add(path);
  } else if (action.kind === "search") {
    tally.searches += 1;
  } else if (action.kind === "shell") {
    const command = action.command ?? "";
    const ports = serverStartPorts(command);
    if (isTestCommand(command)) {
      tally.testRuns += 1;
      if (tally.testRuns === 1) milestone = "tests";
    } else if (ports.length > 0) {
      const before = tally.serverPorts.size;
      for (const port of ports) tally.serverPorts.add(port);
      if (before === 0) milestone = "server";
    } else {
      tally.commandRuns += 1;
    }
  }
  return milestone;
}

/** True when there is at least one thing worth saying. Reads, searches and plain commands alone
 * do NOT qualify: every turn does those, so a line reporting them is indistinguishable from
 * "still working" with a number attached. */
export function hasReportableWork(tally: DigestTally): boolean {
  return tally.filesWritten.size > 0 || tally.testRuns > 0 || tally.serverPorts.size > 0;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The clauses, most load-bearing first, capped so the line stays one line.
 *
 * Each is a count and a noun. There is no branch here that produces an adjective, an assessment
 * or a verb in the future tense, and that is the property progressDigest.test.ts pins.
 */
export function factsFor(tally: DigestTally): string[] {
  const facts: string[] = [];
  if (tally.filesWritten.size > 0) facts.push(plural(tally.filesWritten.size, "file written", "files written"));
  if (tally.testRuns > 0) facts.push(plural(tally.testRuns, "test run", "test runs"));
  if (tally.serverPorts.size > 0) {
    const ports = [...tally.serverPorts].map((p) => `:${p}`).join(", ");
    facts.push(`${tally.serverPorts.size === 1 ? "server" : "servers"} started on ${ports}`);
  }
  if (tally.commandRuns > 0) facts.push(plural(tally.commandRuns, "command run", "commands run"));
  if (tally.filesRead.size > 0) facts.push(plural(tally.filesRead.size, "file read", "files read"));
  // Four clauses is already a long line in a chat window; the rest is in the agent's own hub,
  // in full, as it happened.
  return facts.slice(0, 4);
}

/** The whole line, or undefined when there is nothing that has actually happened to report. */
export function digestLine(handle: string, tally: DigestTally): string | undefined {
  if (!hasReportableWork(tally)) return undefined;
  return [`@${handle}`, ...factsFor(tally)].join(" · ");
}

interface LiveTurn {
  agentId: string;
  handle: string;
  chatId: string;
  startedAt: number;
  lastEmitAt: number;
  lastLine?: string;
  milestonePending: boolean;
  tally: DigestTally;
}

/** What a chat has accumulated, for /summary. Held per chat rather than per turn so the answer
 * covers the whole collaboration and not just whoever happens to be mid-turn. */
export interface ChatFacts {
  /** When this server started counting. Stated with the facts, because a restart genuinely
   * loses the tally and a total presented without its window would read as the chat's whole
   * history. */
  since: string;
  tally: DigestTally;
  /** Per agent handle, so /summary can say who did what rather than only a grand total. */
  byHandle: Map<string, DigestTally>;
}

/**
 * Holds the live turns, counts their tool calls, and emits a line when one is due.
 *
 * Nothing in here reaches into AgentManager: it is fed three hooks (beginTurn / recordTool /
 * endTurn) and posts through a callback. That is what keeps the agentManager.ts side of this
 * feature to four lines, which matters because routing and the turn lifecycle are being changed
 * on other branches at the same time.
 */
export class ProgressDigest {
  private turns = new Map<string, LiveTurn>();
  private chats = new Map<string, ChatFacts>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    /** Read live, at the moment a line would be emitted - never a value captured at boot. */
    private settings: SettingsStore,
    /** Posts one system line into a chat. */
    private post: (chatId: string, text: string) => void,
    /** Injectable so the tests can drive time instead of waiting three minutes for it. */
    private now: () => number = () => Date.now(),
  ) {}

  /** Starts the tick. Safe to call twice; unref'd so it never holds the process open. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), DIGEST_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * A turn has started. `chatId` is undefined for a hub turn, and those are ignored entirely:
   * the hub already shows every tool call as it happens, so a digest there would summarise a
   * transcript the reader is already looking at.
   */
  beginTurn(agentId: string, handle: string, chatId: string | undefined): void {
    if (!chatId) {
      this.turns.delete(agentId);
      return;
    }
    const at = this.now();
    this.turns.set(agentId, {
      agentId,
      handle,
      chatId,
      startedAt: at,
      lastEmitAt: at,
      milestonePending: false,
      tally: emptyTally(),
    });
  }

  /** One real tool-use event, with the provider's own tool name and its own arguments. */
  recordTool(agentId: string, toolName: string, input?: unknown): void {
    const turn = this.turns.get(agentId);
    if (!turn) return;
    const milestone = recordInto(turn.tally, toolName, input);
    if (milestone) turn.milestonePending = true;
    // The chat-wide tally is fed from the same call, so /summary and the digest can never
    // disagree about what happened.
    const facts = this.factsForChat(turn.chatId);
    recordInto(facts.tally, toolName, input);
    let mine = facts.byHandle.get(turn.handle);
    if (!mine) {
      mine = emptyTally();
      facts.byHandle.set(turn.handle, mine);
    }
    recordInto(mine, toolName, input);
  }

  /**
   * The turn ended. Nothing is posted here on purpose: the agent's own final answer lands in the
   * same chat within moments, and a digest immediately before it would be the duplicate-post
   * noise chatNoise.test.ts already covers.
   */
  endTurn(agentId: string): void {
    this.turns.delete(agentId);
  }

  /** Every live turn that is due a line, posted. Exposed so tests can step time by hand. */
  tick(): void {
    const cadenceMinutes = this.settings.get().progressDigestMinutes;
    if (cadenceMinutes <= 0) return; // the digest is switched off
    const cadenceMs = cadenceMinutes * 60_000;
    const at = this.now();
    for (const turn of this.turns.values()) {
      const since = at - turn.lastEmitAt;
      const due = since >= cadenceMs || (turn.milestonePending && since >= MILESTONE_MIN_GAP_MS);
      if (!due) continue;
      const line = digestLine(turn.handle, turn.tally);
      if (!line) continue; // nothing countable happened - say nothing
      // Counts are cumulative, so an unchanged line means nothing has happened since the last
      // one. Re-posting it would be a status message that reports no change, which is the exact
      // category of noise this feature is supposed to reduce.
      if (line === turn.lastLine) continue;
      turn.lastEmitAt = at;
      turn.lastLine = line;
      turn.milestonePending = false;
      this.post(turn.chatId, line);
    }
  }

  /** What this chat has accumulated since the server started. Used by /summary. */
  factsForChat(chatId: string): ChatFacts {
    let facts = this.chats.get(chatId);
    if (!facts) {
      facts = { since: new Date(this.now()).toISOString(), tally: emptyTally(), byHandle: new Map() };
      this.chats.set(chatId, facts);
    }
    return facts;
  }

  /** The distinct files written in this chat, by base name, for /summary and /who. */
  filesWrittenIn(chatId: string): string[] {
    return [...this.factsForChat(chatId).tally.filesWritten].map((p) => basename(p)).sort();
  }
}
