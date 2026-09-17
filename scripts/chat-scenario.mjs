#!/usr/bin/env node
/**
 * chat-scenario - drive a real four-agent conversation and measure it.
 *
 * This is how every step of ROADMAP.md gets verified: change the routing, run this, and see
 * whether `scripts/chat-metrics.mjs` moves. It starts a throwaway Solace server of its own on
 * spare ports, against a temp workspace, creates four agents on OpenCode's FREE models so the
 * run costs nothing, sends one scripted prompt, waits for the room to go quiet, then runs the
 * metrics over the state the run produced and prints the table.
 *
 * It deliberately does NOT touch the operator's instances: it binds its own port (4491 by
 * default, never 4310/4320), sets SOLACE_WORKSPACE_ROOT to a fresh temp directory, and starts no
 * web dev server at all - nothing here needs a browser. The instance is killed and the temp
 * directory removed on exit, including on Ctrl-C.
 *
 * Usage
 *   npm run build                                   # the server runs from dist
 *   node scripts/chat-scenario.mjs
 *   node scripts/chat-scenario.mjs --model opencode/mimo-v2.5-free --agents 4 --quiet-for 90
 *   node scripts/chat-scenario.mjs --prompt "..." --keep      # keep the workspace for digging
 *   node scripts/chat-scenario.mjs --baseline scenario-baseline.json
 *
 * `opencode models | grep free` lists the models that cost nothing; mimo-v2.5-free is the one
 * known to work here.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

/** Ports the operator's two live instances use. Binding one of these would hijack a running
 *  session, so the runner refuses rather than "just trying". */
const FORBIDDEN_PORTS = new Set([4310, 4320, 5173, 5183]);

const DEFAULTS = {
  port: 4491,
  model: "opencode/mimo-v2.5-free",
  agents: 4,
  quietFor: 90, // seconds of no new message before the room counts as quiet
  timeout: 900, // hard ceiling for the whole conversation, seconds
  prompt:
    "Four of you are in this room. Agree, in the chat, who does which of these four pieces of a " +
    "one-page site about a fictional tea shop: (1) the headline and one paragraph of copy, " +
    "(2) the colour palette as three hex codes, (3) the list of sections in order, " +
    "(4) one sentence of alt text for the hero image. " +
    "Do not write any files. Address the agent you are talking to by @handle. " +
    "When your own piece is agreed and posted, say so once and stop.",
};

function parseArgs(argv) {
  const o = { ...DEFAULTS, keep: false, json: false, baseline: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--keep") o.keep = true;
    else if (a === "--json") o.json = true;
    else if (a === "--port") o.port = Number(next());
    else if (a === "--model") o.model = next();
    else if (a === "--agents") o.agents = Number(next());
    else if (a === "--quiet-for") o.quietFor = Number(next());
    else if (a === "--timeout") o.timeout = Number(next());
    else if (a === "--prompt") o.prompt = next();
    else if (a === "--baseline") o.baseline = next();
    else {
      process.stderr.write(`chat-scenario: unknown argument ${a}\n`);
      process.exit(2);
    }
  }
  return o;
}

const log = (...parts) => process.stderr.write(`[scenario] ${parts.join(" ")}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(port, method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 300)}`);
  return parsed;
}

