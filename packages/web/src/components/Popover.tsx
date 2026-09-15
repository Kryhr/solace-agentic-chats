import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Small anchored popover: a trigger button plus a panel that opens next to it.
 *
 * The app had no popover primitive and no outside-click handling anywhere before this, so this
 * is deliberately generic (trigger content, panel content, side) rather than shaped around the
 * usage meter that is its first caller.
 *
 * Dismissal follows the usual expectations for a menu-like popover: pointerdown outside closes
 * it without stealing focus (the user is already reaching for something else), Escape closes it
 * and puts focus back on the trigger (the keyboard user has nowhere else to be).
 */
export function Popover({
  label,
  trigger,
  children,
  align = "left",
  disabled = false,
  triggerClassName = "",
  panelClassName = "",
}: {
  /** Accessible name for the trigger, also used as the panel's label. */
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  /** Which edge of the anchor the panel lines up with. */
  align?: "left" | "right";
  disabled?: boolean;
  triggerClassName?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    // Capture phase so a click on a control that stops propagation still dismisses the popover.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  // A trigger that becomes disabled while its panel is open would otherwise leave the panel
  // stranded with no way back to the (now unfocusable) trigger.
  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  return (
    <div className="popover-anchor" ref={anchorRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`popover-trigger ${triggerClassName}`}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <div id={panelId} role="dialog" aria-label={label} className={`popover-panel popover-${align} ${panelClassName}`}>
          {children}
        </div>
      )}
    </div>
  );
}
