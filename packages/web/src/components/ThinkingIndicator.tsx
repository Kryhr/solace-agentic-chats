export function ThinkingIndicator({ label }: { label: string }) {
  return (
    <div className="thinking-row">
      <span className="thinking-dots">
        <span />
        <span />
        <span />
      </span>
      <span className="thinking-label">{label}</span>
    </div>
  );
}
