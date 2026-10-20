// In-app confirmation surface.
//
// Replaces `window.prompt` / `window.confirm`: a browser-native dialog is not
// themeable, cannot express risk semantics (delete / first adoption /
// degraded conversion), and blocks the renderer. This component is the single
// confirmation surface for every risky operation in the v2 shell.

import { useEffect, useId, useRef, useState } from "react";

export interface DialogInput {
  readonly label: string;
  readonly placeholder: string;
  readonly initialValue: string;
}

export interface DialogRequest {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  /** `danger` marks irreversible or overwrite-style operations. */
  readonly tone?: "default" | "danger";
  readonly input?: DialogInput;
  readonly onConfirm: (inputValue: string) => Promise<void> | void;
}

export interface ConfirmDialogProps {
  readonly request: DialogRequest;
  readonly onCancel: () => void;
}

export function ConfirmDialog({ request, onCancel }: ConfirmDialogProps) {
  const titleId = useId();
  const [value, setValue] = useState(request.input?.initialValue ?? "");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    (request.input ? inputRef.current : confirmRef.current)?.focus();
  }, [request.input]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const confirmDisabled =
    busy || (request.input !== undefined && value.trim().length === 0);

  return (
    <div className="app-v2-dialog-backdrop">
      <div
        className="app-v2-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-tone={request.tone ?? "default"}
      >
        <h2 id={titleId}>{request.title}</h2>
        <p>{request.message}</p>
        {request.input !== undefined && (
          <label className="app-v2-dialog-field">
            <span>{request.input.label}</span>
            <input
              ref={inputRef}
              type="text"
              value={value}
              placeholder={request.input.placeholder}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
        )}
        <div className="app-v2-dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={request.tone === "danger" ? "danger" : undefined}
            disabled={confirmDisabled}
            onClick={() => {
              setBusy(true);
              void Promise.resolve(request.onConfirm(value)).finally(() => setBusy(false));
            }}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
