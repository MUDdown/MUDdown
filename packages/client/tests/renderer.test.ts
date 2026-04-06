import { describe, it, expect } from "vitest";
import { escapeHtml, inlineFormat, renderMuddown } from "../src/renderer.js";

describe("escapeHtml", () => {
  it("escapes &, <, >, double quotes, and single quotes", () => {
    expect(escapeHtml('a & b < c > d "e" \'f\'')).toBe(
      "a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;",
    );
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("leaves safe text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("inlineFormat", () => {
  it("renders bold text", () => {
    expect(inlineFormat("**bold**")).toBe("<strong>bold</strong>");
  });

  it("renders italic text", () => {
    expect(inlineFormat("*italic*")).toBe("<em>italic</em>");
  });

  it("renders inline code", () => {
    expect(inlineFormat("`code`")).toBe("<code>code</code>");
  });

  it("renders game links with data attributes", () => {
    const result = inlineFormat("[North](go:north)");
    expect(result).toContain('data-scheme="go"');
    expect(result).toContain('data-target="north"');
    expect(result).toContain('class="game-link"');
    expect(result).toContain(">North</a>");
  });

  it("renders regular links as normal anchors", () => {
    expect(inlineFormat("[text](http://example.com)")).toBe(
      '<a href="http://example.com" rel="noopener noreferrer">text</a>',
    );
  });

  it("renders https links with rel noopener", () => {
    expect(inlineFormat("[text](https://example.com)")).toContain('rel="noopener noreferrer"');
  });

  it("renders root-relative links without rel", () => {
    expect(inlineFormat("[home](/index)")).toBe('<a href="/index">home</a>');
  });

  it("strips disallowed schemes to plain text", () => {
    expect(inlineFormat("[click](javascript:void)")).toBe("click");
    expect(inlineFormat("[click](data:text/html,hi)")).toBe("click");
  });

  it("escapes HTML in the source text", () => {
    expect(inlineFormat("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("handles all game link schemes", () => {
    // Schemes match the regex in renderer.ts and LinkScheme in @muddown/shared
    for (const scheme of ["go", "cmd", "item", "npc", "player", "help"]) {
      const result = inlineFormat(`[label](${scheme}:target)`);
      expect(result).toContain(`data-scheme="${scheme}"`);
    }
  });
});

describe("renderMuddown", () => {
  it("strips container block fences", () => {
    const md = ':::room{id="town" region="northkeep"}\n# Town\nHello\n:::';
    const html = renderMuddown(md);
    expect(html).not.toContain(":::");
    expect(html).toContain("<h1>");
    expect(html).toContain("Hello");
  });

  it("renders headings at levels 1-3", () => {
    expect(renderMuddown("# H1")).toContain("<h1>");
    expect(renderMuddown("## H2")).toContain("<h2>");
    expect(renderMuddown("### H3")).toContain("<h3>");
  });

  it("renders unordered lists", () => {
    const html = renderMuddown("- item one\n- item two");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>item one</li>");
    expect(html).toContain("<li>item two</li>");
    expect(html).toContain("</ul>");
  });

  it("renders paragraphs", () => {
    const html = renderMuddown("Hello world");
    expect(html).toBe("<p>Hello world</p>");
  });

  it("renders blockquotes", () => {
    const html = renderMuddown("> quoted text");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("quoted text");
    expect(html).toContain("</blockquote>");
  });

  it("renders tables and skips separator rows", () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const html = renderMuddown(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<td>A</td>");
    expect(html).toContain("<td>2</td>");
    expect(html).not.toContain("---");
    expect(html).toContain("</table>");
  });

  it("handles empty input", () => {
    expect(renderMuddown("")).toBe("");
  });

  it("applies inline formatting inside blocks", () => {
    const html = renderMuddown("- **bold** item");
    expect(html).toContain("<strong>bold</strong>");
  });
});
