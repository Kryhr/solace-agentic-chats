// Deterministic, pleasant avatar color per agent handle so each agent reads as a
// distinct identity in the sidebar and chat without repeating the same icon-in-a-circle
// treatment for every card.
const PALETTE = ["#7c93f2", "#4bbf8c", "#d3a355", "#e0685f", "#5cb8d9", "#c084e0", "#8fd16b"];

export function colorForHandle(handle: string): string {
  let hash = 0;
  for (let i = 0; i < handle.length; i++) {
    hash = (hash * 31 + handle.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

export function initialsForHandle(handle: string): string {
  return handle.slice(0, 2).toUpperCase();
}
