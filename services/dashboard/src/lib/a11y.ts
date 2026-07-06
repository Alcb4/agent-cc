import type { KeyboardEvent } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Keydown handler for role=dialog containers: keeps Tab/Shift-Tab cycling
// inside the dialog instead of walking out into the (inert-looking but still
// tabbable) page behind the overlay.
export function trapTab(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== "Tab") return;
  const focusable = e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE);
  if (focusable.length === 0) {
    e.preventDefault();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === e.currentTarget)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

// Spread onto a non-button element that acts as a click target (rows, cards)
// so it is reachable with Tab and activates with Enter/Space, per the
// DESIGN.md rule that all interactive elements are keyboard-reachable. Real
// <button>s are still preferred where the markup allows; these rows contain
// nested buttons (delete, CTAs), which <button> cannot.
export function clickableRow(onActivate: () => void): {
  role: "button";
  tabIndex: number;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
} {
  return {
    role: "button",
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e) => {
      // Only when the row itself is focused — not when a nested control
      // (input, button) handles its own keys.
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    },
  };
}
