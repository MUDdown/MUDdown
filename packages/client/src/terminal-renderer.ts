/**
 * MUDdown terminal renderer.
 *
 * Pure functions that convert MUDdown markup strings into ANSI-styled
 * terminal output strings.  Never writes to stdout — the caller decides
 * where the output goes.  Shared by the terminal client and telnet bridge.
 */

import chalk from "chalk";
import type { BlockType } from "@muddown/shared";
import { resolveGameLink } from "./links.js";

// ─── Theme ───────────────────────────────────────────────────────────────────

/** Style functions for a single inline element type. */
export interface InlineStyles {
  bold: (s: string) => string;
  italic: (s: string) => string;
  code: (s: string) => string;
}

/** Style functions applied to container block output. */
export interface BlockStyles {
  heading: (s: string) => string;
  subheading: (s: string) => string;
  body: (s: string) => string;
  listBullet: (s: string) => string;
  listItem: (s: string) => string;
}

/**
 * Maps block types to style functions, inspired by glamour (GitHub CLI).
 *
 * Each block type gets its own set of block-level and inline styles.
 * Plain-text mode uses identity functions everywhere.
 */
export interface TerminalTheme {
  block: Partial<Record<BlockType | "narrative", BlockStyles>> & { room: BlockStyles };
  inline: InlineStyles;
  /** Style for horizontal rules / section dividers. */
  rule: (s: string) => string;
}

const identity = (s: string): string => s;

/** Default dark theme — room titles green, combat red, system yellow, dialogue cyan. */
export const darkTheme: TerminalTheme = {
  block: {
    room: {
      heading: (s) => chalk.bold.green(s),
      subheading: (s) => chalk.green(s),
      body: (s) => chalk.white(s),
      listBullet: (s) => chalk.green(s),
      listItem: (s) => chalk.white(s),
    },
    combat: {
      heading: (s) => chalk.bold.red(s),
      subheading: (s) => chalk.red(s),
      body: (s) => chalk.red(s),
      listBullet: (s) => chalk.red(s),
      listItem: (s) => chalk.red(s),
    },
    system: {
      heading: (s) => chalk.bold.yellow(s),
      subheading: (s) => chalk.yellow(s),
      body: (s) => chalk.yellow(s),
      listBullet: (s) => chalk.yellow(s),
      listItem: (s) => chalk.yellow(s),
    },
    dialogue: {
      heading: (s) => chalk.bold.cyan(s),
      subheading: (s) => chalk.cyan(s),
      body: (s) => chalk.cyan(s),
      listBullet: (s) => chalk.cyan(s),
      listItem: (s) => chalk.cyan(s),
    },
    narrative: {
      heading: (s) => chalk.bold.magenta(s),
      subheading: (s) => chalk.magenta(s),
      body: (s) => chalk.white(s),
      listBullet: (s) => chalk.magenta(s),
      listItem: (s) => chalk.white(s),
    },
  },
  inline: {
    bold: (s) => chalk.bold(s),
    italic: (s) => chalk.italic(s),
    code: (s) => chalk.bgGray.white(` ${s} `),
  },
  rule: (s) => chalk.dim(s),
};

/** Plain-text theme — identity functions for basic telnet clients. */
export const plainTheme: TerminalTheme = {
  block: {
    room: { heading: identity, subheading: identity, body: identity, listBullet: identity, listItem: identity },
    combat: { heading: identity, subheading: identity, body: identity, listBullet: identity, listItem: identity },
    system: { heading: identity, subheading: identity, body: identity, listBullet: identity, listItem: identity },
    dialogue: { heading: identity, subheading: identity, body: identity, listBullet: identity, listItem: identity },
    narrative: { heading: identity, subheading: identity, body: identity, listBullet: identity, listItem: identity },
  },
  inline: { bold: identity, italic: identity, code: identity },
  rule: identity,
};

// ─── Link Modes ──────────────────────────────────────────────────────────────

export type LinkMode = "osc8" | "numbered" | "plain";

/** Tracked game links for numbered shortcut mode. */
export interface NumberedLink {
  index: number;
  command: string;
}

/**
 * Render a game link according to the chosen link mode.
 *
 * For game-command links, modes behave as follows:
 * - `osc8`:     styled text plus a dimmed command hint; game links are not
 *               rendered as OSC 8 hyperlinks because terminals cannot execute
 *               in-game commands via OSC 8
 * - `numbered`: `TEXT [N]` with the index appended for shortcut entry
 * - `plain`:    `TEXT (command)` gh-style fallback
 *
 * External URLs may be rendered as true OSC 8 hyperlinks elsewhere; this
 * function only handles game links.
 */
