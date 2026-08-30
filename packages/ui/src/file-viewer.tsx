import Editor, { loader, type BeforeMount } from "@monaco-editor/react";
import type { FileResourceDto } from "@ruleswitch/core";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

import { MarkdownPreview } from "./markdown-preview";
import { editorLanguageForFormat } from "./viewer-model";

loader.config({ monaco });
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
};

let tomlRegistered = false;

export const configureTheme: BeforeMount = (editorApi) => {
  if (!tomlRegistered) {
    editorApi.languages.register({ id: "toml" });
    editorApi.languages.setMonarchTokensProvider("toml", {
      tokenizer: {
        root: [
          [/^\s*#.*$/, "comment"],
          [/^\s*\[\[?.*?\]\]?\s*$/, "type.identifier"],
          [/^[\w.-]+(?=\s*=)/, "key"],
          [/"(?:[^"\\]|\\.)*"/, "string"],
          [/'[^']*'/, "string"],
          [/\b(?:true|false)\b/, "keyword"],
          [/-?\d+(?:\.\d+)?/, "number"]
        ]
      }
    });
    tomlRegistered = true;
  }
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

export const editorOptions = {
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

export interface FileViewerProps {
  readonly resource: FileResourceDto | null;
  readonly content: string;
  readonly view: "source" | "preview";
  readonly sourceTestId: string;
  readonly emptyMessage: string;
}

export function FileViewer({ resource, content, view, sourceTestId, emptyMessage }: FileViewerProps) {
  if (resource === null) {
    return <div className="viewer-placeholder">{emptyMessage}</div>;
  }
  if (view === "preview") {
    if (resource.format !== "markdown") {
      return (
        <div className="viewer-placeholder" data-testid="preview-unavailable">
          Rendered Preview is available for Markdown files. This file remains available in Source.
        </div>
      );
    }
    return <MarkdownPreview content={content} />;
  }
  return (
    <div className="editor-host" data-testid={sourceTestId}>
      <Editor
        beforeMount={configureTheme}
        height="100%"
        language={editorLanguageForFormat(resource.format)}
        theme="ruleswitch-console"
        value={content}
        options={editorOptions}
      />
    </div>
  );
}
