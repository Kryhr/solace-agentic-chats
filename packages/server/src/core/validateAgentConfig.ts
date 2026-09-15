import { resolve, sep } from "node:path";
import type { AgentConfig, ProviderId, TrustLevel } from "@solace/shared";
import { WORKSPACE_ROOT } from "./workspace";

const PROVIDER_IDS: ProviderId[] = ["claude-code", "codex-cli", "gemini-cli", "qwen-code", "custom"];
const TRUST_LEVELS: TrustLevel[] = ["plan", "manual", "acceptEdits", "bypassPermissions", "auto"];
const MAX_HANDLE_LEN = 40;
const MAX_TASK_LEN = 20_000;

/**
 * A malformed POST /api/agents body (missing handle/provider/cwd, or a cwd outside the
 * workspace) used to be accepted verbatim and only blew up later - e.g. a handle-less agent
 * made every subsequent group-chat message crash on `undefined.toLowerCase()` in
 * mentions.ts, permanently, since the bad agent stayed in memory. Validate everything the
 * route actually depends on downstream, once, here.
 */
export function validateNewAgentConfig(
  body: Partial<Omit<AgentConfig, "id">>,
  existingHandles: string[],
): { error: string } | { config: Omit<AgentConfig, "id"> } {
  const handle = typeof body.handle === "string" ? body.handle.trim() : "";
  if (!handle) return { error: "handle is required" };
  if (handle.length > MAX_HANDLE_LEN) return { error: `handle must be ${MAX_HANDLE_LEN} characters or fewer` };
  if (existingHandles.some((h) => h.toLowerCase() === handle.toLowerCase())) {
    return { error: `an agent with handle "${handle}" already exists` };
  }

  if (!PROVIDER_IDS.includes(body.provider as ProviderId)) {
    return { error: `provider must be one of: ${PROVIDER_IDS.join(", ")}` };
  }

  if (!TRUST_LEVELS.includes(body.trustLevel as TrustLevel)) {
    return { error: `trustLevel must be one of: ${TRUST_LEVELS.join(", ")}` };
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  if (!cwd) return { error: "cwd is required" };
  const resolvedRoot = resolve(WORKSPACE_ROOT);
  const resolvedCwd = resolve(cwd);
  if (resolvedCwd !== resolvedRoot && !resolvedCwd.startsWith(resolvedRoot + sep)) {
    return { error: "cwd must be inside the workspace root" };
  }

  if (typeof body.currentTask === "string" && body.currentTask.length > MAX_TASK_LEN) {
    return { error: `currentTask must be ${MAX_TASK_LEN} characters or fewer` };
  }

  return {
    config: {
      ...body,
      handle,
      provider: body.provider as ProviderId,
      trustLevel: body.trustLevel as TrustLevel,
      cwd: resolvedCwd,
    },
  };
}
