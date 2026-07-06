"use client";

// Themed replacement for window.confirm on destructive actions (delete
// project, discard workspace). Same overlay/dialog pattern as the other
// modals: Esc or backdrop click cancels; the destructive button is focused
// so Enter confirms deliberately from a visible state.
export function ConfirmDialog({
  open,
  message,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="overlay" onClick={onCancel}>
      <div
        className="confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm action"
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-msg">{message}</div>
        <div className="confirm-actions">
          <button onClick={onCancel}>Cancel</button>
          <button
            className="confirm-danger"
            ref={(el) => {
              if (el && !el.contains(document.activeElement)) el.focus();
            }}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
