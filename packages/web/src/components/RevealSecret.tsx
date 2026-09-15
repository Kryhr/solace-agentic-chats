import { useEffect, useState } from "react";
import type { RevealedField } from "@solace/shared";
import { revealCredential } from "../api";

/** How long a revealed secret stays on screen before hiding itself again. A revealed value
 * left sitting in a sidebar is the accidental-exposure case this whole flow exists to avoid -
 * the user walks away, someone else looks at the screen, a screen share starts. Long enough
 * to read a password out or copy it, short enough that it isn't still there ten minutes later. */
const REVEAL_TIMEOUT_MS = 45_000;

/**
 * The per-entry reveal. Deliberately awkward in exactly one way: it does nothing until
 * pressed, and what it shows is gone again on hide, on timeout, or the moment this panel
 * unmounts (navigating away). The values live only in this component's state and are never
 * written into the credential list, so no list re-render can bring them back.
 *
 * One entry at a time is enforced by construction - each row owns its own instance and its
 * own fetch, and there is no route that returns more than one entry's secret anyway.
 */
export function RevealSecret({ id, what }: { id: string; what: string }) {
  const [fields, setFields] = useState<RevealedField[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Hides itself again after a timeout, and - because the cleanup runs on unmount too - drops
  // the values when the user navigates away rather than leaving them in a mounted component.
  useEffect(() => {
    if (!fields) return;
    const timer = setTimeout(() => setFields(null), REVEAL_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [fields]);

  const show = async () => {
    setBusy(true);
    setError(null);
    try {
      const revealed = await revealCredential(id);
      setFields(revealed.fields);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (field: RevealedField) => {
    try {
      await navigator.clipboard.writeText(field.value);
      setCopied(field.name);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // A denied clipboard permission must not look like a successful copy - the user would
      // paste something stale and never know why.
      setError("This browser refused clipboard access - select the value and copy it manually.");
    }
  };

  if (!fields) {
    return (
      <>
        <button className="btn-ghost btn-xs" onClick={show} disabled={busy} title={`Show the stored ${what} for this entry`}>
          {busy ? "…" : "Reveal"}
        </button>
        {error && (
          <span className="field-error reveal-error" role="alert">
            {error}
          </span>
        )}
      </>
    );
  }

  // Built from <span>s rather than <div>s because this renders inside the row's own
  // <span className="provider-actions"> - a div there is invalid markup that the browser
  // silently restructures, which shows up later as React hydration/DOM mismatches. The
  // .reveal-* classes give these block layout.
  return (
    <span className="reveal-panel">
      {fields.length === 0 && <span className="provider-hint">Nothing is stored for this entry.</span>}
      {fields.map((f) => (
        <span className="reveal-field" key={f.name}>
          <span className="reveal-field-name">{f.name}</span>
          {/* A textarea, not a password input: key material is multi-line and the whole point
              of pressing Reveal is to actually read the thing. */}
          <textarea className="reveal-value" value={f.value} readOnly rows={f.value.includes("\n") ? 4 : 1} spellCheck={false} />
          {f.note && <span className="provider-hint reveal-note">{f.note}</span>}
          <button className="btn-ghost btn-xs" onClick={() => copy(f)}>
            {copied === f.name ? "Copied" : "Copy"}
          </button>
        </span>
      ))}
      <span className="reveal-actions">
        <span className="provider-hint">Hides itself in under a minute, and when you leave this panel.</span>
        <button className="btn-ghost btn-xs" onClick={() => setFields(null)}>
          Hide
        </button>
      </span>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
