import { Fragment } from "react";

/**
 * Message text, with fenced code blocks rendered as code blocks.
 *
 * Agents emit markdown - that is simply what the CLIs produce - but the transcript rendered
 * every message as plain text, so a reply containing a code fence showed the literal ``` lines
 * and set the code in the body face at the body measure. In an app whose whole purpose is
 * coding agents, that is the most visible thing on the main screen and it reads as broken.
 *
 * Deliberately ONLY fenced blocks. This is not a markdown renderer and should not become one by
 * accretion: headings, lists, emphasis and links are all left exactly as the agent wrote them,
 * because each of those is a judgement call about what the agent meant, whereas a fence is an
 * unambiguous "this run of characters is code, set it as code". Inline `code` spans are left
 * alone for the same reason - a lone backtick in prose is far more common than a real span.
 *
 * An UNCLOSED fence stays plain text: mid-stream a turn frequently has an opening fence and no
 * closing one yet, and flipping the rest of the message into a code block for a second as it
 * streams would be worse than leaving it.
 */
const FENCE = /```[^\n`]*\n([\s\S]*?)```/g;

export function MessageText({ text }: { text: string }) {
  // Fast path: the overwhelming majority of messages have no fence at all.
  if (!text.includes("```")) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  FENCE.lastIndex = 0;
  while ((m = FENCE.exec(text)) !== null) {
    if (m.index > last) {
      // The body is white-space: pre-wrap, so the newline that ended the line before the fence
      // would otherwise show up as a blank line above the block.
      parts.push(<Fragment key={key++}>{text.slice(last, m.index).replace(/\n$/, "")}</Fragment>);
    }
    parts.push(
      <pre className="code-block" key={key++}>
        <code>{m[1].replace(/\n$/, "")}</code>
      </pre>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parts.push(<Fragment key={key++}>{text.slice(last).replace(/^\n/, "")}</Fragment>);
  }
  return <>{parts}</>;
}