async function waitForServer(port, child, seconds = 60) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early with code ${child.exitCode}`);
    try {
      await api(port, "GET", "/api/agents");
      return;
    } catch {
      await sleep(400);
    }
  }
  throw new Error(`server did not come up on :${port} within ${seconds}s`);
}

/** Free OpenCode models only. A paid model would bill the operator for a harness run, so the
 *  runner refuses one rather than quietly spending money. */
function assertFreeModel(model) {
  if (!/^opencode\//.test(model) || !/-free$/.test(model)) {
    throw new Error(
      `refusing to run on "${model}": this harness only runs OpenCode free models (name must be ` +
        `opencode/...-free). Run \`opencode models | grep free\` to see them.`,
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      [
        "chat-scenario - scripted four-agent conversation, then the metrics",
        "",
        `  --port <n>        default ${DEFAULTS.port} (never 4310/4320/5173/5183)`,
        `  --model <id>      default ${DEFAULTS.model}; must be an OpenCode free model`,
        `  --agents <n>      default ${DEFAULTS.agents}`,
        `  --quiet-for <s>   seconds of silence that end the run (default ${DEFAULTS.quietFor})`,
        `  --timeout <s>     hard ceiling for the conversation (default ${DEFAULTS.timeout})`,
        "  --prompt <text>   the one scripted operator message",
        "  --baseline <f>    passed through to chat-metrics",
        "  --keep            keep the temp workspace and print its path",
        "  --json            metrics as JSON",
        "",
      ].join("\n"),
    );
    return 0;
  }

  if (FORBIDDEN_PORTS.has(opts.port)) {
    throw new Error(`port ${opts.port} belongs to a live Solace instance - pick a spare one (e.g. 4491)`);
  }
  assertFreeModel(opts.model);

  const dist = path.join(REPO, "packages", "server", "dist", "index.js");
  if (!existsSync(dist)) throw new Error(`no server build at ${dist} - run \`npm run build\` first`);

  const workspace = mkdtempSync(path.join(tmpdir(), "solace-scenario-"));
  log(`workspace ${workspace}`);
  log(`starting server on :${opts.port}`);

  const child = spawn(process.execPath, [dist], {
    cwd: REPO,
    env: { ...process.env, PORT: String(opts.port), SOLACE_WORKSPACE_ROOT: workspace },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  const keepTail = (chunk) => {
    serverLog.push(String(chunk));
    if (serverLog.length > 200) serverLog.splice(0, serverLog.length - 200);
  };
  child.stdout.on("data", keepTail);
  child.stderr.on("data", keepTail);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (child.exitCode === null) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    if (!opts.keep) {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch (err) {
        log(`could not remove ${workspace}: ${err.message}`);
      }
    } else {
      log(`kept workspace: ${workspace}`);
    }
  };
  process.on("exit", cleanup);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      cleanup();
      process.exit(130);
    });
  }

  try {
    await waitForServer(opts.port, child);
    log("server up");

    // -- the room ------------------------------------------------------------------------------
    const project = await api(opts.port, "POST", "/api/projects", { name: "scenario" });
    const cwd = project.path ?? path.join(workspace, "scenario");
    const chat = await api(opts.port, "POST", "/api/chats", { title: "Scenario run" });

    const handles = ["Ava", "Ben", "Cleo", "Dev", "Eli", "Fay"].slice(0, Math.max(1, opts.agents));
    for (const handle of handles) {
      await api(opts.port, "POST", "/api/agents", {
        handle,
        provider: "opencode",
        cwd,
        trustLevel: "plan", // read-only: a measurement run has no business writing to disk
        model: opts.model,
      });
      log(`agent ${handle} on ${opts.model}`);
    }

    const prompt = `${handles.map((h) => `@${h}`).join(" ")} ${opts.prompt}`;
    await api(opts.port, "POST", `/api/chats/${chat.id}/messages`, { text: prompt });
    log("prompt sent; waiting for the room to go quiet");

    // -- wait for quiet ------------------------------------------------------------------------
    const started = Date.now();
    let lastCount = 0;
    let lastChange = Date.now();
    while (true) {
      await sleep(5000);
      if (child.exitCode !== null) throw new Error(`server died mid-run (code ${child.exitCode})`);
      let history = [];
      try {
        history = await api(opts.port, "GET", `/api/chats/${chat.id}/history`);
      } catch (err) {
        log(`history poll failed (${err.message}); retrying`);
        continue;
      }
      const count = Array.isArray(history) ? history.length : (history?.messages?.length ?? 0);
      if (count !== lastCount) {
        lastCount = count;
        lastChange = Date.now();
        log(`${count} messages`);
      }
      const quietFor = (Date.now() - lastChange) / 1000;
      const elapsed = (Date.now() - started) / 1000;
      if (count > 1 && quietFor >= opts.quietFor) {
        log(`quiet for ${Math.round(quietFor)}s after ${Math.round(elapsed)}s - done`);
        break;
      }
      if (elapsed >= opts.timeout) {
        log(`hit the ${opts.timeout}s ceiling with ${count} messages - measuring what there is`);
        break;
      }
    }

    // -- let the server flush its state, then stop it -------------------------------------------
    await sleep(3000);
    child.kill();
    for (let i = 0; i < 40 && child.exitCode === null; i += 1) await sleep(250);

    const statePath = path.join(workspace, ".solace-state.json");
    if (!existsSync(statePath)) {
      log(`no state written at ${statePath}; last server output:`);
      log(serverLog.slice(-20).join(""));
    }

    // -- measure --------------------------------------------------------------------------------
    const args = [path.join(HERE, "chat-metrics.mjs"), "--state", statePath];
    if (opts.json) args.push("--json");
    if (opts.baseline) args.push("--baseline", opts.baseline);
    const metrics = spawn(process.execPath, args, { stdio: "inherit" });
    const code = await new Promise((resolve) => metrics.on("exit", resolve));

    if (opts.keep) log(`state file: ${statePath}`);
    else {
      // Copy nothing out: the table is already printed. Say so plainly so nobody goes looking.
      log("temp workspace is about to be removed; re-run with --keep to inspect the state file");
    }
    return code === 2 ? 1 : (code ?? 0);
  } finally {
    cleanup();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`chat-scenario: ${err.message}\n`);
    process.exitCode = 1;
  },
);
