/**
 * MUDdown-to-HTML renderer.
 *
 * Pure functions that convert MUDdown markup strings into HTML strings.
 * No DOM dependencies — safe to use in any JavaScript runtime.
 */

/** Escape special HTML characters to prevent injection. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Apply inline Markdown formatting to a single line.
 *
 * Escapes HTML first, then converts bold, italic, code, and game links
 * to their HTML equivalents.  Game links emit `data-scheme` / `data-target`
 * attributes so the host application can attach its own click handler.
 */
export function inlineFormat(line: string): string {
  const safe = escapeHtml(line);
  return safe
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(
      /\[([^\]]+)\]\((cmd|go|item|npc|player|help):([^)]*)\)/g,
      '<a href="#" data-scheme="$2" data-target="$3" class="game-link">$1</a>',
    )
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, url: string) => {
      if (/^https?:\/\//i.test(url)) {
        return `<a href="${url}" rel="noopener noreferrer">${text}</a>`;
      }
      if (url.startsWith("/")) {
        return `<a href="${url}">${text}</a>`;
      }
      return text;
    });
}

/**
 * Convert a MUDdown markup string into an HTML string.
 *
 * Strips container-block fences (`:::room{…}`, `:::`, etc.) and converts
 * headings, lists, blockquotes, tables, and paragraphs to HTML.  Inline
 * formatting (bold, italic, code, game links) is applied automatically.
 */
export function renderMuddown(muddown: string): string {
  // Strip container block fences
  let text = muddown
    .replace(/^:::[\w-]+\{[^}]*\}\s*$/gm, "")
    .replace(/^:::[\w-]+\s*$/gm, "")
    .replace(/^:::\s*$/gm, "")
    .trim();

  const lines = text.split("\n");
  const html: string[] = [];
  let inList = false;
  let inTable = false;
  let inBlockquote = false;
  let paraLines: string[] = [];

  function flushPara() {
    if (paraLines.length > 0) {
      const content = paraLines.join(" ");
      if (content.trim()) html.push(`<p>${content}</p>`);
      paraLines = [];
    }
  }

  for (const raw of lines) {
    // Blockquotes
    if (raw.startsWith("> ")) {
      flushPara();
      if (inList) { html.push("</ul>"); inList = false; }
      if (inTable) { html.push("</table>"); inTable = false; }
      if (!inBlockquote) { html.push("<blockquote>"); inBlockquote = true; }
      html.push(`<p>${inlineFormat(raw.slice(2))}</p>`);
    } else if (raw.trimStart().startsWith("|") && raw.trimEnd().endsWith("|")) {
      // Skip separator rows like |---|---|
      if (raw.match(/^\|[\s\-:|]+\|$/)) continue;
      flushPara();
      if (inBlockquote) { html.push("</blockquote>"); inBlockquote = false; }
      if (inList) { html.push("</ul>"); inList = false; }
      if (!inTable) { html.push("<table>"); inTable = true; }
      const line = inlineFormat(raw);
      const cells = line.split("|").slice(1, -1).map(c => c.trim());
      html.push("<tr>" + cells.map(c => `<td>${c}</td>`).join("") + "</tr>");
    } else if (raw.match(/^#{1,3} /)) {
      flushPara();
      if (inBlockquote) { html.push("</blockquote>"); inBlockquote = false; }
      if (inList) { html.push("</ul>"); inList = false; }
      if (inTable) { html.push("</table>"); inTable = false; }
      const level = raw.match(/^(#+)/)?.[1].length ?? 1;
      const content = inlineFormat(raw).replace(/^#{1,3} /, "");
      html.push(`<h${level}>${content}</h${level}>`);
    } else if (raw.startsWith("- ")) {
      flushPara();
      if (inBlockquote) { html.push("</blockquote>"); inBlockquote = false; }
      if (inTable) { html.push("</table>"); inTable = false; }
      if (!inList) { html.push("<ul>"); inList = true; }
      html.push(`<li>${inlineFormat(raw).slice(2)}</li>`);
    } else if (raw.trim() === "") {
      flushPara();
      if (inBlockquote) { html.push("</blockquote>"); inBlockquote = false; }
      if (inList) { html.push("</ul>"); inList = false; }
      if (inTable) { html.push("</table>"); inTable = false; }
    } else {
      paraLines.push(inlineFormat(raw));
    }
  }
  flushPara();
  if (inBlockquote) html.push("</blockquote>");
  if (inList) html.push("</ul>");
  if (inTable) html.push("</table>");

  return html.join("");
}
