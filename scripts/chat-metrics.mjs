#!/usr/bin/env node
/**
 * chat-metrics - the measurement harness for ROADMAP.md.
 *
 * Reads a Solace workspace's persisted state and reports, per chat and in total, the numbers the
 * roadmap is judged by: reply latency to an @mention, how much of the chat is addressed to
 * anybody, how much of it is acknowledgement and unasked status, the failure counts, "it's live"
 * claims and how many were contradicted, message length, and how many messages went by before a
 * file was written.
 *
 * Usage
 *   node scripts/chat-metrics.mjs
 *   node scripts/chat-metrics.mjs --state <path to .solace-state.json or workspace dir>
 *   node scripts/chat-metrics.mjs --json
 *   node scripts/chat-metrics.mjs --baseline metrics-baseline.json          # compare, or create
 *   node scripts/chat-metrics.mjs --baseline metrics-baseline.json --save   # overwrite it
 *
 * Workspace resolution: --state, else $SOLACE_WORKSPACE_ROOT, else ~/Desktop/solace-workspace-dev.
 *
 * Read-only. It never writes anything except the baseline file you name.
 *
 * Several metrics are heuristics over free-form English and are printed with a leading "~".
 * See the notes printed under the table; do not quote them as exact.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { buildReport, compareBaseline } from "./lib/chat-metrics-core.mjs";

const DEFAULT_WORKSPACE = path.join(homedir(), "Desktop", "solace-workspace-dev");
const STATE_FILE = ".solace-state.json";

function parseArgs(argv) {
  const opts = { json: false, state: null, baseline: null, save: false, chats: true, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") opts.json = true;
    else if (a === "--save") opts.save = true;
    else if (a === "--no-chats") opts.chats = false;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--state") opts.state = argv[++i];
    else if (a === "--baseline") opts.baseline = argv[++i];
    else if (a.startsWith("--state=")) opts.state = a.slice(8);
    else if (a.startsWith("--baseline=")) opts.baseline = a.slice(11);
    else {
      process.stderr.write(`chat-metrics: unknown argument ${a}\n`);
      process.exit(2);
    }
  }
  return opts;
}

/** A --state pointing at a directory means "the state file inside this workspace". */
function resolveStatePath(explicit) {
  const base = explicit || process.env.SOLACE_WORKSPACE_ROOT || DEFAULT_WORKSPACE;
  try {
    if (existsSync(base) && statSync(base).isDirectory()) return path.join(base, STATE_FILE);
  } catch {
    /* fall through to treating it as a file path */
  }
  return base;
}

/** Never throws. A missing or corrupt state file is a result, not a crash: this script runs at
 *  the end of scripted scenarios where the instance may have died mid-write. */
function loadState(file) {
  if (!existsSync(file)) return { ok: false, reason: `no state file at ${file}`, state: {} };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return { ok: false, reason: `could not read ${file}: ${err.message}`, state: {} };
  }
  if (!text.trim()) return { ok: false, reason: `state file is empty: ${file}`, state: {} };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, reason: `state file is not an object: ${file}`, state: {} };
    }
    return { ok: true, reason: null, state: parsed };
  } catch (err) {
    return { ok: false, reason: `state file is not valid JSON (${err.message}): ${file}`, state: {} };
  }
}

// -- formatting --------------------------------------------------------------------------------

const DASH = "-";

function secs(ms) {
  if (ms === null || ms === undefined) return DASH;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 90_000) return `${(ms / 1000).toFixed(0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s ? ` ${s}s` : ""}`;
}

function pct(v) {
  return v === null || v === undefined ? DASH : `${v}%`;
}

function num(v) {
  return v === null || v === undefined ? DASH : String(v);
}

