"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { trapTab } from "@/lib/a11y";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

// Cmd-K launcher — the locked primary navigation. Type to filter; Enter runs;
// Up/Down (or Ctrl-j/k) move; Esc closes.
export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      // focus after paint
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (index >= filtered.length) setIndex(Math.max(0, filtered.length - 1));
  }, [filtered, index]);

  // Keep the active row visible as Up/Down moves it (the list scrolls).
  useEffect(() => {
    listRef.current
      ?.querySelector(`#palette-opt-${index}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) {
      e.preventDefault();
      setIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cmd = filtered[index];
      if (cmd) {
        onClose();
        cmd.run();
      }
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={trapTab}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={filtered.length > 0 ? `palette-opt-${index}` : undefined}
          placeholder="type a command, or a workspace name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {filtered.length === 0 && <div className="empty">no matches</div>}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              id={`palette-opt-${i}`}
              role="option"
              aria-selected={i === index}
              className={`palette-row${i === index ? " active" : ""}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => {
                onClose();
                c.run();
              }}
            >
              <span>{c.label}</span>
              {c.hint && <span className="palette-hint">{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
