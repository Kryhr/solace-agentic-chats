import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Every agent's working directory lives inside one root folder on the user's Desktop
 * (`~/Desktop/solace-workspace`) instead of asking them to type an arbitrary path.
 * Projects are just subfolders of this root, created on demand from the UI.
 */
export const WORKSPACE_ROOT = process.env.SOLACE_WORKSPACE_ROOT ?? join(homedir(), "Desktop", "solace-workspace");

export function ensureWorkspaceRoot() {
  if (!existsSync(WORKSPACE_ROOT)) {
    mkdirSync(WORKSPACE_ROOT, { recursive: true });
  }
}

export interface ProjectInfo {
  name: string;
  path: string;
}

export function listProjects(): ProjectInfo[] {
  ensureWorkspaceRoot();
  return readdirSync(WORKSPACE_ROOT)
    .filter((name) => statSync(join(WORKSPACE_ROOT, name)).isDirectory())
    .map((name) => ({ name, path: join(WORKSPACE_ROOT, name) }));
}

const VALID_PROJECT_NAME = /^[a-zA-Z0-9._-]+$/;

export function createProject(name: string): ProjectInfo {
  const trimmed = name.trim();
  if (!trimmed || !VALID_PROJECT_NAME.test(trimmed)) {
    throw new Error("Project name can only contain letters, numbers, dots, dashes and underscores");
  }
  ensureWorkspaceRoot();
  const path = join(WORKSPACE_ROOT, trimmed);
  if (existsSync(path)) {
    throw new Error(`A project named "${trimmed}" already exists`);
  }
  mkdirSync(path, { recursive: true });
  return { name: trimmed, path };
}