function table(rows, headers) {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? "").length)));
  const line = (r) =>
    r.map((cell, i) => (i === 0 ? String(cell ?? "").padEnd(widths[i]) : String(cell ?? "").padStart(widths[i]))).join("  ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

function metricRows(t) {
  return [
    ["reply latency, median", secs(t.reply.medianMs)],
    ["reply latency, p90", secs(t.reply.p90Ms)],
    ["replies over 120s", `${t.reply.over120s} of ${t.reply.samples} (${pct(t.reply.over120sShare)})`],
    ["@mentions never answered", num(t.reply.unanswered)],
    ["agent messages addressed", `${t.addressed} of ${t.agentMessages} (${pct(t.addressedShare)})`],
    ["~acknowledgement-only", num(t.counts.acks)],
    ["~unaddressed status reports", num(t.counts.statusReports)],
    ["~near-duplicate posts", num(t.counts.nearDuplicates)],
    ["reply-chain cutoffs", num(t.counts.cutoffs)],
    ["bare [no-reply]", num(t.counts.bareNoReply)],
    ["~didn't receive / truncated", num(t.counts.deliveryComplaints)],
    ["rate-limit hits", num(t.counts.rateLimits)],
    ["idle-watchdog kills", num(t.counts.watchdogKills)],
    ["~'it's live' claims", num(t.live.claims)],
    ["~contradicted within 15 msgs", `${t.live.contradicted} (${pct(t.live.contradictedShare)})`],
    ["message length median / p90 / max", `${num(t.length.medianChars)} / ${num(t.length.p90Chars)} / ${num(t.length.maxChars)}`],
    [
      "~messages before first file written",
      t.firstFile.chatsMeasured
        ? `median ${num(t.firstFile.medianMessages)}, max ${num(t.firstFile.maxMessages)} (${t.firstFile.chatsMeasured} chats)`
        : DASH,
    ],
  ];
}

function printHuman(report, { statusLine, baselineRows, baselineFile, showChats }) {
  const out = [];
  out.push("");
  out.push(`Solace chat metrics  -  ${report.source ?? "(no source)"}`);
  if (statusLine) out.push(statusLine);
  const t = report.totals;
  out.push(`${t.chats} chats  ${t.messages} group messages  ${t.agentMessages} from agents`);
  out.push("");
  out.push(table(metricRows(t), ["metric", "value"]));

  if (baselineRows) {
    out.push("");
    out.push(`vs baseline ${baselineFile}`);
    const rows = baselineRows
      .filter((r) => r.delta !== null && r.delta !== 0)
      .map((r) => [
        r.metric,
        String(r.was),
        String(r.now),
        `${r.delta > 0 ? "+" : ""}${r.delta}`,
        r.regression ? "REGRESSION" : r.better ? "better" : "",
      ]);
    out.push(rows.length ? table(rows, ["metric", "was", "now", "delta", ""]) : "  (no numeric change)");
    const regressions = baselineRows.filter((r) => r.regression).length;
    out.push(regressions ? `  ${regressions} metric(s) moved the wrong way.` : "  No regressions.");
  }

  out.push("");
  out.push("targets (ROADMAP v1.5)");
  out.push(
    table(
      report.targets.map((x) => [x.name, x.detail ?? DASH, x.pass === null ? "n/a" : x.pass ? "PASS" : "FAIL"]),
      ["target", "value", ""],
    ),
  );

  if (showChats && report.chats.length) {
    out.push("");
    out.push("per chat");
    out.push(
      table(
        report.chats.map((c) => [
          `${c.title}${c.archived ? " (archived)" : ""}`,
          String(c.agentMessages),
          secs(c.reply.medianMs),
          secs(c.reply.p90Ms),
          pct(c.addressedShare),
          String(c.counts.acks + c.counts.statusReports),
          String(c.counts.cutoffs),
          `${c.live.contradicted}/${c.live.claims}`,
          num(c.length.medianChars),
          c.firstFile.found ? num(c.firstFile.messages) : DASH,
        ]),
        ["chat", "agentMsg", "med", "p90", "addr", "~noise", "cut", "~live x/n", "medLen", "~pre-file"],
      ),
    );
  }

  out.push("");
  out.push("Rows marked ~ are text heuristics over free-form model output: acks, status reports,");
  out.push("near-duplicates, delivery complaints, live claims and pre-first-file counts are");
  out.push("APPROXIMATE. Pre-first-file is attributed to a chat by time window, not by turn id,");
  out.push("because chat messages carry none. Use them to see a number move, not as exact facts.");
  out.push("");
  return out.join("\n");
}

// -- main --------------------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      [
        "chat-metrics - Solace group-chat measurement harness",
        "",
        "  --state <path>      workspace directory or .solace-state.json (default: $SOLACE_WORKSPACE_ROOT",
        `                      or ${DEFAULT_WORKSPACE})`,
        "  --json              machine-readable output",
        "  --baseline <file>   compare against a saved snapshot; creates it if absent",
        "  --save              overwrite the baseline with this run",
        "  --no-chats          totals only",
        "",
      ].join("\n"),
    );
    return 0;
  }

  const file = resolveStatePath(opts.state);
  const loaded = loadState(file);
  const report = buildReport(loaded.state, { source: file });
  report.stateOk = loaded.ok;
  if (!loaded.ok) report.stateProblem = loaded.reason;

  let baselineRows = null;
  let baselineWritten = false;
  if (opts.baseline) {
    const exists = existsSync(opts.baseline);
    if (exists && !opts.save) {
      try {
        const prev = JSON.parse(readFileSync(opts.baseline, "utf8"));
        baselineRows = compareBaseline(report.totals, prev.totals ?? prev);
      } catch (err) {
        process.stderr.write(`chat-metrics: could not read baseline ${opts.baseline}: ${err.message}\n`);
      }
    }
    if (!exists || opts.save) {
      try {
        writeFileSync(opts.baseline, `${JSON.stringify({ generatedAt: report.generatedAt, source: file, totals: report.totals }, null, 2)}\n`);
        baselineWritten = true;
      } catch (err) {
        process.stderr.write(`chat-metrics: could not write baseline ${opts.baseline}: ${err.message}\n`);
      }
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...report, baseline: baselineRows, baselineWritten }, null, 2)}\n`);
  } else {
    const statusLine = !loaded.ok
      ? `WARNING: ${loaded.reason} - reporting an empty result.`
      : baselineWritten
        ? `baseline written to ${opts.baseline}`
        : null;
    process.stdout.write(
      printHuman(report, { statusLine, baselineRows, baselineFile: opts.baseline, showChats: opts.chats }),
    );
  }

  // Exit code: 0 when every judgeable target passes and nothing regressed, 1 otherwise, so this
  // can gate a scenario run. A missing state file is a 2 - that is an operator error, not a fail.
  if (!loaded.ok) return 2;
  const failed = report.targets.some((x) => x.pass === false);
  const regressed = baselineRows ? baselineRows.some((r) => r.regression) : false;
  return failed || regressed ? 1 : 0;
}

process.exitCode = main();
