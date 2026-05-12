/**
 * GFM pipe-table → Discord-friendly transformer.
 *
 * Discord's Markdown — in both regular messages and embeds — does not
 * support tables: pipes and the separator row render as literal text.
 * Since the MUDdown server emits canonical GFM tables (per the spec)
 * for outputs like `help`, the discord-bridge renderer is responsible
 * for transforming them into a shape Discord can display.
 *
 * Strategy:
 * - 2-column tables → bullet list of `- **{col1}** — {col2}`. Most
 *   help/inventory style tables are key/value pairs and read more
 *   naturally as a list. Header row is dropped (it's typically
 *   "Command"/"Description" or similar, where the visual structure
 *   already conveys the relationship).
 * - 3+ column tables → fenced code block with columns padded to the
 *   widest cell. Discord renders the block in a monospaced font so
 *   columns line up.
 *
 * The transformer is conservative: anything that doesn't look exactly
 * like a GFM table is left untouched.
 */

// GFM table delimiter rows allow one-or-more dashes per cell
// (`/^:?-+:?$/`); we match that lower bound rather than the stricter
// `-{3,}` form used by some renderers so we don't silently skip
// canonical-but-minimal tables.
const SEPARATOR_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;
const PIPE_LINE = /^\s*\|.*\|\s*$/;

/**
 * Parse a single GFM table row into trimmed cell strings. Strips the
 * leading/trailing pipes if present, then splits on `|`. Does not handle
 * escaped pipes (`\|`) — MUDdown server output doesn't emit them.
 */
function parseRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  return body.split("|").map((cell) => cell.trim());
}

/**
 * Format a 2-column table body as a bullet list. The header row is
 * skipped since the key/value relationship is conveyed by the bullet
 * shape itself.
 */
function formatKeyValueList(rows: string[][]): string {
  return rows
    .map(([key, value]) => `- **${key ?? ""}**${value ? ` — ${value}` : ""}`)
    .join("\n");
}

/**
 * Format an N-column table as a fenced code block with each column
 * padded to the widest cell in that column (visible width based on
 * char count — adequate for ASCII MUDdown output).
 */
function formatPaddedCodeBlock(header: string[], rows: string[][]): string {
  const allRows = [header, ...rows];
  const columnCount = header.length;
  const widths = Array.from({ length: columnCount }, (_, i) =>
    Math.max(...allRows.map((r) => (r[i] ?? "").length)),
  );
  const renderRow = (row: string[]): string =>
    row.map((cell, i) => (cell ?? "").padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const lines = [renderRow(header), widths.map((w) => "-".repeat(w)).join("  ").trimEnd()];
  for (const row of rows) lines.push(renderRow(row));
  return ["```", ...lines, "```"].join("\n");
}

/**
 * Walk the body line-by-line, locate GFM tables (header + separator +
 * one-or-more body rows), and replace each with a Discord-friendly
 * rendition. Non-table content is preserved verbatim.
 */
export function rewriteTables(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i] ?? "";
    const separator = lines[i + 1] ?? "";
    if (PIPE_LINE.test(header) && SEPARATOR_ROW.test(separator)) {
      const headerCells = parseRow(header);
      // Collect body rows: contiguous pipe-shaped lines after the separator.
      const bodyRows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && PIPE_LINE.test(lines[j] ?? "")) {
        const cells = parseRow(lines[j] ?? "");
        // If a row has the wrong cell count, abandon the table rewrite
        // and emit the original lines as-is to avoid mangling output.
        if (cells.length !== headerCells.length) {
          bodyRows.length = 0;
          break;
        }
        bodyRows.push(cells);
        j++;
      }
      if (bodyRows.length > 0) {
        out.push(
          headerCells.length === 2
            ? formatKeyValueList(bodyRows)
            : formatPaddedCodeBlock(headerCells, bodyRows),
        );
        i = j;
        continue;
      }
    }
    out.push(header);
    i++;
  }
  return out.join("\n");
}
