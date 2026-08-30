import { DiffEditor } from "@monaco-editor/react";
import type {
  ApiErrorDto,
  ChangeSetDto,
  DesktopApi,
  FileResourceDto,
  HistoryEntryDto,
  WorkspaceSessionDto
} from "@ruleswitch/core";
import { useMemo, useRef, useState } from "react";

import { editorOptions, configureTheme, FileViewer } from "./file-viewer";
import {
  editorLanguageForFormat,
  fileFormatLabel,
  groupConfigurationResources
} from "./viewer-model";

export interface AppProps {
  readonly api: DesktopApi;
}

type SourceView = "source" | "preview";
type PreviewView = "generated" | "diff";
type Operation = "open" | "read" | "external" | "stage" | "apply" | "history" | "restore";

function describeError(error: ApiErrorDto): string {
  return `${error.code}: ${error.message}`;
}

function caughtMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The operation failed safely.";
}

export function App({ api }: AppProps) {
  const [session, setSession] = useState<WorkspaceSessionDto | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [sourceResource, setSourceResource] = useState<FileResourceDto | null>(null);
  const [sourceContent, setSourceContent] = useState("");
  const [sourceView, setSourceView] = useState<SourceView>("source");
  const [changeSet, setChangeSet] = useState<ChangeSetDto | null>(null);
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null);
  const [currentResource, setCurrentResource] = useState<FileResourceDto | null>(null);
  const [generatedResource, setGeneratedResource] = useState<FileResourceDto | null>(null);
  const [currentContent, setCurrentContent] = useState("");
  const [generatedContent, setGeneratedContent] = useState("");
  const [previewView, setPreviewView] = useState<PreviewView>("generated");
  const [history, setHistory] = useState<readonly HistoryEntryDto[]>([]);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [message, setMessage] = useState("Open a workspace to review its detected configuration.");
  const [error, setError] = useState("");
  const [externalStatus, setExternalStatus] = useState("");
  const [applyStatus, setApplyStatus] = useState("");
  const [restoreStatus, setRestoreStatus] = useState("");
  const readSequence = useRef(0);

  const groups = useMemo(
    () => groupConfigurationResources(session?.sourceResources ?? []),
    [session?.sourceResources]
  );
  const selectedSource = session?.sourceResources.find((resource) => resource.id === selectedSourceId);
  const selectedChange = changeSet?.changes.find((change) => change.id === selectedChangeId);
  const latestApply = [...history]
    .filter((entry) => entry.kind === "apply")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];

  async function readContent(resourceId: string) {
    const result = await api.readResource(resourceId);
    if (!result.ok) throw new Error(describeError(result.error));
    return {
      resource: result.data.resource,
      content: new TextDecoder().decode(result.data.content)
    };
  }

  function clearWorkspaceViews(): void {
    setSelectedSourceId(null);
    setSourceResource(null);
    setSourceContent("");
    setChangeSet(null);
    setSelectedChangeId(null);
    setCurrentResource(null);
    setGeneratedResource(null);
    setCurrentContent("");
    setGeneratedContent("");
    setHistory([]);
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
      clearWorkspaceViews();
      setMessage(`Workspace ${result.data.workspace.name} is ready. Select a configuration file.`);
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
    setMessage("Reading configuration file…");
    setChangeSet(null);
    setSelectedChangeId(null);
    setCurrentResource(null);
    setGeneratedResource(null);
    setCurrentContent("");
    setGeneratedContent("");
    setApplyStatus("");
    try {
      const loaded = await readContent(resourceId);
      if (sequence !== readSequence.current) return;
      setSourceResource(loaded.resource);
      setSourceContent(loaded.content);
      setSourceView("source");
      setMessage("Configuration loaded from a verified resource capability.");
    } catch (caught) {
      if (sequence !== readSequence.current) return;
      setSourceResource(null);
      setSourceContent("");
      setError(caughtMessage(caught));
      setMessage("Configuration file could not be read.");
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

  async function loadChange(changeSetValue: ChangeSetDto, changeId: string): Promise<void> {
    const change = changeSetValue.changes.find((candidate) => candidate.id === changeId);
    if (change === undefined || change.after === null) throw new Error("The selected change has no generated resource.");
    const [before, after] = await Promise.all([
      change.before === null ? Promise.resolve(null) : readContent(change.before.resourceId),
      readContent(change.after.resourceId)
    ]);
    setSelectedChangeId(change.id);
    setCurrentResource(before?.resource ?? null);
    setGeneratedResource(after.resource);
    setCurrentContent(before?.content ?? "");
    setGeneratedContent(after.content);
  }

  async function selectChange(changeId: string): Promise<void> {
    if (changeSet === null) return;
    setBusy("read");
    setError("");
    try {
      await loadChange(changeSet, changeId);
      setPreviewView("generated");
      setMessage("Generated and current resources loaded for review.");
    } catch (caught) {
      setError(caughtMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function stageTarget(): Promise<void> {
    if (session === null || selectedSourceId === null || selectedSource?.format !== "markdown") return;
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
      const first = result.data.changes[0];
      if (first === undefined) throw new Error("The staged change set is empty.");
      setChangeSet(result.data);
      await loadChange(result.data, first.id);
      setPreviewView("generated");
      setMessage(
        result.data.status === "stale"
          ? "The staged preview is stale. Stage again before applying."
          : `Staged ${result.data.changes.length} change for review.`
      );
    } catch (caught) {
      setChangeSet(null);
      setSelectedChangeId(null);
      setCurrentResource(null);
      setGeneratedResource(null);
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
            <p className="eyebrow">Configuration workspace</p>
            <h1>RuleSwitch</h1>
          </div>
        </div>
        <button className="button button-primary" type="button" data-testid="open-workspace" disabled={busy !== null} onClick={() => void openWorkspace()}>
          {busy === "open" ? "Opening…" : "Open Workspace"}
        </button>
      </header>

      <aside className="source-panel" aria-label="Configuration File Explorer">
        <div className="panel-heading">
          <p className="eyebrow">Configuration File Explorer</p>
          <h2 data-testid="workspace-name">{session?.workspace.name ?? "No workspace"}</h2>
          {session !== null && (
            <div className="profile-summary" data-testid="profile-metadata">
              <strong>{session.profile.name}</strong>
              <span>{session.profile.kind} · {session.profile.provider}</span>
            </div>
          )}
        </div>
        <nav className="source-list" data-testid="source-list" aria-label="Rulesync source files">
          {session === null ? (
            <p className="empty-state">Open a workspace to detect its .rulesync configuration.</p>
          ) : groups.length === 0 ? (
            <p className="empty-state">No supported configuration files were detected.</p>
          ) : (
            groups.map((group) => (
              <section className="source-group" key={group.name} aria-labelledby={`group-${group.name}`}>
                <h3 id={`group-${group.name}`}>{group.name}<span>{group.resources.length}</span></h3>
                {group.resources.map((resource) => (
                  <button
                    type="button"
                    className={`source-item ${selectedSourceId === resource.id ? "is-selected" : ""}`}
                    key={resource.id}
                    data-testid="source-item"
                    aria-pressed={selectedSourceId === resource.id}
                    disabled={busy !== null}
                    onClick={() => void selectSource(resource.id)}
                  >
                    <span className="file-glyph" aria-hidden="true">{fileFormatLabel(resource.format)}</span>
                    <span>
                      <strong>{resource.logicalPath}</strong>
                      <small>{resource.byteLength} bytes · {resource.origin}</small>
                    </span>
                  </button>
                ))}
              </section>
            ))
          )}
        </nav>
        {session !== null && (
          <div className="target-summary">
            <span>Active target</span>
            <strong>{session.target.name}</strong>
            <small>{session.target.providerTarget} · {session.target.features.join(", ")}</small>
          </div>
        )}
      </aside>

      <main className="review-workbench">
        <section className="work-section source-review" aria-labelledby="source-review-title">
          <div className="section-toolbar">
            <div>
              <p className="eyebrow">Source viewer</p>
              <h2 id="source-review-title">{selectedSource?.logicalPath ?? "Select a configuration file"}</h2>
              {sourceResource !== null && (
                <div className="resource-badges">
                  <span>{sourceResource.origin}</span><span>{sourceResource.format}</span><span>{sourceResource.readonly ? "read only" : "editable"}</span>
                </div>
              )}
            </div>
            <div className="toolbar-actions">
              <div className="segmented" role="tablist" aria-label="File viewer mode">
                <button role="tab" aria-selected={sourceView === "source"} data-testid="raw-tab" disabled={selectedSourceId === null || busy !== null} onClick={() => setSourceView("source")}>Source</button>
                <button role="tab" aria-selected={sourceView === "preview"} data-testid="rendered-tab" disabled={selectedSource?.format !== "markdown" || busy !== null} onClick={() => setSourceView("preview")}>Preview</button>
              </div>
              <button className="button button-secondary" type="button" data-testid="open-external" disabled={selectedSourceId === null || busy !== null} onClick={() => void openExternal()}>
                {busy === "external" ? "Opening…" : "Open External"}
              </button>
            </div>
          </div>
          <div className="viewer-frame viewer-frame-primary">
            <FileViewer resource={sourceResource} content={sourceContent} view={sourceView} sourceTestId="raw-editor" emptyMessage="Choose a file from the Configuration File Explorer." />
          </div>
          <div className="source-actions-row">
            <p className="inline-status" data-testid="external-status">{externalStatus}</p>
            <button className="button button-secondary" type="button" data-testid="stage-target" disabled={session === null || selectedSource?.format !== "markdown" || busy !== null} onClick={() => void stageTarget()}>
              {busy === "stage" ? "Staging…" : `Stage ${session?.target.providerTarget ?? "target"}`}
            </button>
          </div>
        </section>

        <section className="work-section change-review" aria-labelledby="change-review-title">
          <div className="section-toolbar">
            <div>
              <p className="eyebrow">Generated changes</p>
              <h2 id="change-review-title">{selectedChange === undefined ? "No staged change" : `${selectedChange.kind} · ${selectedChange.logicalPath}`}</h2>
              {generatedResource !== null && (
                <div className="resource-badges">
                  {currentResource !== null && <span>{currentResource.origin} current</span>}
                  <span>{generatedResource.origin}</span><span>{generatedResource.format}</span><span>read only</span>
                </div>
              )}
            </div>
            <div className="toolbar-actions">
              <button className="button button-primary" type="button" data-testid="apply-change-set" disabled={changeSet?.status !== "ready" || busy !== null} onClick={() => void applyChangeSet()}>
                {busy === "apply" ? "Applying…" : "Apply"}
              </button>
            </div>
          </div>
          {changeSet !== null && (
            <div className="change-meta" data-testid="change-set-status"><span className={`state-dot ${changeSet.status}`} aria-hidden="true" />ChangeSet {changeSet.status} · {changeSet.changes.length} item</div>
          )}
          {changeSet !== null && (
            <div className="change-file-list" aria-label="Staged files">
              {changeSet.changes.map((change) => (
                <button key={change.id} type="button" aria-pressed={selectedChangeId === change.id} disabled={busy !== null} onClick={() => void selectChange(change.id)}>
                  <span>{change.kind.slice(0, 1).toUpperCase()}</span>{change.logicalPath}
                </button>
              ))}
            </div>
          )}
          <div className="segmented preview-tabs" role="tablist" aria-label="Generated change preview mode">
            <button role="tab" aria-selected={previewView === "generated"} data-testid="generated-tab" disabled={changeSet === null} onClick={() => setPreviewView("generated")}>Generated</button>
            <button role="tab" aria-selected={previewView === "diff"} data-testid="diff-tab" disabled={changeSet === null} onClick={() => setPreviewView("diff")}>Diff</button>
          </div>
          <div className="viewer-frame">
            {changeSet === null ? (
              <div className="viewer-placeholder">Select a Markdown source and stage the target to review generated files.</div>
            ) : previewView === "generated" ? (
              <FileViewer resource={generatedResource} content={generatedContent} view="source" sourceTestId="generated-editor" emptyMessage="Select a generated change." />
            ) : (
              <div className="editor-host" data-testid="diff-editor">
                <DiffEditor beforeMount={configureTheme} height="100%" language={editorLanguageForFormat(generatedResource?.format ?? "text")} theme="ruleswitch-console" original={currentContent} modified={generatedContent} options={{ ...editorOptions, ariaLabel: "Read-only current and generated configuration diff", originalEditable: false, renderSideBySide: true }} />
              </div>
            )}
          </div>
          <p className="transaction-status" data-testid="apply-status">{applyStatus}</p>
        </section>

        <section className="history-section" aria-labelledby="history-title">
          <div className="section-toolbar compact-toolbar">
            <div><p className="eyebrow">Recovery</p><h2 id="history-title">Transaction history</h2></div>
            <div className="toolbar-actions">
              <button className="button button-secondary" type="button" data-testid="list-history" disabled={session === null || busy !== null} onClick={() => void listHistory()}>{busy === "history" ? "Loading…" : "List History"}</button>
              <button className="button button-warning" type="button" data-testid="restore-history" disabled={latestApply === undefined || busy !== null} onClick={() => void restoreLatestApply()}>{busy === "restore" ? "Restoring…" : "Restore latest apply"}</button>
            </div>
          </div>
          <ol className="history-list" data-testid="history-list">
            {history.length === 0 ? <li className="empty-state">No loaded history.</li> : history.map((entry) => (
              <li key={entry.id}><span className="history-kind">{entry.kind}</span><span>{entry.summary}</span><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time></li>
            ))}
          </ol>
          <p className="transaction-status" data-testid="restore-status">{restoreStatus}</p>
        </section>
      </main>

      <footer className="statusbar">
        <span className={`status-indicator ${error.length > 0 ? "has-error" : ""}`} aria-hidden="true" />
        <div aria-live="polite" aria-atomic="true" data-testid="global-status"><strong>{busy === null ? "Ready" : "Working"}</strong><span>{error.length > 0 ? error : message}</span></div>
      </footer>
    </div>
  );
}
