import type { ProviderPermissionInfo, TrustLevel } from "@solace/shared";

export function permissionOptionsFor(info: ProviderPermissionInfo | undefined): TrustLevel[] {
  return info?.availableModes ?? [];
}

/**
 * Short, plain-language description per mode. These are Claude Code's real --permission-mode
 * enum values; descriptions for "plan"/"acceptEdits"/"bypassPermissions"/"auto" reflect the
 * CLI's documented behavior. "manual" is described per-provider since only Claude Code gets a
 * real live approval popup - Codex approximates it with its own internal approval routing.
 */
export const TRUST_LABELS: Record<TrustLevel, string> = {
  plan: "Plan",
  manual: "Manual",
  acceptEdits: "Accept edits",
  bypassPermissions: "Bypass permissions",
  auto: "Auto",
};

export const TRUST_DESCRIPTIONS: Record<TrustLevel, string> = {
  plan: "Researches and proposes a plan before making any changes.",
  manual: "Asks before every change - a live approve/deny prompt shows up here.",
  acceptEdits: "Auto-accepts file edits; still cautious about riskier actions.",
  bypassPermissions: "Skips all permission checks - runs fully unattended.",
  auto: "Decides for itself which actions are safe to auto-approve.",
};
