import type { CliProviderId, ProviderPermissionInfo, TrustLevel } from "@solace/shared";

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
 *   Copilot CLI: three of the five. Its --deny-tool patterns (`write`, `shell`) outrank even
 *   --allow-all-tools, which makes plan/acceptEdits/bypassPermissions genuinely expressible -
 *   each verified by a real turn that tried to write a file AND run a shell command (see
 *   adapters/copilot-cli.ts). "manual" is omitted because Copilot has no external approval hook
 *   like Claude Code's --permission-prompt-tool: its --assisted-approval hands the decision to
 *   an LLM safety judge inside Copilot, so offering "manual" would promise a human gate that
 *   does not exist. "auto" is omitted for the reason Gemini's is - Copilot has no unattended
 *   middle ground distinct from full access, so it would just be a second, more cautious-sounding
 *   name for "bypassPermissions".
 *   OpenCode: three of the five, and it reaches them through config rather than a flag - it
 *   has no --permission-mode equivalent at all (see adapters/opencode.ts for the config block
 *   and the real-turn evidence behind each claim). "plan" and "acceptEdits" are unusually
 *   strong here because OpenCode's "deny" REMOVES a tool from the model's tool list rather
 *   than rejecting the call: in plan mode the CLI itself reports write/edit/bash as
 *   "unavailable tool", so it is read-only by construction rather than by refusal.
 *   "manual" is omitted, and this is the important one: OpenCode's "ask" value is
 *   AUTO-REJECTED in headless `run` - verified, the turn printed "permission requested: edit
 *   (...); auto-rejecting" and the tool came back "The user rejected permission to use this
 *   specific tool call.". It never reaches a human and there is no --permission-prompt-tool
 *   equivalent to route it to this app's approval system, so offering "manual" would promise
 *   a human gate that cannot exist - it would in practice be a mode where the agent is asked
 *   to work and then silently refused every tool.
 *   "auto" is omitted for the reason Gemini's and Copilot's are: OpenCode has no
 *   classifier-judged middle ground distinct from full access, so it would just be a
 *   safer-sounding second name for "bypassPermissions".
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
const COPILOT_MODES: TrustLevel[] = ["plan", "acceptEdits", "bypassPermissions"];
const OPENCODE_MODES: TrustLevel[] = ["plan", "acceptEdits", "bypassPermissions"];

const CATALOG: Record<CliProviderId, ProviderPermissionInfo> = {
  "claude-code": { provider: "claude-code", availableModes: CLAUDE_MODES },
  "codex-cli": { provider: "codex-cli", availableModes: CODEX_MODES },
  "gemini-cli": { provider: "gemini-cli", availableModes: GEMINI_MODES },
  "qwen-code": { provider: "qwen-code", availableModes: QWEN_MODES },
  "copilot-cli": { provider: "copilot-cli", availableModes: COPILOT_MODES },
  opencode: { provider: "opencode", availableModes: OPENCODE_MODES },
};

export function getPermissionCatalog(): ProviderPermissionInfo[] {
  return Object.values(CATALOG);
}
