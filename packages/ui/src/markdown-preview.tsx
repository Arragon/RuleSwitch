import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { splitMarkdownDocument } from "./viewer-model";

export interface MarkdownPreviewProps {
  readonly content: string;
}

function StaticLink({ children }: { readonly children?: ReactNode }) {
  return (
    <span className="markdown-static-link" title="This link requires an authorized capability">
      {children}
    </span>
  );
}

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const document = splitMarkdownDocument(content);
  return (
    <div className="markdown-preview" data-testid="rendered-preview">
      {document.frontmatter !== null && (
        <section className="frontmatter-panel" aria-labelledby="frontmatter-title">
          <p className="eyebrow" id="frontmatter-title">Metadata</p>
          <pre data-testid="frontmatter-metadata"><code>{document.frontmatter}</code></pre>
        </section>
      )}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{ a: StaticLink }}
      >
        {document.body}
      </ReactMarkdown>
    </div>
  );
}
