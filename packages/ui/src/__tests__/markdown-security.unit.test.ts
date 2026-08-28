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

[https link](https://example.com)`
      })
    );
    const html = rawHtml + links;

    expect(html).toContain("Safe heading");
    expect(html).not.toMatch(/<script|<img|<a\b/i);
    expect(html).not.toMatch(/onerror|onclick|javascript:|data:text\/html|file:\/\//i);
    expect(html).toContain("https link");
    expect(html).toContain("markdown-static-link");
  });
});
