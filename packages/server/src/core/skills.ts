import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnCli } from "./spawnCli";
import { WORKSPACE_ROOT, ensureWorkspaceRoot, listProjects, type ProjectInfo } from "./workspace";

/**
 * Claude Code's skill format is filesystem-based: a directory containing a SKILL.md with
 * simple `---` YAML frontmatter (name/description) plus an optional references/ subfolder.
 * "Installing" a skill is literally copying that directory into a project's own
 * `.claude/skills/<name>/`, which is where Claude Code already looks for project-scoped
 * skills - so there is nothing to register, index or restart.
 */
export const SKILLS_SOURCE_DIR = process.env.SOLACE_SKILLS_DIR ?? join(homedir(), ".claude", "skills");

/** Where imported skill repos are shallow-cloned, kept inside the workspace root next to
 * the other solace dotfiles rather than anywhere inside the app's own git repo. */
const SKILL_REPOS_DIR = join(WORKSPACE_ROOT, ".solace-skill-repos");

export interface SkillInfo {
  name: string;
  description: string;
  sourcePath: string;
}

/**
 * Deliberately hand-rolled rather than pulling in a YAML dependency: the only thing that
 * needs parsing here is the `name`/`description` pair out of a `---`-delimited frontmatter
 * block. It does handle the shapes that actually occur in the wild - single/double quoted
 * scalars (descriptions routinely embed both commas and double quotes) and folded/literal
 * block scalars (`>-`, `|`) - and ignores everything else.
 */
function parseFrontmatter(raw: string): Record<string, string> {
  const normalized = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return {};
  const lines = normalized.slice(4, end).split("\n");

  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();

    if (value === ">" || value === ">-" || value === "|" || value === "|-") {
      // Block scalar: take the following more-indented lines as the value.
      const folded = value.startsWith(">");
      const block: string[] = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === "" || /^\s+/.test(lines[i + 1]))) {
        block.push(lines[++i].trim());
      }
      value = block.join(folded ? " " : "\n").trim();
    } else if (
      (value.startsWith("'") && value.endsWith("'") && value.length > 1) ||
      (value.startsWith('"') && value.endsWith('"') && value.length > 1)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      // YAML escapes an embedded single quote by doubling it.
      if (quote === "'") value = value.replace(/''/g, "'");
    }
    out[key] = value;
  }
  return out;
}

/** A skill's `name` ends up as a bare path segment - joined onto a project's
 * `.claude/skills/<name>/` in installSkill(), and onto every project path again in the
 * install-state check in index.ts. Built-in skills' names are trustworthy (they're this
 * user's own files), but importSkillsFromRepo() clones arbitrary git repos, and a SKILL.md's
 * `name:` frontmatter field is attacker-controlled content from that repo, not a filesystem
 * path Node has already validated - a name like "../../../../some/path" would make
 * `join(destRoot, name)` write outside .claude/skills entirely. Only trust a name that looks
 * like a real skill slug; anything else falls back to the actual (safe, filesystem-derived)
 * directory name instead. */
function sanitizeSkillName(name: string, fallback: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : fallback;
}

/** Scans a directory for immediate subdirectories containing a SKILL.md, returning one
 * entry per skill directory found. */
