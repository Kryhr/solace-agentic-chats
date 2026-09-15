/**
 * Providers don't expose a queryable usage/quota API - the only real signal we ever get is
 * the literal error text when a turn actually fails. This never invents a number; it just
 * pulls the reset time out of the provider's own sentence when there is one, so the UI can
 * show a short headline instead of a wall of text, with the original message still available.
 */
export function formatProviderError(message: string): { headline: string; full: string } {
  const resetMatch = message.match(/try again at ([^.]+)\.?/i) ?? message.match(/resumes? .*?(\d{1,2}:\d{2}\s?[APMapm]{2}[^.]*)/);
  if (/usage limit|rate limit/i.test(message) && resetMatch) {
    return { headline: `Rate limited · resumes ${resetMatch[1].trim()}`, full: message };
  }
  return { headline: message.length > 80 ? `${message.slice(0, 80)}…` : message, full: message };
}
