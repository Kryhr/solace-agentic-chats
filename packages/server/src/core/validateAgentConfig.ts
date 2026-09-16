import { resolve, sep } from "node:path";
import type { AgentConfig, ProviderId, TrustLevel } from "@solace/shared";
import { WORKSPACE_ROOT } from "./workspace";

const PROVIDER_IDS: ProviderId[] = ["claude-code", "codex-cli", "gemini-cli", "qwen-code", "copilot-cli", "opencode", "custom", "local"];
// Exported so /trust reuses this list rather than keeping a second copy that could drift.
export const TRUST_LEVELS: TrustLevel[] = ["plan", "manual", "acceptEdits", "bypassPermissions", "auto"];
const MAX_HANDLE_LEN = 40;
const MAX_TASK_LEN = 20_000;

/**
 * A malformed POST /api/agents body (missing handle/provider/cwd, or a cwd outside the
 * workspace) used to be accepted verbatim and only blew up later - e.g. a handle-less agent
 * made every subsequent group-chat message crash on `undefined.toLowerCase()` in
 * mentions.ts, permanently, since the bad agent stayed in memory. Validate everything the
 * route actually depends on downstream, once, here.
 */
/** Upper-cases the first character only, and only when it is a lowercase letter - so a handle
 * that starts with a digit, a symbol or an already-capital letter is returned untouched. */
export function capitalizeFirst(handle: string): string {
  if (!handle) return handle;
  const first = handle[0];
  return first >= "a" && first <= "z" ? first.toUpperCase() + handle.slice(1) : handle;
}

export function validateNewAgentConfig(
  body: Partial<Omit<AgentConfig, "id">>,
  existingHandles: string[],
): { error: string } | { config: Omit<AgentConfig, "id"> } {
  // Capitalised on the way in, so the roster reads like a list of names rather than a list of
  // command names: "Codex", "Claude", "Copilot". Only the first character is touched - a handle
  // like "OllamaQwen3.5" keeps its own casing, and @mentions are matched case-insensitively
  // (see mentions.ts) so nothing that already refers to an agent stops working.
  // A JSON `null` body reached here and was dereferenced - `null.handle` threw, and Fastify
  // turned that into a 500 with a stack-shaped message. Every other malformed body (arrays,
  // wrong types, missing fields) was already rejected cleanly with a 400; this was the one hole.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "expected a JSON object describing the agent" };
  }
  const handle = capitalizeFirst(typeof body.handle === "string" ? body.handle.trim() : "");
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

  // An endpoint-backed agent reaches its model ONLY through a saved connection: the base URL
  // and the key both live on the credential, so one created without a credentialId has no URL
  // to call and fails every turn with "this connection has no base URL saved" - a dead agent
  // that looks perfectly fine in the sidebar. Observed live on a real local Ollama agent.
  if ((body.provider === "local" || body.provider === "custom") && !body.credentialId) {
    return { error: `a ${body.provider} agent needs a saved connection - pick one under Connections` };
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

type AgentPatch = Partial<
  Pick<AgentConfig, "trustLevel" | "currentTask" | "model" | "effort" | "authMode" | "credentialId" | "cwd">
>;

/**
 * PATCH /api/agents/:id used to apply `req.body` with zero validation via `Object.assign` -
 * unlike creation, nothing stopped a garbage `trustLevel` string from reaching the real CLI's
 * `--permission-mode` flag, or an unbounded `currentTask` string from being broadcast to
 * every connected tab and re-persisted to disk on every debounce cycle. Only validates
 * whichever fields are actually present in the patch.
 */
export function validateAgentPatch(body: Partial<Record<string, unknown>>): { error: string } | { patch: AgentPatch } {
  const patch: AgentPatch = {};

  if ("trustLevel" in body) {
    if (!TRUST_LEVELS.includes(body.trustLevel as TrustLevel)) {
      return { error: `trustLevel must be one of: ${TRUST_LEVELS.join(", ")}` };
    }
    patch.trustLevel = body.trustLevel as TrustLevel;
  }

  if ("currentTask" in body) {
    if (typeof body.currentTask !== "string" || body.currentTask.length > MAX_TASK_LEN) {
      return { error: `currentTask must be a string of ${MAX_TASK_LEN} characters or fewer` };
    }
    patch.currentTask = body.currentTask;
  }

  if ("authMode" in body) {
    if (body.authMode !== "cli" && body.authMode !== "api-key") {
      return { error: 'authMode must be "cli" or "api-key"' };
    }
    patch.authMode = body.authMode;
  }

  if ("model" in body) {
    if (typeof body.model !== "string") return { error: "model must be a string" };
    patch.model = body.model;
  }

  if ("effort" in body) {
    if (typeof body.effort !== "string") return { error: "effort must be a string" };
    patch.effort = body.effort;
  }

  // An agent's folder could be set at creation and never changed, so an agent whose folder was
  // renamed, moved or deleted was stuck pointing at somewhere that no longer exists and failed
  // every turn with no way to fix it short of deleting and re-adding the agent. Validated
  // exactly as creation does - same containment rule, same resolution - because this writes the
  // directory a real CLI is about to be spawned in.
  if ("cwd" in body) {
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    if (!cwd) return { error: "cwd must be a non-empty string" };
    const resolvedRoot = resolve(WORKSPACE_ROOT);
    const resolvedCwd = resolve(cwd);
    if (resolvedCwd !== resolvedRoot && !resolvedCwd.startsWith(resolvedRoot + sep)) {
      return { error: "cwd must be inside the workspace root" };
    }
    patch.cwd = resolvedCwd;
  }

  if ("credentialId" in body) {
    if (body.credentialId !== undefined && typeof body.credentialId !== "string") {
      return { error: "credentialId must be a string or undefined" };
    }
    patch.credentialId = body.credentialId as string | undefined;
  }

  return { patch };
}
