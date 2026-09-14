import type { ProviderId } from "@solace/shared";

// Small abstract glyph + brand-adjacent color per provider, so a hub/message reads as
// "which provider" at a glance without relying on trademarked logo marks.
const PROVIDER_STYLE: Record<Exclude<ProviderId, "custom">, { color: string; label: string }> = {
  "claude-code": { color: "#d3915a", label: "claude" },
  "codex-cli": { color: "#8fd1c9", label: "codex" },
  "gemini-cli": { color: "#7c93f2", label: "gemini" },
  "qwen-code": { color: "#c084e0", label: "qwen" },
};

function GlyphFor({ provider }: { provider: ProviderId }) {
  switch (provider) {
    case "claude-code":
      // asterisk / spark
      return (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9" />
        </svg>
      );
    case "codex-cli":
      // terminal brackets
      return (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 6 3 12l5 6M16 6l5 6-5 6" />
        </svg>
      );
    case "gemini-cli":
      // four-point twinkle
      return (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
          <path d="M12 2c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7z" />
        </svg>
      );
    case "qwen-code":
      // hexagon
      return (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
          <path d="M12 3l7.79 4.5v9L12 21l-7.79-4.5v-9L12 3z" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}

export function ProviderIcon({ provider, size = 22 }: { provider: ProviderId; size?: number }) {
  const style = PROVIDER_STYLE[provider as Exclude<ProviderId, "custom">] ?? { color: "#82868f", label: "?" };
  return (
    <span
      className="provider-icon"
      style={{ width: size, height: size, background: `${style.color}26`, color: style.color }}
      title={style.label}
    >
      <GlyphFor provider={provider} />
    </span>
  );
}

export function providerLabel(provider: ProviderId): string {
  return PROVIDER_STYLE[provider as Exclude<ProviderId, "custom">]?.label ?? provider;
}
