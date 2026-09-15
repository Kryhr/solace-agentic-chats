export function ThinkingIndicator({ label }: { label: string }) {
  return (
    <div className="thinking-row" role="status" aria-live="polite">
      <span className="thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span className="thinking-label">{label}</span>
    </div>
  );
}
