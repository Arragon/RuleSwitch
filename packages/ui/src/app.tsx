import Editor, { DiffEditor, loader, type BeforeMount } from "@monaco-editor/react";
import type {
  ApiErrorDto,
  ChangeSetDto,
  DesktopApi,
  HistoryEntryDto,
  WorkspaceSessionDto
} from "@ruleswitch/core";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { useRef, useState } from "react";

import { MarkdownPreview } from "./markdown-preview";

loader.config({ monaco });
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
};

export interface AppProps {
  readonly api: DesktopApi;
}

type SourceView = "raw" | "rendered";
type PreviewView = "generated" | "diff";
type Operation = "open" | "read" | "external" | "stage" | "apply" | "history" | "restore";

const configureTheme: BeforeMount = (editorApi) => {
  editorApi.editor.defineTheme("ruleswitch-console", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#151713",
      "editor.foreground": "#e6e2d8",
      "editorLineNumber.foreground": "#6f7068",
      "editorLineNumber.activeForeground": "#c99a4b",
      "editor.selectionBackground": "#5d492f80",
      "editor.inactiveSelectionBackground": "#3a342a80",
      "diffEditor.insertedTextBackground": "#31543a66",
      "diffEditor.removedTextBackground": "#693b3366"
    }
  });
};

const editorOptions = {
  readOnly: true,
  domReadOnly: true,
  minimap: { enabled: false },
  automaticLayout: true,
  scrollBeyondLastLine: false,
  wordWrap: "on" as const,
  renderWhitespace: "selection" as const,
  fontSize: 13,
  lineHeight: 20,
  padding: { top: 12, bottom: 12 },
  ariaLabel: "Read-only configuration content"
};

function describeError(error: ApiErrorDto): string {
  return `${error.code}: ${error.message}`;
}

function caughtMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The operation failed safely.";
}