export function listAvailableSkills(sourceDir: string = SKILLS_SOURCE_DIR): SkillInfo[] {
  if (!existsSync(sourceDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(sourceDir);
  } catch {
    return [];
  }

  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    const dir = join(sourceDir, entry);
    const skillFile = join(dir, "SKILL.md");
    try {
      // A dangling junction/symlink makes statSync throw - skip it rather than 500 the
      // whole listing (same hazard listProjects() guards against in workspace.ts).
      if (!statSync(dir).isDirectory()) continue;
      if (!existsSync(skillFile)) continue;
      const front = parseFrontmatter(readFileSync(skillFile, "utf-8"));
      skills.push({
        name: sanitizeSkillName(front.name || entry, entry),
        description: front.description || "",
        sourcePath: dir,
      });
    } catch {
      continue;
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Copies a skill directory into `<projectPath>/.claude/skills/<name>/`. An already-present
 * destination is reported back rather than thrown - re-clicking install on a skill a project
 * already has is a no-op, not an error.
 */
export function installSkill(sourcePath: string, projectPath: string): { alreadyInstalled: boolean } {
  if (!existsSync(sourcePath)) throw new Error(`Skill not found at ${sourcePath}`);
  if (!existsSync(projectPath)) throw new Error(`Project not found at ${projectPath}`);

  const front = existsSync(join(sourcePath, "SKILL.md"))
    ? parseFrontmatter(readFileSync(join(sourcePath, "SKILL.md"), "utf-8"))
    : {};
  const fallbackName = sourcePath.split(/[\\/]/).filter(Boolean).pop()!;
  const name = sanitizeSkillName(front.name || fallbackName, fallbackName);

  const destRoot = join(projectPath, ".claude", "skills");
  const dest = join(destRoot, name);
  if (existsSync(dest)) return { alreadyInstalled: true };

  mkdirSync(destRoot, { recursive: true });
  cpSync(sourcePath, dest, { recursive: true });
  return { alreadyInstalled: false };
}

function slugForRepo(repoUrl: string): string {
  const trimmed = repoUrl.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const last = trimmed.split(/[\\/:]/).filter(Boolean).pop() ?? "repo";
  const slug = last.replace(/[^a-zA-Z0-9._-]/g, "-");
  return slug || "repo";
}

/**
 * Shallow-clones a git repo into the workspace's `.solace-skill-repos/<slug>` and scans it
 * for skill directories, so anything SKILL.md-shaped inside becomes installable exactly like
 * a built-in skill. An already-cloned destination is just re-scanned - keeping this simple
 * and offline-safe rather than trying to refresh.
 */
export async function importSkillsFromRepo(repoUrl: string): Promise<SkillInfo[]> {
  const url = repoUrl.trim();
  if (!url) throw new Error("Repo URL is required");
  // A leading `-` would otherwise be read by git as a flag rather than a URL.
  if (url.startsWith("-")) throw new Error("Invalid repo URL");

  ensureWorkspaceRoot();
  mkdirSync(SKILL_REPOS_DIR, { recursive: true });
  const dest = join(SKILL_REPOS_DIR, slugForRepo(url));

  // A destination can exist without a real clone having finished - the clone was
  // interrupted (network drop, server restart) partway through, after mkdir/checkout had
  // already created files. Left as-is, every future import attempt for this URL would see
  // "already exists", skip cloning entirely, scan a broken directory, and report a
  // misleading "cloned fine, but no skills found" with no way to retry short of a user
  // manually deleting the folder outside the app. A real clone always leaves a `.git` -
  // treat its absence as "not actually cloned" and start over.
  if (existsSync(dest) && !existsSync(join(dest, ".git"))) {
    rmSync(dest, { recursive: true, force: true });
  }

  if (!existsSync(dest)) {
    await new Promise<void>((resolve, reject) => {
      // spawnCli (cross-spawn) is what makes this safe on Windows: args are quoted with the
      // real Windows argv rules rather than naively joined into a cmd.exe string.
      const child = spawnCli("git", ["clone", "--depth", "1", "--", url, dest], { stdio: "pipe" });
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (err) => reject(new Error(`git clone failed: ${err.message}`)));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git clone failed (exit ${code}): ${stderr.trim().slice(0, 500)}`));
      });
    });
  }

  // A repo can hold its skills either at the top level or under a `skills/` folder.
  const top = listAvailableSkills(dest);
  const nested = listAvailableSkills(join(dest, "skills"));
  const byPath = new Map<string, SkillInfo>();
  for (const skill of [...top, ...nested]) byPath.set(skill.sourcePath, skill);
  return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Tracks which repos have been imported, alongside .solace-credentials.json in the
 * workspace root, so their skills reappear in the listing after a server restart. */
function repoTrackingPath(): string {
  return join(WORKSPACE_ROOT, ".solace-skill-repos.json");
}

export function listImportedRepos(): string[] {
  const path = repoTrackingPath();
  if (!existsSync(path)) return [];
  try {
    // Strip a UTF-8 BOM - this file is plain JSON we write ourselves, but it sits in a
    // user-visible workspace folder and anything that hand-edits it on Windows (PowerShell's
    // Out-File, Notepad) will happily add one, which JSON.parse rejects outright.
    const parsed = JSON.parse(readFileSync(path, "utf-8").replace(/^﻿/, ""));
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}

export function rememberImportedRepo(repoUrl: string) {
  const all = listImportedRepos();
  if (all.includes(repoUrl)) return;
  ensureWorkspaceRoot();
  writeFileSync(repoTrackingPath(), JSON.stringify([...all, repoUrl]), "utf-8");
  // A freshly-imported repo's skills need to be installable immediately, not up to
  // SKILLS_CACHE_MS later - invalidate rather than wait out the cache.
  cachedSkills = null;
}

let cachedSkills: { at: number; skills: SkillInfo[] } | null = null;
const SKILLS_CACHE_MS = 10_000;

/** Every skill a project could install: the built-in source dir plus each imported repo.
 * Scanning every SKILL.md (76+ built-in, plus every imported repo, each read+parsed
 * synchronously) on every single GET /api/skills was real, unbounded blocking work on
 * Node's one event loop thread - which also carries every agent's WebSocket chat stream.
 * A short cache is enough to make a burst of requests (e.g. a page load) cheap without
 * making a genuinely new/installed skill invisible for more than a few seconds. */
export function listAllSkills(): SkillInfo[] {
  if (cachedSkills && Date.now() - cachedSkills.at < SKILLS_CACHE_MS) return cachedSkills.skills;
  const byPath = new Map<string, SkillInfo>();
  for (const skill of listAvailableSkills(SKILLS_SOURCE_DIR)) byPath.set(skill.sourcePath, skill);
  for (const repoUrl of listImportedRepos()) {
    const dest = join(SKILL_REPOS_DIR, slugForRepo(repoUrl));
    for (const skill of [...listAvailableSkills(dest), ...listAvailableSkills(join(dest, "skills"))]) {
      byPath.set(skill.sourcePath, skill);
    }
  }
  const skills = [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
  cachedSkills = { at: Date.now(), skills };
  return skills;
}

/** Attaches each skill's real per-project install state (installedIn: which of the given
 * projects already have <project>/.claude/skills/<name>/ on disk) - shared by both routes
 * that need it instead of two copies of the same existsSync loop drifting apart. Skill
 * identity here is name-only (matching how installSkill() itself keys the destination
 * folder), so two different sources that happen to produce the same sanitized name will
 * report the same install state - a known, narrow limitation, not a silent one. */
export function withInstalledIn(skills: SkillInfo[], projects: ProjectInfo[]): (SkillInfo & { installedIn: string[] })[] {
  return skills.map((skill) => ({
    ...skill,
    installedIn: projects.filter((p) => existsSync(join(p.path, ".claude", "skills", skill.name))).map((p) => p.path),
  }));
}

/** Boundary validation for POST /api/skills/install: sourcePath and projectPath arrive as
 * plain strings from the client with no inherent guarantee they're anything real. Without
 * this, installSkill() would cpSync() from/to whatever path a client sent - reading an
 * arbitrary file on the server's disk into a project as a "skill", or writing into an
 * arbitrary directory the server process can write to. Require both to be a path this
 * server itself already knows about (a real skill's sourcePath, a real project's path). */
export function isKnownSkillSource(sourcePath: string): boolean {
  return listAllSkills().some((s) => s.sourcePath === sourcePath);
}
export function isKnownProjectPath(projectPath: string): boolean {
  return listProjects().some((p) => p.path === projectPath);
}
