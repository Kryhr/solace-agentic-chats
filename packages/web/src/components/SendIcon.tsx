/** Composer send glyph. Kept as its own component so the group chat and an
 *  agent's hub can't drift apart on the one control people press constantly. */
export function SendIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 13V3.5M8 3.5 3.75 7.75M8 3.5l4.25 4.25" />
    </svg>
  );
}
