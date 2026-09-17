/**
 * Seeds the dev instance so it opens ready to work instead of empty.
 *
 * The stable instance deliberately starts with nothing - a stranger who clones the public repo
 * must not inherit somebody else's agents. This is the opposite situation: the dev instance is
 * one person's workbench, and starting it should not mean re-adding the same three agents and
 * re-linking the same project every time the workspace is reset.
 *
 * It is CONSERVATIVE by design. It only ever adds what is missing, keyed by handle and by path,
 * and it never edits or deletes anything already there - so running it twice is a no-op and
 * running it against a workspace with real work in it cannot destroy that work.
 *
 * Run: node scripts/seed-dev-state.mjs
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const WORKSPACE =
  process.env.SOLACE_WORKSPACE_ROOT ?? join(homedir(), "Desktop", "solace-workspace-dev");
const STATE = join(WORKSPACE, ".solace-state.json");

/** The project this instance exists to work on: Solace's own public repo. */
const MAIN_REPO =
  process.env.SOLACE_DEV_MAIN_REPO ?? join(homedir(), "GitHub", "solace-agentic-chats");

/**
 * The three the operator actually uses, mirrored from the stable instance including model and
 * effort. Trust is bypassPermissions to match how they are really run - stated here rather than
 * quietly chosen, because it is the most permissive level and it should be visible in the seed
 * rather than discovered later in the UI.
 */
const AGENTS = [
  { handle: "claude", provider: "claude-code", model: "sonnet" },
  { handle: "codex", provider: "codex-cli", model: "gpt-5.5" },
  { handle: "copilot", provider: "copilot-cli", model: "auto", effort: "medium" },
];

const CONNECTED = ["claude-code", "codex-cli", "copilot-cli"];

/** Same alphabet nanoid uses here, so seeded ids are indistinguishable from minted ones. */
const ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
const id = (n = 21) =>
  Array.from({ length: n }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");

function write(path, data) {
  // Temp + rename, matching core/persistence.ts: a crash mid-write must not leave a truncated
  // state file, which is unrecoverable.
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.seed-tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
state.agents ??= [];
state.chats ??= [];
state.projects ??= [];
state.connectedCliProviders ??= [];

const added = [];

for (const p of CONNECTED) {
  if (!state.connectedCliProviders.includes(p)) {
    state.connectedCliProviders.push(p);
    added.push(`connected ${p}`);
  }
}

if (!existsSync(MAIN_REPO)) {
  console.error(`! ${MAIN_REPO} does not exist - set SOLACE_DEV_MAIN_REPO and re-run.`);
  process.exit(1);
}

let project = state.projects.find((p) => p.path === MAIN_REPO);
if (!project) {
  project = { id: id(), name: "solace-agentic-chats", path: MAIN_REPO, createdAt: new Date().toISOString() };
  state.projects.push(project);
  added.push(`project ${project.name} -> ${MAIN_REPO}`);
}

let chat = state.chats.find((c) => c.projectId === project.id);
if (!chat) {
  chat = {
    id: id(),
    title: "Solace dev",
    createdAt: new Date().toISOString(),
    projectId: project.id,
  };
  state.chats.push(chat);
  added.push(`chat "${chat.title}" in ${project.name}`);
}

// The agents work in MAIN_REPO, but the living context lives in this dev repo - it describes a
// local dev setup and has no business being committed to a public MIT repo. So a gitignored
// pointer is dropped in the working folder, which is what core/projectContext.ts looks for.
// Never overwritten: if a real context file is already there, it is somebody's and it wins.
const bridge = join(MAIN_REPO, ".solace-context.md");
if (!existsSync(bridge) && !existsSync(join(MAIN_REPO, "CONTEXT.md"))) {
  const devContext = join(process.cwd(), "CONTEXT.md");
  writeFileSync(
    bridge,
    `# Solace — working context

` +
      `You are working in the public repo (\`${MAIN_REPO}\`) from the DEV instance.

` +
      `The living context for this work is maintained at:

    ${devContext}

` +
      `Read it before you start, and update it in the same turn that you make any change that
` +
      `contradicts it. This file is gitignored here and is not part of the public project.
`,
  );
  added.push(`context pointer -> ${bridge}`);
}

for (const a of AGENTS) {
  if (state.agents.some((x) => x.handle.toLowerCase() === a.handle.toLowerCase())) continue;
  state.agents.push({
    id: id(),
    handle: a.handle,
    provider: a.provider,
    // Every seeded agent works IN the repo, so all three share one working directory and see
    // each other's edits. That is the point of this instance.
    cwd: MAIN_REPO,
    trustLevel: "bypassPermissions",
    model: a.model,
    ...(a.effort ? { effort: a.effort } : {}),
    authMode: "cli",
  });
  added.push(`agent @${a.handle} (${a.provider})`);
}

if (added.length === 0) {
  console.log("Nothing to do - already seeded.");
} else {
  write(STATE, state);
  console.log(`Seeded ${STATE}:`);
  for (const line of added) console.log(`  + ${line}`);
}
