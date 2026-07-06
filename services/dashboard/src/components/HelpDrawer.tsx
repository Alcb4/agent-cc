"use client";

import { trapTab } from "@/lib/a11y";

const SHORTCUTS: Array<[string, string]> = [
  ["⌘K / Ctrl-K", "command palette"],
  ["j / k", "move between workspaces"],
  ["Enter", "open selected workspace"],
  ["?", "this help"],
  ["Esc", "close palette / help"],
];

export function HelpDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        ref={(el) => {
          // focus the dialog on mount only — don't steal focus from fields
          // inside it on re-renders
          if (el && !el.contains(document.activeElement)) el.focus();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          trapTab(e);
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-head">
          <h2 className="micro">Keyboard</h2>
        </div>
        <div className="stack">
          {SHORTCUTS.map(([k, v]) => (
            <div className="shortcut" key={k}>
              <span className="kbd">{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
