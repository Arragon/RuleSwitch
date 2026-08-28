import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

export interface MarkdownPreviewProps {
  readonly content: string;
}

function StaticLink({ children }: { readonly children?: ReactNode }) {
  return (
    <span className="markdown-static-link" title="Links are disabled in preview">
      {children}
    </span>
  );
}

/** Phase A previews are inert: raw HTML is not parsed and links never become launch capabilities. */
export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  return (
    <div className="markdown-preview" data-testid="rendered-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{ a: StaticLink }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