export function App({ api }: AppProps) {
  const [session, setSession] = useState<WorkspaceSessionDto | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [sourceContent, setSourceContent] = useState("");
  const [sourceView, setSourceView] = useState<SourceView>("raw");
  const [changeSet, setChangeSet] = useState<ChangeSetDto | null>(null);
  const [currentContent, setCurrentContent] = useState("");
  const [generatedContent, setGeneratedContent] = useState("");
  const [previewView, setPreviewView] = useState<PreviewView>("generated");
  const [history, setHistory] = useState<readonly HistoryEntryDto[]>([]);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [message, setMessage] = useState("Open a workspace to review its detected sources.");
  const [error, setError] = useState("");
  const [externalStatus, setExternalStatus] = useState("");
  const [applyStatus, setApplyStatus] = useState("");
  const [restoreStatus, setRestoreStatus] = useState("");
  const readSequence = useRef(0);

  const selectedSource = session?.sourceResources.find((resource) => resource.id === selectedSourceId);
  const firstChange = changeSet?.changes[0];
  const latestApply = [...history]
    .filter((entry) => entry.kind === "apply")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

  async function readText(resourceId: string): Promise<string> {
    const result = await api.readResource(resourceId);
    if (!result.ok) {
      throw new Error(describeError(result.error));
    }
    return new TextDecoder().decode(result.data.content);
  }

  async function openWorkspace(): Promise<void> {
    const sequence = ++readSequence.current;
    setBusy("open");
    setError("");
    setMessage("Opening workspace…");
    setExternalStatus("");
    setApplyStatus("");
    setRestoreStatus("");
    try {
      const result = await api.openWorkspace();
      if (!result.ok) {
        setError(describeError(result.error));
        setMessage("Workspace was not opened.");
        return;
      }
      if (sequence !== readSequence.current) return;
      setSession(result.data);
      setSelectedSourceId(null);
      setSourceContent("");
      setChangeSet(null);
      setCurrentContent("");
      setGeneratedContent("");
      setHistory([]);
      setMessage(`Workspace ${result.data.workspace.name} is ready. Select a detected source.`);
    } catch (caught) {
      setError(caughtMessage(caught));
      setMessage("Workspace was not opened.");
    } finally {
      setBusy(null);
    }
  }

  async function selectSource(resourceId: string): Promise<void> {
    const sequence = ++readSequence.current;
    setSelectedSourceId(resourceId);
    setBusy("read");
    setError("");
    setMessage("Reading source…");
    setChangeSet(null);
    setCurrentContent("");
    setGeneratedContent("");
    setApplyStatus("");
    try {
      const content = await readText(resourceId);
      if (sequence !== readSequence.current) return;
      setSourceContent(content);
      setSourceView("raw");
      setMessage("Source loaded. Review raw or rendered Markdown.");
    } catch (caught) {
      if (sequence !== readSequence.current) return;
      setSourceContent("");
      setError(caughtMessage(caught));
      setMessage("Source could not be read.");
    } finally {
      if (sequence === readSequence.current) setBusy(null);
    }
  }

  async function openExternal(): Promise<void> {
    if (selectedSourceId === null) return;
    setBusy("external");
    setError("");
    setExternalStatus("Opening in the system default application…");
    try {
      const result = await api.openExternal(selectedSourceId);
      if (!result.ok) {
        setExternalStatus("External open failed.");
        setError(describeError(result.error));
        return;
      }
      setExternalStatus("Opened in the system default application.");
      setMessage("The authorized source was opened externally.");
    } catch (caught) {
      setExternalStatus("External open failed.");
      setError(caughtMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function stageTarget(): Promise<void> {
    if (session === null || selectedSourceId === null) return;
    setBusy("stage");
    setError("");
    setApplyStatus("");
    setMessage(`Staging ${session.target.name}…`);
    try {
      const result = await api.stageTarget(
        session.workspace.id,
        session.profile.id,
        selectedSourceId,
        session.target.id
      );
      if (!result.ok) {
        setError(describeError(result.error));
        setMessage("Target staging failed.");
        return;
      }
      const change = result.data.changes[0];
      if (change === undefined || change.after === null) {
        throw new Error("The staged change set has no generated first change.");
      }
      const [before, after] = await Promise.all([
        change.before === null ? Promise.resolve("") : readText(change.before.resourceId),
        readText(change.after.resourceId)
      ]);
      setChangeSet(result.data);
      setCurrentContent(before);
      setGeneratedContent(after);
      setPreviewView("generated");
      setMessage(
        result.data.status === "stale"
          ? "The staged preview is stale. Stage again before applying."
          : `Staged ${result.data.changes.length} change for review.`
      );
    } catch (caught) {
      setChangeSet(null);
      setCurrentContent("");
      setGeneratedContent("");
      setError(caughtMessage(caught));
      setMessage("Target staging failed.");
    } finally {
      setBusy(null);
    }
  }

  async function applyChangeSet(): Promise<void> {
    if (changeSet === null || changeSet.status !== "ready") return;
    setBusy("apply");
    setError("");
    setApplyStatus("Apply transaction running…");
    try {
      const result = await api.applyChangeSet(changeSet.id);
      if (!result.ok) {
        setApplyStatus(result.error.code === "STALE_CHANGE_SET" ? "Apply · STALE" : "Apply · ERROR");
        setError(describeError(result.error));
        return;
      }
      setApplyStatus(`Apply · ${result.data.state}`);
      setMessage(`Apply transaction ${result.data.state}. Load history to restore it.`);
    } catch (caught) {
      setApplyStatus("Apply · ERROR");
      setError(caughtMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function listHistory(): Promise<void> {
    if (session === null) return;
    setBusy("history");
    setError("");
    setMessage("Loading transaction history…");
    try {
      const result = await api.listHistory(session.workspace.id);
      if (!result.ok) {
        setError(describeError(result.error));
        setMessage("History could not be loaded.");
        return;
      }
      setHistory(result.data);
      setMessage(result.data.length === 0 ? "No committed history yet." : "History is up to date.");
    } catch (caught) {
      setError(caughtMessage(caught));
      setMessage("History could not be loaded.");
    } finally {
      setBusy(null);
    }
  }

  async function restoreLatestApply(): Promise<void> {
    if (latestApply === undefined) return;
    setBusy("restore");
    setError("");
    setRestoreStatus("Restore transaction running…");
    try {
      const result = await api.restoreHistory(latestApply.id);
      if (!result.ok) {
        setRestoreStatus("Restore · ERROR");
        setError(describeError(result.error));
        return;
      }
      setRestoreStatus(`Restore · ${result.data.state}`);
      setMessage(`Restore transaction ${result.data.state}.`);
    } catch (caught) {
      setRestoreStatus("Restore · ERROR");
      setError(caughtMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">RS</span>
          <div>
            <p className="eyebrow">Configuration control console</p>
            <h1>RuleSwitch</h1>
          </div>
        </div>
        <button
          className="button button-primary"
          type="button"
          data-testid="open-workspace"
          disabled={busy !== null}
          onClick={() => void openWorkspace()}
        >
          {busy === "open" ? "Opening…" : "Open Workspace"}
        </button>
      </header>

      <aside className="source-panel" aria-label="Detected sources">
        <div className="panel-heading">
          <p className="eyebrow">Workspace</p>
          <h2 data-testid="workspace-name">{session?.workspace.name ?? "Not open"}</h2>
          {session !== null && <p className="muted">{session.profile.name}</p>}
        </div>
        <div className="source-list" data-testid="source-list">
          {session === null ? (
            <p className="empty-state">Open a workspace to detect Markdown sources.</p>
          ) : (
            session.sourceResources.map((resource) => (
              <button
                type="button"
                className={`source-item ${selectedSourceId === resource.id ? "is-selected" : ""}`}
                key={resource.id}
                data-testid="source-item"
                aria-pressed={selectedSourceId === resource.id}
                disabled={busy !== null}
                onClick={() => void selectSource(resource.id)}
              >
                <span className="file-glyph" aria-hidden="true">MD</span>
                <span>
                  <strong>{resource.logicalPath}</strong>
                  <small>{resource.byteLength} bytes · detected</small>
                </span>
              </button>
            ))
          )}
        </div>
        {session !== null && (
          <div className="target-summary">
            <span>Target</span>
            <strong>{session.target.name}</strong>
            <small>{session.target.providerTarget}</small>
          </div>
        )}
      </aside>

      <main className="review-workbench">
        <section className="work-section source-review" aria-labelledby="source-review-title">
          <div className="section-toolbar">
            <div>
              <p className="eyebrow">01 · Source review</p>
              <h2 id="source-review-title">{selectedSource?.logicalPath ?? "Select a source"}</h2>
            </div>
            <div className="toolbar-actions">
              <div className="segmented" role="tablist" aria-label="Source preview mode">
                <button
                  role="tab"
                  aria-selected={sourceView === "raw"}
                  data-testid="raw-tab"
                  disabled={selectedSourceId === null || busy !== null}
                  onClick={() => setSourceView("raw")}
                >Raw</button>
                <button
                  role="tab"
                  aria-selected={sourceView === "rendered"}
                  data-testid="rendered-tab"
                  disabled={selectedSourceId === null || busy !== null}
                  onClick={() => setSourceView("rendered")}
                >Rendered</button>
              </div>
              <button
                className="button button-secondary"
                type="button"
                data-testid="open-external"
                disabled={selectedSourceId === null || busy !== null}
                onClick={() => void openExternal()}
              >
                {busy === "external" ? "Opening…" : "Open External"}
              </button>
            </div>
          </div>
          <div className="viewer-frame">
            {selectedSourceId === null ? (
              <div className="viewer-placeholder">Choose a detected source from the workspace panel.</div>
            ) : sourceView === "raw" ? (
              <div className="editor-host" data-testid="raw-editor">
                <Editor
                  beforeMount={configureTheme}
                  height="100%"
                  language="markdown"
                  theme="ruleswitch-console"
                  value={sourceContent}
                  options={editorOptions}
                />
              </div>
            ) : (
              <MarkdownPreview content={sourceContent} />
            )}
          </div>
          <p className="inline-status" data-testid="external-status">{externalStatus}</p>
        </section>

        <section className="work-section change-review" aria-labelledby="change-review-title">
          <div className="section-toolbar">
            <div>
              <p className="eyebrow">02 · Change review</p>
              <h2 id="change-review-title">
                {firstChange === undefined ? "No staged change" : `${firstChange.kind} · ${firstChange.logicalPath}`}
              </h2>
            </div>
            <div className="toolbar-actions">
              <button
                className="button button-secondary"
                type="button"
                data-testid="stage-target"
                disabled={session === null || selectedSourceId === null || busy !== null}
                onClick={() => void stageTarget()}
              >
                {busy === "stage" ? "Staging…" : `Stage ${session?.target.providerTarget ?? "codex"}`}
              </button>
              <button
                className="button button-primary"
                type="button"
                data-testid="apply-change-set"
                disabled={changeSet?.status !== "ready" || busy !== null}
                onClick={() => void applyChangeSet()}
              >
                {busy === "apply" ? "Applying…" : "Apply"}
              </button>
            </div>
          </div>
          {changeSet !== null && (
            <div className="change-meta" data-testid="change-set-status">
              <span className={`state-dot ${changeSet.status}`} aria-hidden="true" />
              ChangeSet {changeSet.status} · {changeSet.changes.length} item
            </div>
          )}
          <div className="segmented preview-tabs" role="tablist" aria-label="Generated change preview mode">
            <button
              role="tab"
              aria-selected={previewView === "generated"}
              data-testid="generated-tab"
              disabled={changeSet === null}
              onClick={() => setPreviewView("generated")}
            >Generated</button>
            <button
              role="tab"
              aria-selected={previewView === "diff"}
              data-testid="diff-tab"
              disabled={changeSet === null}
              onClick={() => setPreviewView("diff")}
            >Diff</button>
          </div>
          <div className="viewer-frame">
            {changeSet === null ? (
              <div className="viewer-placeholder">Stage the codex target to generate a reviewable preview.</div>
            ) : previewView === "generated" ? (
              <div className="editor-host" data-testid="generated-editor">
                <Editor
                  beforeMount={configureTheme}
                  height="100%"
                  language="markdown"
                  theme="ruleswitch-console"
                  value={generatedContent}
                  options={{ ...editorOptions, ariaLabel: "Read-only generated configuration preview" }}
                />
              </div>
            ) : (
              <div className="editor-host" data-testid="diff-editor">
                <DiffEditor
                  beforeMount={configureTheme}
                  height="100%"
                  language="markdown"
                  theme="ruleswitch-console"
                  original={currentContent}
                  modified={generatedContent}
                  options={{
                    ...editorOptions,
                    ariaLabel: "Read-only current and generated configuration diff",
                    originalEditable: false,
                    renderSideBySide: true
                  }}
                />
              </div>
            )}
          </div>
          <p className="transaction-status" data-testid="apply-status">{applyStatus}</p>
        </section>

        <section className="history-section" aria-labelledby="history-title">
          <div className="section-toolbar compact-toolbar">
            <div>
              <p className="eyebrow">03 · Recovery</p>
              <h2 id="history-title">Transaction history</h2>
            </div>
            <div className="toolbar-actions">
              <button
                className="button button-secondary"
                type="button"
                data-testid="list-history"
                disabled={session === null || busy !== null}
                onClick={() => void listHistory()}
              >
                {busy === "history" ? "Loading…" : "List History"}
              </button>
              <button
                className="button button-warning"
                type="button"
                data-testid="restore-history"
                disabled={latestApply === undefined || busy !== null}
                onClick={() => void restoreLatestApply()}
              >
                {busy === "restore" ? "Restoring…" : "Restore latest apply"}
              </button>
            </div>
          </div>
          <ol className="history-list" data-testid="history-list">
            {history.length === 0 ? (
              <li className="empty-state">No loaded history.</li>
            ) : (
              history.map((entry) => (
                <li key={entry.id}>
                  <span className="history-kind">{entry.kind}</span>
                  <span>{entry.summary}</span>
                  <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
                </li>
              ))
            )}
          </ol>
          <p className="transaction-status" data-testid="restore-status">{restoreStatus}</p>
        </section>
      </main>

      <footer className="statusbar">
        <span className={`status-indicator ${error.length > 0 ? "has-error" : ""}`} aria-hidden="true" />
        <div aria-live="polite" aria-atomic="true" data-testid="global-status">
          <strong>{busy === null ? "Ready" : "Working"}</strong>
          <span>{error.length > 0 ? error : message}</span>
        </div>
      </footer>
    </div>
  );
}
