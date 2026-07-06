"use client";

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
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <span className="micro">Keyboard</span>
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
