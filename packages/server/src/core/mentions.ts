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
  // Dots are legal INSIDE a handle but never at its end. Agent handles routinely carry a model
  // version - "OllamaQwen3.5" is a real one - and the old [a-zA-Z0-9_-]+ pattern captured only
  // "OllamaQwen3", which matched no agent, so the mention silently evaporated and the message
  // broadcast to EVERY agent in the chat instead: the intended agent got the work, and so did
  // everyone else, each spending a real turn. Requiring an alphanumeric run after each dot is
  // what keeps a sentence-ending "ask @claude." from capturing the period, and "user@host.com"
  // still resolves to nothing because no agent is called that.
  const matches = text.matchAll(/@([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)/g);
  for (const match of matches) {
    const candidate = match[1].toLowerCase();
    if (handleSet.has(candidate)) {
      found.add(validHandles.find((h) => h.toLowerCase() === candidate)!);
    }
  }
  return [...found];
}
