import type { ProviderId } from "@solace/shared";

// Small abstract glyph + brand-adjacent color per provider, so a hub/message reads as
// "which provider" at a glance without relying on trademarked logo marks.
// "custom" is deliberately absent and falls through to the grey "?" below: an arbitrary
// hosted endpoint could be anything, and inventing a mark for it would claim knowledge we
// don't have. "local" is different - it's specifically "a model server on this machine",
// which is a real, distinguishable thing and gets its own mark.
const PROVIDER_STYLE: Record<Exclude<ProviderId, "custom">, { color: string; label: string }> = {
  "claude-code": { color: "#d3915a", label: "claude" },
  "codex-cli": { color: "#8fd1c9", label: "codex" },
  "gemini-cli": { color: "#7c93f2", label: "gemini" },
  "qwen-code": { color: "#c084e0", label: "qwen" },
  local: { color: "#7fb069", label: "local" },
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
    case "local":
      // a machine/box - "this is running here", not out on someone's API
      return (
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="10" rx="2" />
          <path d="M8 19h8" />
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

/** The reader's own identity glyph, so every transcript row - theirs included -
 *  starts on the same left gutter instead of the user's turns floating free. */
export function UserAvatar({ size = 22 }: { size?: number }) {
  return (
    <span className="user-avatar" style={{ width: size, height: size }} title="You">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </span>
  );
}

export function providerLabel(provider: ProviderId): string {
  return PROVIDER_STYLE[provider as Exclude<ProviderId, "custom">]?.label ?? provider;
}

export function providerColor(provider: ProviderId): string {
  return PROVIDER_STYLE[provider as Exclude<ProviderId, "custom">]?.color ?? "#82868f";
}
