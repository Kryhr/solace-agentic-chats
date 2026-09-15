import type { ProviderId, ProviderPermissionInfo, TrustLevel } from "@solace/shared";

/**
 * Which permission modes each provider's adapter actually supports - verified against real
 * CLI flags (see adapters/claude-code.ts and adapters/codex-cli.ts), not a uniform fake list.
 *
 *   Claude Code: all five map directly to its own --permission-mode enum.
 *   Codex CLI: no native "plan" mode exists (confirmed - no equivalent flag), so it's
 *   omitted rather than faked; the other four are approximated via --sandbox /
 *   --ask-for-approval / --approve-for-me / --dangerously-bypass-approvals-and-sandbox.
 *   Qwen Code: all five, 1:1 onto its own --approval-mode enum
 *   (plan/default/auto-edit/auto/yolo). Its --help hides the flag, so the choice list was read
 *   back from the CLI itself by passing an invalid value - see adapters/qwen-code.ts.
 *   Gemini CLI: four of the five map 1:1 onto --approval-mode
 *   (plan/default/auto_edit/yolo). "auto" is left out rather than faked: Gemini has no
 *   classifier-judged middle ground, so offering it would just be a second name for
 *   "bypassPermissions" - and a user picking the more cautious-sounding of two identical
 *   options would be misled about what their agent is allowed to do.
 */
const CLAUDE_MODES: TrustLevel[] = ["plan", "manual", "acceptEdits", "bypassPermissions", "auto"];
const CODEX_MODES: TrustLevel[] = ["manual", "acceptEdits", "bypassPermissions", "auto"];
const GEMINI_MODES: TrustLevel[] = ["plan", "manual", "acceptEdits", "bypassPermissions"];
const QWEN_MODES: TrustLevel[] = ["plan", "manual", "acceptEdits", "bypassPermissions", "auto"];

const CATALOG: Record<Exclude<ProviderId, "custom">, ProviderPermissionInfo> = {
  "claude-code": { provider: "claude-code", availableModes: CLAUDE_MODES },
  "codex-cli": { provider: "codex-cli", availableModes: CODEX_MODES },
  "gemini-cli": { provider: "gemini-cli", availableModes: GEMINI_MODES },
  "qwen-code": { provider: "qwen-code", availableModes: QWEN_MODES },
};

export function getPermissionCatalog(): ProviderPermissionInfo[] {
  return Object.values(CATALOG);
}
