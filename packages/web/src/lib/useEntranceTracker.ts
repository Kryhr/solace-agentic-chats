import { useRef } from "react";

/**
 * Decides, per message id, whether that row should play its entrance animation.
 *
 * Previously every message row carried a blanket `.fade-in`, which meant opening
 * a view with existing history animated the entire transcript up from nothing at
 * once - motion with no meaning behind it, and the single clearest "this was
 * styled, not designed" tell in the old UI.
 *
 * Here, the first non-empty batch a view receives is treated as the baseline
 * (history that was already there when you arrived) and never animates. Only
 * rows that genuinely arrive afterwards - a reply landing while you watch - get
 * the entrance. Each decision is memoized by id so a later re-render can't
 * retract the class mid-animation and cause a snap.
 */
export function useEntranceTracker() {
  const baseline = useRef<Set<string>>(new Set());
  const initialized = useRef(false);
  const decisions = useRef<Map<string, boolean>>(new Map());

  return function trackEntrance(ids: string[]) {
    if (!initialized.current && ids.length > 0) {
      initialized.current = true;
      for (const id of ids) baseline.current.add(id);
    }
    return (id: string): boolean => {
      let decided = decisions.current.get(id);
      if (decided === undefined) {
        decided = initialized.current && !baseline.current.has(id);
        decisions.current.set(id, decided);
      }
      return decided;
    };
  };
}
