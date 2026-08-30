import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { MarkdownPreview } from "../markdown-preview";

describe("MarkdownPreview security", () => {
  test("keeps raw HTML, scripts, handlers, and dangerous links out of executable output", () => {
    const rawHtml = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: `# Safe heading

<script>globalThis.pwned = true</script>

<img src=x onerror="globalThis.pwned = true">

<a href="javascript:alert(1)" onclick="alert(2)">raw link</a>`
      })
    );
    const links = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: `[script link](javascript:alert(3))

[data link](data:text/html,pwned)

[file link](file:///etc/passwd)

[relative link](../outside.md)

[https link](https://example.com)

[unknown link](custom:payload)`
      })
    );
    const html = rawHtml + links;

    expect(html).toContain("Safe heading");
    expect(html).not.toMatch(/<script|<img|<a\b/i);
    expect(html).not.toMatch(/onerror|onclick|javascript:|data:text\/html|file:\/\//i);
    expect(html).toContain("https link");
    expect(html).toContain("relative link");
    expect(html).toContain("unknown link");
    expect(html).toContain("markdown-static-link");
  });

  test("shows frontmatter as metadata and renders only the Markdown body", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownPreview, {
        content: "---\nroot: true\ndescription: Safe metadata\n---\n# Rendered body\n"
      })
    );

    expect(html).toContain("Metadata");
    expect(html).toContain("root: true");
    expect(html).toContain("Rendered body");
    expect(html.match(/<hr/g)).toBeNull();
  });
});
