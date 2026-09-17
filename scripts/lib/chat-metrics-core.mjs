/**
 * Pure analysis functions behind `scripts/chat-metrics.mjs`.
 *
 * Deliberately free of any file or process access so the whole thing can be unit-tested with
 * hand-written messages (`node --test scripts/chat-metrics.test.mjs`) and never needs to read
 * a real `.solace-state.json`. The CLI does the reading; this module does the counting.
 *
 * A word on honesty: several of these metrics are text heuristics over free-form English
 * written by language models. They are labelled `approximate: true` in the report and printed
 * with a "~" in the table. They are good enough to show a change moving a number, which is what
 * ROADMAP.md step 1 asks for; they are not good enough to quote as exact facts.
 */

/** Author ids that are not an agent. `"you"` shows up as a handle, `"user"` as the id. */
export const NON_AGENT_AUTHORS = new Set(["user", "you", "system"]);

// ---------------------------------------------------------------------------------------------
// small numeric helpers
// ---------------------------------------------------------------------------------------------

/** Median of a numeric array. Returns null for an empty array rather than NaN, because every
 *  consumer here has to render "no data" differently from "zero". */
export function median(values) {
  return percentile(values, 50);
}

/** Nearest-rank percentile (p in 0..100). Null for an empty array. */
export function percentile(values, p) {
  const nums = values.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  if (nums.length === 1) return nums[0];
  const rank = Math.ceil((p / 100) * nums.length);
  return nums[Math.min(nums.length - 1, Math.max(0, rank - 1))];
}

export function max(values) {
  const nums = values.filter((n) => typeof n === "number" && Number.isFinite(n));
  return nums.length ? Math.max(...nums) : null;
}

/** Percentage with one decimal, or null when the denominator is 0 - a chat with no agent
 *  messages has no "share addressed", it does not have 0%. */
export function share(part, whole) {
  if (!whole) return null;
  return Math.round((part / whole) * 1000) / 10;
}

// ---------------------------------------------------------------------------------------------
// text normalisation
// ---------------------------------------------------------------------------------------------

/** Strip the markdown, mentions and whitespace that make two identical statements compare
 *  unequal. Used for ack/status classification and for near-duplicate detection. */
