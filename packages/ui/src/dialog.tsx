// In-app confirmation surface.
//
// Replaces `window.prompt` / `window.confirm`: a browser-native dialog is not
// themeable, cannot express risk semantics (delete / first adoption / clone
// destination), and blocks the renderer. This component is the single
// confirmation surface for every risky or input-gathering operation in the
// v2 shell.

import { useEffect, useId, useRef, useState } from "react";

export interface DialogInput {
  readonly name: string;
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
  /** Ordered inputs; the confirm handler receives values in the same order. */
  readonly fields?: readonly DialogInput[];
  readonly onConfirm: (values: readonly string[]) => Promise<void> | void;
}

export interface ConfirmDialogProps {
  readonly request: DialogRequest;
  readonly onCancel: () => void;
}

export function ConfirmDialog({ request, onCancel }: ConfirmDialogProps) {
  const titleId = useId();
  const fields = request.fields ?? [];
  const [values, setValues] = useState<string[]>(() =>
    fields.map((field) => field.initialValue)
  );
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (fields.length > 0 ? firstInputRef.current : confirmRef.current)?.focus();
  }, [fields.length]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const confirmDisabled = busy || values.some((value) => value.trim().length === 0);

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
        {fields.map((field, index) => (
          <label key={field.name} className="app-v2-dialog-field">
            <span>{field.label}</span>
            <input
              ref={index === 0 ? firstInputRef : undefined}
              type="text"
              value={values[index] ?? ""}
              placeholder={field.placeholder}
              aria-label={field.label}
              onChange={(event) => {
                const next = [...values];
                next[index] = event.target.value;
                setValues(next);
              }}
            />
          </label>
        ))}
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
              void Promise.resolve(request.onConfirm(values)).finally(() => setBusy(false));
            }}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
