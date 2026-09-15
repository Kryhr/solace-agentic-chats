import type { CliProviderId, ProviderPermissionInfo, TrustLevel } from "@solace/shared";

/**
 * Which permission modes each provider's adapter actually supports - verified against real
 * CLI flags (see adapters/claude-code.ts and adapters/codex-cli.ts), not a uniform fake list.
 *
 *   Claude Code: all five map directly to its own --permission-mode enum.
 *   Codex CLI: no native "plan" mode exists (confirmed - no equivalent flag), so it's
 *   omitted rather than faked; the other four are approximated via --sandbox /
 *   --ask-for-approval / --approve-for-me / --dangerously-bypass-approvals-and-sandbox.
 *   Gemini CLI / Qwen Code: adapters aren't implemented yet, so no modes are offered.
 */
const CLAUDE_MODES: TrustLevel[] = ["plan", "manual", "acceptEdits", "bypassPermissions", "auto"];
const CODEX_MODES: TrustLevel[] = ["manual", "acceptEdits", "bypassPermissions", "auto"];

const CATALOG: Record<CliProviderId, ProviderPermissionInfo> = {
  "claude-code": { provider: "claude-code", availableModes: CLAUDE_MODES },
  "codex-cli": { provider: "codex-cli", availableModes: CODEX_MODES },
  "gemini-cli": { provider: "gemini-cli", availableModes: [] },
  "qwen-code": { provider: "qwen-code", availableModes: [] },
};

export function getPermissionCatalog(): ProviderPermissionInfo[] {
  return Object.values(CATALOG);
}