export function normalizeText(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/@[A-Za-z0-9_-]+/g, " ")
    .replace(/[*_#>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Lowercased word list, for similarity. */
export function tokenize(text) {
  return normalizeText(text)
    .toLowerCase()
    // Everything that is not a letter or digit becomes a separator. Punctuation has to go:
    // "complete:" and "complete" are the same word, and leaving the colon on made an agent's
    // mid-turn post and its own final answer look only two thirds alike.
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Jaccard similarity over word bigrams, 0..1. Bigrams rather than single words because two
 *  different status lines about the same build share most of their vocabulary but very little
 *  of their phrasing; 7 near-duplicates in 530 messages is a signal that unigrams drown. */
export function similarity(a, b) {
  const grams = (text) => {
    const words = tokenize(text);
    if (words.length === 0) return new Set();
    if (words.length === 1) return new Set(words);
    const out = new Set();
    for (let i = 0; i < words.length - 1; i += 1) out.add(`${words[i]} ${words[i + 1]}`);
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared += 1;
  return shared / (A.size + B.size - shared);
}

/** Split into sentence-ish spans. Liveness claims are judged per sentence so that
 *  "Port 4321 is free. Once the demo lands I'll verify the URL." is not read as "it's live". */
export function sentences(text) {
  return normalizeText(text)
    .split(/(?<=[.!?;\n])\s+|\s+[-–—]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// message classification (all heuristic, all approximate)
// ---------------------------------------------------------------------------------------------

const ACK_OPENERS =
  /^(ack|ack\d*|acknowledged|noted|understood|confirmed|got it|copy that|roger|sounds good|will do|agreed|makes sense|ok|okay|yes|yep|thanks|thank you|perfect|great|good|nice)\b/i;

const NOTHING_FURTHER =
  /\b(nothing (further|else|outstanding|more)|no action (needed|required)|no changes? needed|standing by|holding (here|for)|ready (to help|if you need|when you)|i'?m aligned|i'?ve read the skills|no blockers from me|awaiting)\b/i;

const SUBSTANCE = /```|https?:\/\/|\bfile\b|\.(ts|tsx|js|mjs|css|html|json|md|py)\b|\n\s*[-*\d]\s|\?\s*$/i;

/** A polite opener can still be carrying a finding: "Acknowledged - but the mobile menu does not
 *  close on Escape at 375px" is a bug report, not an ack. Anything that names a problem or
 *  carries a measurement vetoes the ack classification. */
const CARRIES_A_FACT =
  /\b(does ?n'?t|do not|is ?n'?t|are ?n'?t|was ?n'?t|failed|failing|broken|breaks|error|bug|issue|missing|wrong|regress\w*|instead of|found)\b|\d+\s?(px|ms|s\b|%|x\b)|:\d{4,5}\b/i;

/** An acknowledgement-only message: it costs everyone a turn and carries no new fact.
 *  Approximate. Long messages are never acks here, however politely they open. */
export function isAckOnly(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (t.length > 240) return false;
  if (SUBSTANCE.test(t)) return false;
  if (CARRIES_A_FACT.test(t)) return false;
  if (/\?/.test(t)) return false;
  return ACK_OPENERS.test(t) || NOTHING_FURTHER.test(t);
}

const STATUS_MARKERS =
  /\b(verified|verifying|confirmed|status(:| this turn| update)|all (routes|tests|checks|pages)|\b200\b|passing|green|complete(d)?|done\b|finished|no errors|up and running|build is clean|tests? pass)/i;

/** A status report that names nobody: "Verified: all routes 200" to a room that did not ask.
 *  Caller supplies whether the message was addressed; this only judges the text.
 *
 *  The marker has to be in the lead, not buried on line forty: a report leads with its status,
 *  while a long design argument that happens to use the word "done" halfway through is not one.
 *  Approximate. */
export function isStatusReport(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (/\?/.test(t)) return false;
  return STATUS_MARKERS.test(t.slice(0, 200));
}

/** A message that is nothing but the routing marker. The marker exists to end a thread; posting
 *  it into the room is routing metadata rendered as conversation. */
export function isBareNoReply(text) {
  return /^\s*\[?no[-\s]?reply\]?\s*$/i.test(String(text ?? ""));
}

/** An agent complaining it never got a message, or got a clipped one. Approximate. */
export function isDeliveryComplaint(text) {
  const t = normalizeText(text);
  return /\b(didn'?t (get|receive)|did not (get|receive)|never (got|received)|only (got|received)|truncat\w*|cut off|clipped|incomplete message|partial message)\b/i.test(
    t,
  );
}

/** The system notice for a reply chain that hit the hop cap - a message that never arrived. */
export function isChainCutoff(text) {
  return /stopped an agent-to-agent reply chain after \d+ hops|agents are not allowed to trigger each other \(0 hops\)/i.test(
    String(text ?? ""),
  );
}

/** A rate limit, whether reported as a system notice or as the turn's error text. */
export function isRateLimitNotice(text) {
  return /\b(rate limit|usage limit|quota exceeded|429)\b/i.test(String(text ?? ""));
}

/** The idle watchdog killing a turn that stopped producing output, or the hard turn ceiling. */
export function isWatchdogKill(text) {
  return /turn stopped: no output for \d+ minutes|treated as stuck|turn stopped after .*without finishing|hit this app'?s maximum turn length/i.test(
    String(text ?? ""),
  );
}

// -- liveness ----------------------------------------------------------------------------------

const URL_OR_PORT = /(https?:\/\/[^\s)"'`]+|\blocalhost:\d{2,5}|\b127\.0\.0\.1:\d{2,5}|\bport\s+\d{2,5}|:\d{4,5}\b)/i;

const LIVE_PHRASE =
  /\b(is (now )?live|now live|it'?s live|goes? live|is up(\s+and\s+running)?|up and running|is running|still running|running (at|on)|serving (at|on)|live (at|on)|deployed (at|to)|available at|responds? with 200|returns? 200|all routes return 200)\b/i;

/** Future tense, conditionals and negations: "once it lands I'll verify the URL" is not a claim
 *  that it is live right now. */
const NOT_A_CLAIM = /\b(will be|would be|once|when it|if it|should be|going to|plan to|about to|not (yet )?(live|running|up)|isn'?t|is not|no longer|can'?t|cannot)\b/i;

/** What it looks like when the thing turns out not to be up. Deliberately does NOT include a
 *  planned teardown ("per the operator I tore down X, killed the node process on :5453"): the
 *  claim was true when it was made and the server was removed on purpose. Counting that as a
 *  contradiction inflated this number by a factor of two on the real data. */
const DEAD_PHRASE =
  /\b(not live|isn'?t live|is not live|no longer (live|running|up)|is down|went down|went offline|died|connection refused|econnrefused|unreachable|nothing (is )?listening|not responding|not running|isn'?t running|never (started|came up)|curl exit 000)\b/i;

/** Every port number a message mentions, so a claim about :4321 is only contradicted by a
 *  message about :4321. */
export function portsIn(text) {
  const out = new Set();
  const src = String(text ?? "");
  for (const m of src.matchAll(/(?::|\bport\s+)(\d{2,5})\b/gi)) {
    const n = Number(m[1]);
    if (n >= 1024 && n <= 65535) out.add(n);
  }
  return [...out];
}

/** "It's live" - an assertion, right now, about a thing at a URL or port. Approximate. */
export function isLiveClaim(text) {
  const src = String(text ?? "");
  if (!URL_OR_PORT.test(src)) return false;
  return sentences(src).some(
    (s) => URL_OR_PORT.test(s) && LIVE_PHRASE.test(s) && !NOT_A_CLAIM.test(s) && !DEAD_PHRASE.test(s),
  );
}

/** A later message saying the thing is not, in fact, up. Approximate. */
export function isLiveContradiction(text) {
  const src = String(text ?? "");
  return sentences(src).some((s) => DEAD_PHRASE.test(s));
}

// -- file writes -------------------------------------------------------------------------------

const WRITE_TOOLS = new Set(
  [
    "write",
    "edit",
    "multiedit",
    "notebookedit",
    "write_file",
    "create_file",
    "edit_file",
    "update_file",
    "apply_patch",
    "file_change",
    "str_replace",
    "str_replace_editor",
    "create",
    "patch",
  ].map((s) => s.toLowerCase()),
);

/** Whether a tool-use marker in an agent's hub channel represents a file actually being written.
 *  Shell tools are inspected for the obvious redirect/heredoc/copy forms, because several CLIs
 *  write files through the shell and would otherwise never register a first write. Approximate. */
export function isWriteTool(name, detail = "") {
  const n = String(name ?? "").toLowerCase();
  if (WRITE_TOOLS.has(n)) return true;
  if (/^(bash|powershell|shell|command_execution|run_command|execute)$/.test(n)) {
    return /(^|\s)(>|>>)\s*\S|<<\s*['"]?EOF|\b(tee|cp|mv|touch|mkdir)\b|Set-Content|Out-File|New-Item/i.test(
      String(detail ?? ""),
    );
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// state normalisation
// ---------------------------------------------------------------------------------------------

/**
 * Turn a raw `.solace-state.json` into the shape the analysis wants:
 * live chats plus archived ones, each with its own group-stream messages, and the per-agent hub
 * streams kept aside for the tool-use markers.
 *
 * Tolerant by design: a missing key, a null, a message without `createdAt` - none of it throws.
 * The CLI has to survive being pointed at a half-written state file.
 */
export function normalizeState(raw) {
  const state = raw && typeof raw === "object" ? raw : {};
  const agents = Array.isArray(state.agents) ? state.agents.filter(Boolean) : [];
  const agentsById = new Map();
  const agentsByHandle = new Map();
  for (const a of agents) {
    if (!a || !a.id) continue;
    agentsById.set(a.id, a);
    if (a.handle) agentsByHandle.set(String(a.handle).toLowerCase(), a);
  }

  const history = Array.isArray(state.history) ? state.history.filter(Boolean) : [];
  const archives = Array.isArray(state.archives) ? state.archives.filter(Boolean) : [];

  const titles = new Map();
  for (const c of Array.isArray(state.chats) ? state.chats : []) {
    if (c && c.id) titles.set(c.id, c.title || c.name || c.id);
  }

  /** chatId -> {id,title,archived,messages} */
  const chats = new Map();
  const hub = []; // every agent-hub message, from live history and archives alike

  const take = (messages, { archived, label }) => {
    for (const m of messages) {
      if (!m || !m.channel) continue;
      if (m.channel.chatId) {
        const id = m.channel.chatId;
        if (!chats.has(id)) {
          chats.set(id, { id, title: titles.get(id) || label || id, archived, messages: [] });
        }
        const chat = chats.get(id);
        // A chat that was cleared and then reused is one chat, not two; if any part of it is
        // still live, it is not an archived chat.
        if (!archived) chat.archived = false;
        chat.messages.push(m);
      } else if (m.channel.agentId) {
        hub.push(m);
      }
    }
  };

  take(history, { archived: false });
  for (const a of archives) {
    const label = a.channelLabel || (a.channel && a.channel.chatId) || undefined;
    take(Array.isArray(a.messages) ? a.messages.filter(Boolean) : [], { archived: true, label });
  }

  const byTime = (a, b) => timeOf(a) - timeOf(b);
  for (const chat of chats.values()) chat.messages.sort(byTime);
  hub.sort(byTime);

  return { agents, agentsById, agentsByHandle, chats: [...chats.values()], hub };
}

/** Epoch ms for a message, or Infinity so undated messages sort last instead of throwing. */
export function timeOf(message) {
  const t = Date.parse(message && message.createdAt ? message.createdAt : "");
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

export function isAgentMessage(message, agentsById) {
  if (!message || !message.authorId) return false;
  if (NON_AGENT_AUTHORS.has(message.authorId)) return false;
  // An agent that has since been deleted still wrote its messages; fall back to "not a known
  // non-agent author" rather than dropping half the history of an old chat.
  return agentsById ? agentsById.has(message.authorId) || !NON_AGENT_AUTHORS.has(message.authorId) : true;
}

// ---------------------------------------------------------------------------------------------
// the analysis
// ---------------------------------------------------------------------------------------------

const REPLY_WINDOW_MS = 60 * 60 * 1000; // an hour later is not a reply, it is a new conversation
const DUPLICATE_LOOKBACK = 8; // messages
const DUPLICATE_SIMILARITY = 0.72;
const CONTRADICTION_WINDOW = 15; // messages, per ROADMAP
const LATE_REPLY_MS = 120_000;

/**
 * Every metric for one chat. `messages` is the chat's group stream in time order; `hub` is the
 * full list of agent-hub messages (tool markers live there) so the first-file-written metric can
 * find the first write by a participant inside this chat's time window.
 */
export function analyzeChat(chat, { hub = [], agentsById = new Map() } = {}) {
  const messages = (chat.messages || []).slice().sort((a, b) => timeOf(a) - timeOf(b));
  const agentMessages = messages.filter((m) => isAgentMessage(m, agentsById));

  // -- reply latency to an @mention ------------------------------------------------------------
  const latencies = [];
  let unanswered = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const src = messages[i];
    const mentions = Array.isArray(src.mentions) ? src.mentions : [];
    if (mentions.length === 0) continue;
    const askedAt = timeOf(src);
    if (!Number.isFinite(askedAt)) continue;
    for (const mention of mentions) {
      const handle = String(mention ?? "").replace(/^@/, "").toLowerCase();
      if (!handle) continue;
      if (String(src.authorHandle ?? "").toLowerCase() === handle) continue; // self-mention
      let found = null;
      for (let j = i + 1; j < messages.length; j += 1) {
        const cand = messages[j];
        if (String(cand.authorHandle ?? "").toLowerCase() !== handle) continue;
        const at = timeOf(cand);
        if (!Number.isFinite(at) || at < askedAt) continue;
        found = at - askedAt;
        break;
      }
      if (found === null || found > REPLY_WINDOW_MS) unanswered += 1;
      else latencies.push({ from: src.authorHandle ?? "?", to: handle, ms: found });
    }
  }
  const latencyMs = latencies.map((l) => l.ms);

  // -- addressing, acks, status, no-reply, complaints ------------------------------------------
  let addressed = 0;
  let acks = 0;
  let statusReports = 0;
  let bareNoReply = 0;
  let deliveryComplaints = 0;
  const lengths = [];
  for (const m of agentMessages) {
    const text = String(m.text ?? "");
    const hasMentions = Array.isArray(m.mentions) && m.mentions.length > 0;
    if (hasMentions) addressed += 1;
    if (isBareNoReply(text)) {
      bareNoReply += 1;
      continue; // routing metadata, not a message - excluded from length and class counts
    }
    lengths.push(text.length);
    if (isAckOnly(text)) acks += 1;
    else if (!hasMentions && isStatusReport(text)) statusReports += 1;
    if (isDeliveryComplaint(text)) deliveryComplaints += 1;
  }

  // -- near-duplicate posts by one agent -------------------------------------------------------
  let nearDuplicates = 0;
  const duplicateExamples = [];
  for (let i = 0; i < agentMessages.length; i += 1) {
    const m = agentMessages[i];
    const text = String(m.text ?? "");
    if (normalizeText(text).length < 60) continue;
    for (let j = Math.max(0, i - DUPLICATE_LOOKBACK); j < i; j += 1) {
      const prev = agentMessages[j];
      if (prev.authorId !== m.authorId) continue;
      if (normalizeText(prev.text ?? "").length < 60) continue;
      const sim = similarity(prev.text, text);
      if (sim >= DUPLICATE_SIMILARITY) {
        nearDuplicates += 1;
        if (duplicateExamples.length < 3) {
          duplicateExamples.push({ handle: m.authorHandle, similarity: Math.round(sim * 100) / 100 });
        }
        break;
      }
    }
  }

  // -- system-side failures --------------------------------------------------------------------
  let cutoffs = 0;
  let rateLimits = 0;
  let watchdogKills = 0;
  for (const m of messages) {
    const text = String(m.text ?? "");
    if (isChainCutoff(text)) cutoffs += 1;
    if (isRateLimitNotice(text)) rateLimits += 1;
    if (isWatchdogKill(text)) watchdogKills += 1;
  }

  // -- "it's live" and how many were contradicted ----------------------------------------------
  let liveClaims = 0;
  let contradictedLiveClaims = 0;
  for (let i = 0; i < agentMessages.length; i += 1) {
    const m = agentMessages[i];
    if (!isLiveClaim(m.text)) continue;
    liveClaims += 1;
    const claimedPorts = portsIn(m.text);
    const window = agentMessages.slice(i + 1, i + 1 + CONTRADICTION_WINDOW);
    const contradicted = window.some((later) => {
      if (!isLiveContradiction(later.text)) return false;
      const laterPorts = portsIn(later.text);
      if (claimedPorts.length && laterPorts.length) {
        return laterPorts.some((p) => claimedPorts.includes(p));
      }
      return true;
    });
    if (contradicted) contradictedLiveClaims += 1;
  }

  // -- messages before the first file was written ----------------------------------------------
  const firstFile = messagesBeforeFirstFile(messages, hub, agentsById);

  const over120s = latencyMs.filter((ms) => ms > LATE_REPLY_MS).length;

  return {
    id: chat.id,
    title: chat.title,
    archived: Boolean(chat.archived),
    messages: messages.length,
    agentMessages: agentMessages.length,
    latencyMs,
    lengths,
    reply: {
      samples: latencyMs.length,
      medianMs: median(latencyMs),
      p90Ms: percentile(latencyMs, 90),
      over120s,
      over120sShare: share(over120s, latencyMs.length),
      unanswered,
    },
    addressed,
    addressedShare: share(addressed, agentMessages.length),
    counts: {
      acks,
      statusReports,
      nearDuplicates,
      cutoffs,
      bareNoReply,
      deliveryComplaints,
      rateLimits,
      watchdogKills,
    },
    noise: {
      acksAndStatus: acks + statusReports,
      acksAndStatusShare: share(acks + statusReports, agentMessages.length),
    },
    live: { claims: liveClaims, contradicted: contradictedLiveClaims, contradictedShare: share(contradictedLiveClaims, liveClaims) },
    length: { medianChars: median(lengths), p90Chars: percentile(lengths, 90), maxChars: max(lengths) },
    firstFile,
    duplicateExamples,
  };
}

/**
 * How many group messages went by before anyone in this chat wrote a file.
 *
 * Approximate, and the report says so: chat messages carry no turn id, so a hub tool marker is
 * attributed to a chat by time window and participant, not by lineage. An agent writing a file
 * for a different chat at the same moment would be miscounted.
 */
export function messagesBeforeFirstFile(messages, hub, agentsById) {
  if (messages.length === 0) return { messages: null, approximate: true, found: false };
  const participants = new Set(messages.map((m) => m.authorId).filter((id) => id && !NON_AGENT_AUTHORS.has(id)));
  const start = timeOf(messages[0]);
  const endMsg = messages[messages.length - 1];
  const end = timeOf(endMsg);
  if (!Number.isFinite(start)) return { messages: null, approximate: true, found: false };

  let firstWriteAt = null;
  for (const m of hub) {
    if (m.agentKind !== "tool" || !m.tool) continue;
    const owner = (m.channel && m.channel.agentId) || m.authorId;
    if (!participants.has(owner)) continue;
    const at = timeOf(m);
    if (!Number.isFinite(at) || at < start) continue;
    if (Number.isFinite(end) && at > end) continue;
    if (!isWriteTool(m.tool.name, m.tool.detail)) continue;
    firstWriteAt = at;
    break;
  }
  if (firstWriteAt === null) return { messages: null, approximate: true, found: false };
  const before = messages.filter((m) => timeOf(m) < firstWriteAt).length;
  return { messages: before, approximate: true, found: true, at: new Date(firstWriteAt).toISOString() };
}

/** Pool every chat's raw samples so the total row is a real median over all replies, not an
 *  average of per-chat medians. */
export function aggregate(chatReports) {
  const latencyMs = chatReports.flatMap((c) => c.latencyMs);
  const lengths = chatReports.flatMap((c) => c.lengths);
  const sum = (pick) => chatReports.reduce((n, c) => n + (pick(c) || 0), 0);

  const agentMessages = sum((c) => c.agentMessages);
  const addressed = sum((c) => c.addressed);
  const acks = sum((c) => c.counts.acks);
  const statusReports = sum((c) => c.counts.statusReports);
  const over120s = latencyMs.filter((ms) => ms > LATE_REPLY_MS).length;
  const liveClaims = sum((c) => c.live.claims);
  const contradicted = sum((c) => c.live.contradicted);
  const firstFileSamples = chatReports.map((c) => c.firstFile).filter((f) => f && f.found);

  return {
    chats: chatReports.length,
    messages: sum((c) => c.messages),
    agentMessages,
    reply: {
      samples: latencyMs.length,
      medianMs: median(latencyMs),
      p90Ms: percentile(latencyMs, 90),
      over120s,
      over120sShare: share(over120s, latencyMs.length),
      unanswered: sum((c) => c.reply.unanswered),
    },
    addressed,
    addressedShare: share(addressed, agentMessages),
    counts: {
      acks,
      statusReports,
      nearDuplicates: sum((c) => c.counts.nearDuplicates),
      cutoffs: sum((c) => c.counts.cutoffs),
      bareNoReply: sum((c) => c.counts.bareNoReply),
      deliveryComplaints: sum((c) => c.counts.deliveryComplaints),
      rateLimits: sum((c) => c.counts.rateLimits),
      watchdogKills: sum((c) => c.counts.watchdogKills),
    },
    noise: {
      acksAndStatus: acks + statusReports,
      acksAndStatusShare: share(acks + statusReports, agentMessages),
    },
    live: { claims: liveClaims, contradicted, contradictedShare: share(contradicted, liveClaims) },
    length: { medianChars: median(lengths), p90Chars: percentile(lengths, 90), maxChars: max(lengths) },
    firstFile: {
      chatsMeasured: firstFileSamples.length,
      medianMessages: median(firstFileSamples.map((f) => f.messages)),
      maxMessages: max(firstFileSamples.map((f) => f.messages)),
      approximate: true,
    },
  };
}

/** Full report from a raw state object. Never throws on a shape it does not recognise. */
export function buildReport(rawState, { source = null } = {}) {
  const { chats, hub, agentsById } = normalizeState(rawState);
  const perChat = chats
    .map((chat) => analyzeChat(chat, { hub, agentsById }))
    .sort((a, b) => b.messages - a.messages);
  const totals = aggregate(perChat);
  return {
    generatedAt: new Date().toISOString(),
    source,
    agents: [...agentsById.values()].map((a) => ({ id: a.id, handle: a.handle, provider: a.provider })),
    chats: perChat.map(publicChat),
    totals,
    targets: evaluateTargets(totals),
  };
}

/** Drop the raw sample arrays before anything is printed or written to a baseline. */
export function publicChat(chat) {
  const { latencyMs, lengths, ...rest } = chat;
  return rest;
}

// ---------------------------------------------------------------------------------------------
// targets and baselines
// ---------------------------------------------------------------------------------------------

/** The v1.5 targets from ROADMAP.md section 10. A target with no data to judge it is "n/a",
 *  not a pass - an empty chat must not report five green ticks. */
export function evaluateTargets(totals) {
  const t = [];
  const push = (name, value, pass, detail) => t.push({ name, value, pass, detail });

  const p90 = totals.reply.p90Ms;
  push(
    "p90 reply < 90s",
    p90 === null ? null : Math.round(p90 / 1000),
    p90 === null ? null : p90 < 90_000,
    p90 === null ? "no @mention replies in range" : `${Math.round(p90 / 1000)}s`,
  );

  const addr = totals.addressedShare;
  push("addressed >= 70%", addr, addr === null ? null : addr >= 70, addr === null ? "no agent messages" : `${addr}%`);

  push("reply-chain cutoffs = 0", totals.counts.cutoffs, totals.counts.cutoffs === 0, String(totals.counts.cutoffs));

  push(
    "contradicted live claims = 0",
    totals.live.contradicted,
    totals.live.contradicted === 0,
    `${totals.live.contradicted} of ${totals.live.claims} claims`,
  );

  const noise = totals.noise.acksAndStatusShare;
  push(
    "acks + status < 10%",
    noise,
    noise === null ? null : noise < 10,
    noise === null ? "no agent messages" : `${noise}%`,
  );

  return t;
}

/** Which way is better for each number the delta column knows about. */
export const METRIC_DIRECTION = {
  "reply.medianMs": "lower",
  "reply.p90Ms": "lower",
  "reply.over120s": "lower",
  "reply.unanswered": "lower",
  addressedShare: "higher",
  "counts.acks": "lower",
  "counts.statusReports": "lower",
  "counts.nearDuplicates": "lower",
  "counts.cutoffs": "lower",
  "counts.bareNoReply": "lower",
  "counts.deliveryComplaints": "lower",
  "counts.rateLimits": "lower",
  "counts.watchdogKills": "lower",
  "noise.acksAndStatusShare": "lower",
  "live.contradicted": "lower",
  "length.medianChars": "lower",
  "length.p90Chars": "lower",
  "length.maxChars": "lower",
  "firstFile.medianMessages": "lower",
};

function at(object, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), object);
}

/**
 * Compare two totals blocks. A "regression" is a move in the wrong direction on a metric whose
 * direction we know. Rates are compared with a small dead zone so a 0.1% wobble on a big corpus
 * is not reported as a regression.
 */
export function compareBaseline(currentTotals, baselineTotals) {
  const rows = [];
  for (const [path, direction] of Object.entries(METRIC_DIRECTION)) {
    const now = at(currentTotals, path);
    const was = baselineTotals ? at(baselineTotals, path) : undefined;
    if (typeof now !== "number" || typeof was !== "number") {
      rows.push({ metric: path, now: now ?? null, was: was ?? null, delta: null, regression: false, direction });
      continue;
    }
    const delta = Math.round((now - was) * 1000) / 1000;
    const better = direction === "lower" ? delta < 0 : delta > 0;
    const worse = direction === "lower" ? delta > 0 : delta < 0;
    rows.push({ metric: path, now, was, delta, better, regression: worse && Math.abs(delta) > 1e-9, direction });
  }
  return rows;
}