function renderGameLink(
  displayText: string,
  scheme: string,
  target: string,
  mode: LinkMode,
  links: NumberedLink[],
  linkStyle: (s: string) => string,
  dim: (s: string) => string,
): string {
  // For player: links, use the display name (stripped of @) instead of the
  // opaque UUID so the legend shows "look Kandawen" not "look a781b366-...".
  const resolvedTarget = scheme === "player" ? displayText.replace(/^@/, "") : target;
  const command = resolveGameLink(scheme, resolvedTarget);
  if (!command) return displayText;

  switch (mode) {
    case "osc8":
      // OSC 8 can't execute game commands in a host terminal — show hint
      return `${linkStyle(displayText)} ${dim(`(${command})`)}`;
    case "numbered": {
      const idx = links.length + 1;
      links.push({ index: idx, command });
      return `${linkStyle(displayText)} ${dim(`[${idx}]`)}`;
    }
    case "plain":
      return `${linkStyle(displayText)} ${dim(`(${command})`)}`;
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

// ─── Word Wrap ───────────────────────────────────────────────────────────────

/**
 * Strip ANSI escape sequences so we can measure visible character width.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b\x07]*(?:\x1b\\|\x07)/g, "");
}

/**
 * Word-wrap a string to the given column width, preserving ANSI codes.
 *
 * Splits on spaces.  Words longer than `cols` are not broken (they overflow).
 */
export function wordWrap(text: string, cols: number): string {
  if (cols <= 0) return text;
  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";
  let currentWidth = 0;

  for (const word of words) {
    const visibleLen = stripAnsi(word).length;
    if (currentWidth > 0 && currentWidth + 1 + visibleLen > cols) {
      lines.push(currentLine);
      currentLine = word;
      currentWidth = visibleLen;
    } else {
      currentLine = currentWidth > 0 ? `${currentLine} ${word}` : word;
      currentWidth += (currentWidth > 0 ? 1 : 0) + visibleLen;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.join("\n");
}

// ─── Inline Formatting ──────────────────────────────────────────────────────

/**
 * Apply inline Markdown formatting for terminal output.
 *
 * Converts bold, italic, code, and game links to styled terminal text.
 */
function terminalInlineFormat(
  line: string,
  theme: TerminalTheme,
  mode: LinkMode,
  links: NumberedLink[],
): string {
  let result = line;

  // ── Links first — before bold/italic, so ANSI escapes don't introduce
  //    stray `[` characters that confuse the link regex. ──

  // Game links — use underline as the link style if ANSI is on
  const isPlain = theme === plainTheme;
  const linkStyle = isPlain ? identity : (s: string) => chalk.underline(s);
  const dim = isPlain ? identity : (s: string) => chalk.dim(s);
  result = result.replace(
    /\[([^\]]+)\]\((cmd|go|item|npc|player|help):([^)]*)\)/g,
    (_m, display: string, scheme: string, target: string) =>
      renderGameLink(display, scheme, target, mode, links, linkStyle, dim),
  );

  // External URLs — render as OSC 8 hyperlinks in osc8 mode, else show URL in parens
  result = result.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_m, text: string, url: string) =>
      mode === "osc8"
        ? `\x1b]8;;${url}\x1b\\${linkStyle(text)}\x1b]8;;\x1b\\`
        : `${text} ${dim(`(${url})`)}`,
  );

  // Relative / unknown links — plain text
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");

  // ── Inline formatting — safe now that all [...] link brackets are consumed ──

  // Bold
  result = result.replace(/\*\*([^*]+)\*\*/g, (_m, text: string) => theme.inline.bold(text));

  // Italic
  result = result.replace(/\*([^*]+)\*/g, (_m, text: string) => theme.inline.italic(text));

  // Inline code
  result = result.replace(/`([^`]+)`/g, (_m, text: string) => theme.inline.code(text));

  return result;
}

// ─── Main Renderer ───────────────────────────────────────────────────────────

interface TerminalRenderOptionsBase {
  /** Column width for word wrap. Defaults to 80. */
  cols?: number;
  /** Link rendering mode. Defaults to `"osc8"`. */
  linkMode?: LinkMode;
  /**
   * Desired chalk color level: 0 = none, 1 = basic 16, 2 = 256, 3 = TrueColor.
   * Currently informational — the process-level `FORCE_COLOR` env var controls
   * the chalk instance used by the theme closures.  Callers can set this to
   * express the detected client capability for future per-session theming.
   *
   * TODO: implement per-session theming.
   */
  colorLevel?: 0 | 1 | 2 | 3;
}

interface AnsiRenderOptions extends TerminalRenderOptionsBase {
  /** Keep ANSI colors enabled (default). */
  ansi?: true;
  /** Theme to use for styling. Defaults to `darkTheme`. */
  theme?: TerminalTheme;
}

interface PlainRenderOptions extends TerminalRenderOptionsBase {
  /** Disable ANSI colors entirely (uses plainTheme). */
  ansi: false;
}

export type TerminalRenderOptions = AnsiRenderOptions | PlainRenderOptions;

/** Format buffered table rows with column-aligned padding. */
function formatTableRows(
  rows: string[][],
  theme: TerminalTheme,
  linkMode: LinkMode,
  links: NumberedLink[],
  styles: BlockStyles,
  ansi: boolean,
): string[] {
  // Format all cells (applying inline formatting)
  const formatted = rows.map(cells =>
    cells.map(c => terminalInlineFormat(c, theme, linkMode, links)),
  );

  // Calculate max visible width per column (ANSI-aware)
  const colCount = Math.max(...rows.map(r => r.length));
  const colWidths: number[] = [];
  for (let col = 0; col < colCount; col++) {
    let max = 0;
    for (const row of formatted) {
      if (col < row.length) {
        const w = stripAnsi(row[col]).length;
        if (w > max) max = w;
      }
    }
    colWidths.push(max);
  }

  const sep = ansi ? chalk.dim(" │ ") : " | ";
  const output: string[] = [];

  for (let r = 0; r < formatted.length; r++) {
    const row = formatted[r];
    const isHeader = r === 0;
    const padded = row.map((cell, i) => {
      const visible = stripAnsi(cell).length;
      const pad = (colWidths[i] ?? 0) - visible;
      const paddedCell = pad > 0 ? cell + " ".repeat(pad) : cell;
      return isHeader && ansi ? chalk.bold(paddedCell) : paddedCell;
    });
    output.push(styles.body(padded.join(sep)));

    // Add separator line after header
    if (isHeader) {
      const rule = colWidths.map(w => "─".repeat(w)).join(ansi ? chalk.dim("─┼─") : "-+-");
      output.push(ansi ? chalk.dim(rule) : rule);
    }
  }

  return output;
}

/**
 * Convert a MUDdown markup string into a styled terminal string.
 *
 * Pure function — never writes to stdout.  Returns the fully styled,
 * word-wrapped string ready for output.
 */
export function renderTerminal(
  muddown: string,
  options: TerminalRenderOptions = {},
): { text: string; links: NumberedLink[] } {
  const ansi = options.ansi !== false;
  const theme = options.ansi !== false ? (options.theme ?? darkTheme) : plainTheme;
  const cols = options.cols ?? 80;
  const linkMode = options.linkMode ?? "osc8";
  const links: NumberedLink[] = [];

  // Detect block type from container fences
  let blockType = "room";
  const fenceMatch = muddown.match(/^:::([\w-]+)\s*\{/m)
    ?? muddown.match(/^:::([\w-]+)\s*$/m);
  if (fenceMatch) {
    blockType = fenceMatch[1];
  }

  const styles: BlockStyles = theme.block[blockType as BlockType | "narrative"] ?? theme.block.room;

  // Strip container block fences
  let text = muddown
    .replace(/^:::[\w-]+\{[^}]*\}\s*$/gm, "")
    .replace(/^:::[\w-]+\s*$/gm, "")
    .replace(/^:::\s*$/gm, "")
    .trim();

  const rawLines = text.split("\n");
  const output: string[] = [];
  let tableRows: string[][] = [];
  let paraLines: string[] = [];

  /** Flush accumulated paragraph lines into a single formatted output line. */
  function flushPara(): void {
    if (paraLines.length === 0) return;
    const joined = paraLines.join(" ");
    const content = terminalInlineFormat(joined, theme, linkMode, links);
    output.push(styles.body(content));
    paraLines = [];
  }

  for (const raw of rawLines) {
    // Headings
    const headingMatch = raw.match(/^(#{1,3}) (.+)/);
    if (headingMatch) {
      flushPara();
      const content = terminalInlineFormat(headingMatch[2], theme, linkMode, links);
      const level = headingMatch[1].length;
      output.push(level === 1 ? styles.heading(content) : styles.subheading(content));
      continue;
    }

    // List items
    if (raw.startsWith("- ")) {
      flushPara();
      const content = terminalInlineFormat(raw.slice(2), theme, linkMode, links);
      output.push(`${styles.listBullet("•")} ${styles.listItem(content)}`);
      continue;
    }

    // Blockquotes
    if (raw.startsWith("> ")) {
      flushPara();
      const content = terminalInlineFormat(raw.slice(2), theme, linkMode, links);
      const bar = ansi ? chalk.dim("│ ") : "| ";
      output.push(`${bar}${styles.body(content)}`);
      continue;
    }

    // Tables — collect rows for column-aligned rendering
    const trimmedRaw = raw.trim();
    if (trimmedRaw.startsWith("|") && trimmedRaw.endsWith("|")) {
      flushPara();
      // Skip separator rows (e.g. |---|:---:|---| with optional surrounding whitespace)
      if (/^\|[\s\-:|]+\|$/.test(trimmedRaw)) continue;
      const cells = trimmedRaw.split("|").slice(1, -1).map(c => c.trim());
      tableRows.push(cells);
      continue;
    }

    // Flush any buffered table rows before non-table content
    if (tableRows.length > 0) {
      output.push(...formatTableRows(tableRows, theme, linkMode, links, styles, ansi));
      tableRows = [];
    }

    // Blank lines
    if (raw.trim() === "") {
      flushPara();
      output.push("");
      continue;
    }

    // Paragraph text — accumulate consecutive lines
    paraLines.push(raw);
  }

  // Flush any remaining paragraph or table content
  flushPara();
  if (tableRows.length > 0) {
    output.push(...formatTableRows(tableRows, theme, linkMode, links, styles, ansi));
  }

  // Word-wrap each line individually
  const wrapped = output.map(line => (line === "" ? "" : wordWrap(line, cols))).join("\n");

  return { text: wrapped, links };
}
