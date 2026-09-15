/**
 * Extract @handles from a chat message, matched against known agent handles only
 * (so "email@domain.com" or a stray "@" in code doesn't accidentally target an agent).
 */
export function parseMentions(text: string, knownHandles: string[]): string[] {
  const found = new Set<string>();
  // Defense in depth: agent creation is validated to always have a non-empty string handle
  // (see validateAgentConfig.ts), but this filters out anything malformed anyway rather than
  // trusting that invariant everywhere it's consumed - a bad handle here used to throw
  // ("undefined.toLowerCase()") and take down every future group-chat message.
  const validHandles = knownHandles.filter((h): h is string => typeof h === "string" && h.length > 0);
  const handleSet = new Set(validHandles.map((h) => h.toLowerCase()));
  const matches = text.matchAll(/@([a-zA-Z0-9_-]+)/g);
  for (const match of matches) {
    const candidate = match[1].toLowerCase();
    if (handleSet.has(candidate)) {
      found.add(validHandles.find((h) => h.toLowerCase() === candidate)!);
    }
  }
  return [...found];
}
