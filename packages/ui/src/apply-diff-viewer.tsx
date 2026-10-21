// Line-level review of one planned target (INH-1814). Both sides arrive as
// text from Main: `original` is what is on disk today, `modified` is what
// RuleSwitch would write. Read-only — this surface never edits.

import { DiffEditor } from "@monaco-editor/react";
import type { ApplyFileDiff } from "@ruleswitch/core";
import { useState } from "react";

import {
  applyDiffSummaryText,
  editorLanguageForName,
  preferredDiffFileIndex,
  summarizeApplyDiff
} from "./apply-diff-model";
import { configureTheme, editorOptions } from "./file-viewer";

export interface ApplyDiffViewerProps {
  readonly files: readonly ApplyFileDiff[];
  readonly testId?: string;
}

const diffOptions = {
  ...editorOptions,
  ariaLabel: "Read-only diff between the current target and the repository content",
  originalEditable: false,
  renderSideBySide: true,
  readOnly: true
} as const;

export function ApplyDiffViewer({ files, testId = "apply-diff" }: ApplyDiffViewerProps) {
  const [activeIndex, setActiveIndex] = useState(() => preferredDiffFileIndex(files));
  if (files.length === 0) {
    return <p className="app-v2-hint">该目标没有可比较的文件。</p>;
  }
  const index = Math.min(Math.max(activeIndex, 0), files.length - 1);
  const active = files[index];
  const summary = applyDiffSummaryText(summarizeApplyDiff(files));

  return (
    <div className="app-v2-diff" data-testid={testId}>
      <p className="app-v2-diff-summary">{summary}</p>
      {files.length > 1 && (
        <div className="app-v2-diff-tabs" role="tablist" aria-label="差异文件">
          {files.map((file, position) => (
            <button
              key={file.logicalName}
              type="button"
              role="tab"
              aria-selected={position === index}
              className={position === index ? "nav-item active" : "nav-item"}
              onClick={() => setActiveIndex(position)}
            >
              {file.logicalName}
              {file.targetExists ? "" : "（新建）"}
            </button>
          ))}
        </div>
      )}
      {active === undefined ? null : active.binary ? (
        <p className="app-v2-hint" data-testid="apply-diff-binary">
          {active.logicalName} 含非文本内容（二进制或非法 UTF-8），不渲染行级差异；写入仍会按字节原样进行。
        </p>
      ) : (
        <div className="editor-host" data-testid={`${testId}-editor`}>
          <DiffEditor
            beforeMount={configureTheme}
            height="320px"
            language={editorLanguageForName(active.logicalName)}
            theme="ruleswitch-console"
            original={active.targetText ?? ""}
            modified={active.sourceText ?? ""}
            options={diffOptions}
          />
        </div>
      )}
      {active !== undefined && (
        <p className="app-v2-hint">
          左：当前本机目标{active.targetExists ? "" : "（尚不存在）"} · 右：将写入的仓库内容 · {active.logicalName}
        </p>
      )}
    </div>
  );
}
