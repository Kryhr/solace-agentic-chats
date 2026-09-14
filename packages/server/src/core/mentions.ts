/**
 * Extract @handles from a chat message, matched against known agent handles only
 * (so "email@domain.com" or a stray "@" in code doesn't accidentally target an agent).
 */
export function parseMentions(text: string, knownHandles: string[]): string[] {
  const found = new Set<string>();
  const handleSet = new Set(knownHandles.map((h) => h.toLowerCase()));
  const matches = text.matchAll(/@([a-zA-Z0-9_-]+)/g);
  for (const match of matches) {
    const candidate = match[1].toLowerCase();
    if (handleSet.has(candidate)) {
      found.add(knownHandles.find((h) => h.toLowerCase() === candidate)!);
    }
  }
  return [...found];
}
