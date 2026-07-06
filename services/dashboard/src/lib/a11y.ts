import type { KeyboardEvent } from "react";

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
