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

export type LinkMode = "osc8" | "osc8-send" | "numbered" | "plain";

/** Tracked game links for numbered shortcut mode. */
export interface NumberedLink {
  index: number;
  command: string;
}

/**
 * Optional OSC 8 `osc8-send` enrichments advertised by Mudlet-compatible
 * MUD clients via NEW-ENVIRON USERVARs. When enabled, the renderer appends
 * a percent-encoded `?config=…` JSON object to the `send:` URI carrying
 * tooltip text and/or a right-click menu of related actions.
 *
 * See: https://wiki.mudlet.org/w/Manual:OSC — Tier 3 (Tooltips, Context Menus).
 *
 * Keys are gated on the client-advertised capability:
 * - `tooltip`: `OSC_HYPERLINKS_TOOLTIP`
 * - `menu`:    `OSC_HYPERLINKS_MENU`
 *
 * Callers that don't advertise the capability (or clients that ignore
 * unknown `?config=…` payloads) remain functional because Mudlet silently
 * ignores invalid JSON and still honours the `send:` command on click.
 */
export interface Osc8Features {
  /** Emit a `tooltip` field in the OSC 8 config. */
  tooltip?: boolean;
  /** Emit a `menu` array of related actions in the OSC 8 config. */
  menu?: boolean;
}

/**
 * Build the tooltip string and right-click menu entries for a game link
 * based on its scheme. `cleanTarget` is the already-sanitized target
 * (e.g. display name for `player:`, id for `item:`/`npc:`).
 */
function buildLinkMetadata(
  scheme: string,
  cleanTarget: string,
  displayText: string,
): { tooltip: string; menu: Array<Record<string, string> | "-"> } {
  // Strip @ prefix from player display names for tooltip readability.
  const displayClean = displayText.replace(/^@/, "");
  switch (scheme) {
    case "go":
      return {
        tooltip: `Go ${cleanTarget}`,
        menu: [
          { Go: `send:go ${cleanTarget}` },
          { Look: `send:look ${cleanTarget}` },
        ],
      };
    case "npc":
      return {
        tooltip: `Talk to ${displayClean}`,
        menu: [
          { Talk: `send:talk ${cleanTarget}` },
          { Examine: `send:examine ${cleanTarget}` },
          "-",
          { Attack: `send:attack ${cleanTarget}` },
        ],
      };
    case "item":
      return {
        tooltip: `Examine ${displayClean}`,
        menu: [
          { Examine: `send:examine ${cleanTarget}` },
          { Get: `send:get ${cleanTarget}` },
          { Drop: `send:drop ${cleanTarget}` },
        ],
      };
    case "player":
      // Guard against an empty player target — we would otherwise emit
      // `send:look ` (trailing space, no argument) which is a benign but
      // meaningless command on the server side.
      if (cleanTarget.length === 0) {
        return { tooltip: `Look at ${displayClean}`, menu: [] };
      }
      return {
        tooltip: `Look at ${displayClean}`,
        menu: [
          { Look: `send:look ${cleanTarget}` },
          { Tell: `prompt:tell ${cleanTarget} ` },
        ],
      };
    case "help":
      return { tooltip: `Help: ${cleanTarget}`, menu: [] };
    case "cmd":
    default:
      return { tooltip: cleanTarget, menu: [] };
  }
}

/**
 * Sanitize a string for inclusion in an OSC 8 config JSON value.
 *
 * Strips C0/C1/DEL bytes so a hostile display name or target can't
 * smuggle a String Terminator out of the envelope. Also caps length at
 * 200 chars per field so a pathological message can't blow past Mudlet's
 * 4096-byte URL limit when combined with other fields.
 */
function sanitizeConfigString(s: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  return stripped.length > 200 ? stripped.slice(0, 200) : stripped;
}

/**
 * Build and percent-encode the `?config=…` payload for a game link.
 * Returns `""` when neither tooltip nor menu is enabled (or both are
 * empty after filtering), so the caller can emit a bare `send:<cmd>`
 * URI.
 */
function buildOsc8ConfigParam(
  scheme: string,
  cleanTarget: string,
  displayText: string,
  features: Osc8Features,
): string {
  if (!features.tooltip && !features.menu) return "";
  const meta = buildLinkMetadata(scheme, cleanTarget, displayText);
  const config: { tooltip?: string; menu?: Array<Record<string, string> | "-"> } = {};
  if (features.tooltip && meta.tooltip) {
    config.tooltip = sanitizeConfigString(meta.tooltip);
  }
  if (features.menu && meta.menu.length > 0) {
    const cleanMenu: Array<Record<string, string> | "-"> = [];
    for (const entry of meta.menu) {
      if (entry === "-") {
        cleanMenu.push("-");
        continue;
      }
      const entries = Object.entries(entry);
      // Defensive: an empty `{}` menu entry would produce `label ===
      // undefined` below, throwing from `.replace()` inside sanitize.
      // Skip it instead.
      if (entries.length === 0) continue;
      const [label, cmd] = entries[0];
      cleanMenu.push({ [sanitizeConfigString(label)]: sanitizeConfigString(cmd) });
    }
    if (cleanMenu.length > 0) config.menu = cleanMenu;
  }
  if (Object.keys(config).length === 0) return "";
  // JSON.stringify can throw on circular references or BigInt values.
  // `config` is built from plain strings and `-` literals so this should
  // be structurally impossible today, but guard against future changes
  // to `buildLinkMetadata` that might introduce such a value.
  let serialized: string;
  try {
    serialized = JSON.stringify(config);
  } catch {
    return "";
  }
  // `encodeURIComponent` percent-encodes every byte outside the URL
  // unreserved set, which includes ESC (0x1b), BEL (0x07), and all C0/C1
  // control bytes. That means the emitted `?config=…` parameter cannot
  // contain an OSC 8 String Terminator from the renderer's own output,
  // even if a hostile display name or target survived earlier sanitization.
  return `?config=${encodeURIComponent(serialized)}`;
}

/**
 * Render a game link according to the chosen link mode.
 *
 * For game-command links, modes behave as follows:
 * - `osc8`:       styled text plus a dimmed command hint; game links are not
 *                 rendered as OSC 8 hyperlinks because host terminals cannot
 *                 execute in-game commands via OSC 8
 * - `osc8-send`:  wraps the link in an OSC 8 `send:<command>` URI, which
 *                 OSC 8-send-aware MUD clients (Mudlet, FADO, MUDFORGE, …)
 *                 resolve by sending the command on click. The telnet bridge
 *                 picks this mode automatically when the client advertises
 *                 `OSC_HYPERLINKS_SEND` via NEW-ENVIRON.
 * - `numbered`:   `TEXT [N]` with the index appended for shortcut entry
 * - `plain`:      `TEXT (command)` gh-style fallback
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
  features: Osc8Features,
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
    case "osc8-send": {
      // OSC 8 clients that honour the `send:<command>` URI scheme execute
      // the command on click. Supported by Mudlet, FADO, MUDFORGE, and any
      // other client that advertises `OSC_HYPERLINKS_SEND` via NEW-ENVIRON.
      // Strip C0/C1 + DEL from the command so a payload containing ESC
      // can't close the outer envelope early.
      const safeCmd = command.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
      if (!safeCmd) {
        // Command consisted entirely of control bytes; emitting
        // `send:` with an empty command would be a silently clickable
        // no-op. Fall back to a plain-mode rendering — but do NOT echo
        // the raw `command` (which by definition contains only control
        // bytes). Use a placeholder so the user sees the display text
        // with an indicator that the underlying command was unsafe.
        return `${linkStyle(displayText)} ${dim("(<unsafe>)")}`;
      }
      // Append ?config=… for tooltip/menu enrichments when the client
      // advertises the corresponding OSC_HYPERLINKS_TOOLTIP / _MENU
      // capabilities. The resolved target (display name for player:,
      // id/alias for item:/npc:) is the correct argument for the menu's
      // commands — it mirrors resolveGameLink's own arg selection.
      const configParam = buildOsc8ConfigParam(scheme, resolvedTarget, displayText, features);
      return `\x1b]8;;send:${safeCmd}${configParam}\x1b\\${linkStyle(displayText)}\x1b]8;;\x1b\\`;
    }
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
 *
 * Covers:
 * - CSI sequences `ESC [ … <final byte 0x40–0x7e>` (SGR `m`, cursor
 *   moves, erases, and every other CSI)
 * - OSC sequences `ESC ] … ST` where ST is either `ESC \` or BEL (0x07)
 * - Two-byte ESC sequences `ESC <0x20–0x7e>` (e.g. character-set
 *   selection, reset) excluding the `[` and `]` introducers handled above
 *
 * Any escape that inflated the measured visible width would cause
 * premature line breaks, so we strip liberally rather than narrowly.
 */
function stripAnsi(s: string): string {
  return (
    s
      // CSI: ESC [ params final
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, "")
      // OSC: ESC ] … (ST = ESC \ | BEL)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      // Two-byte ESC sequences: ESC followed by a single byte in 0x20–0x7e
      // (excluding `[` and `]` already handled by the patterns above).
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[\x20-\x5a\x5c\x5e-\x7e]/g, "")
  );
}

/**
 * Word-wrap a string to the given column width, preserving ANSI codes
 * and OSC 8 hyperlink envelopes.
 *
 * Splits on spaces.  Words longer than `cols` are not broken (they
 * overflow).  Spaces that appear inside an OSC 8 hyperlink target
 * (between `ESC ] 8 ; ; URI ESC \`) are treated as part of the enclosing
 * "word" so the envelope is never broken across lines — a split there
 * would leak a raw space into the URI and produce a clickable no-op on
 * receiving clients.
 */
export function wordWrap(text: string, cols: number): string {
  if (cols <= 0) return text;
  const words = splitPreservingOsc8(text);
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

/**
 * Split a string on spaces, but keep complete OSC 8 hyperlink envelopes
 * (opening `ESC ] 8 ; ; … ESC \` through closing `ESC ] 8 ; ; ESC \`)
 * grouped with the word they belong to. Runs of OSC 8 sequences and
 * their display text are treated atomically so a space inside the URI
 * (e.g. `send:talk crier`) or between the opener and the visible text
 * never becomes a wrap point.
 */
function splitPreservingOsc8(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let inOsc8 = false;
  let i = 0;
  while (i < text.length) {
    // Detect an OSC 8 opener: `ESC ] 8 ;` — we're now inside an envelope
    // until we see the matching `ESC ] 8 ; ; ESC \` closer.
    if (text.startsWith("\x1b]8;", i)) {
      // Consume the full OSC 8 sequence up to ST (ESC \) or BEL (0x07).
      const { end, terminated } = findOsc8End(text, i);
      const seq = text.slice(i, end);
      current += seq;
      i = end;
      if (!terminated) {
        // Unterminated opener. The envelope "runs to end-of-input" which
        // means everything after it ends up as one unbreakable word. Warn
        // so operators can trace the malformed source, then bail out of
        // the envelope state so the remaining text (if any) is still
        // wrappable.
        // eslint-disable-next-line no-console
        console.warn("terminal-renderer: unterminated OSC 8 sequence; word-wrap may produce a long line");
        inOsc8 = false;
        continue;
      }
      // `ESC ] 8 ; ; ESC \` (empty URI) is the closer; otherwise we're
      // now inside an envelope and must treat subsequent spaces as
      // non-breaking until we see that closer.
      if (/^\x1b\]8;;\x1b\\$|^\x1b\]8;;\x07$/.test(seq)) {
        inOsc8 = false;
      } else {
        inOsc8 = true;
      }
      continue;
    }
    const ch = text[i];
    if (ch === " " && !inOsc8) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
    i++;
  }
  if (current.length > 0 || out.length === 0) out.push(current);
  return out;
}

/** Find the byte index just past the next OSC 8 terminator (ST or BEL). */
function findOsc8End(text: string, start: number): { end: number; terminated: boolean } {
  for (let j = start + 4; j < text.length; j++) {
    if (text[j] === "\x07") return { end: j + 1, terminated: true };
    if (text[j] === "\x1b" && text[j + 1] === "\\") return { end: j + 2, terminated: true };
  }
  return { end: text.length, terminated: false };
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
  features: Osc8Features,
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
      renderGameLink(display, scheme, target, mode, links, linkStyle, dim, features),
  );

  // External URLs — render as OSC 8 hyperlinks whenever an OSC 8 mode
  // is active; fall back to `TEXT (URL)` for numbered/plain modes.
  // Strip C0/C1/DEL from the URL before interpolating into the envelope
  // so a control byte in the URL path can't close the OSC 8 sequence
  // early (mirroring the game-link sanitizer in the osc8-send branch).
  result = result.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_m, text: string, url: string) => {
      if (mode !== "osc8" && mode !== "osc8-send") {
        return `${text} ${dim(`(${url})`)}`;
      }
      const safeUrl = url.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
      return `\x1b]8;;${safeUrl}\x1b\\${linkStyle(text)}\x1b]8;;\x1b\\`;
    },
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
  /**
   * Optional OSC 8 `osc8-send` enrichments (tooltip, right-click menu).
   * Only consulted when `linkMode === "osc8-send"`. Set fields based on
   * the client's advertised NEW-ENVIRON capabilities
   * (`OSC_HYPERLINKS_TOOLTIP`, `OSC_HYPERLINKS_MENU`).
   */
  osc8Features?: Osc8Features;
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
  features: Osc8Features,
): string[] {
  // Format all cells (applying inline formatting)
  const formatted = rows.map(cells =>
    cells.map(c => terminalInlineFormat(c, theme, linkMode, links, features)),
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
  const features: Osc8Features = options.osc8Features ?? {};
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
    const content = terminalInlineFormat(joined, theme, linkMode, links, features);
    output.push(styles.body(content));
    paraLines = [];
  }

  for (const raw of rawLines) {
    // Headings
    const headingMatch = raw.match(/^(#{1,3}) (.+)/);
    if (headingMatch) {
      flushPara();
      const content = terminalInlineFormat(headingMatch[2], theme, linkMode, links, features);
      const level = headingMatch[1].length;
      output.push(level === 1 ? styles.heading(content) : styles.subheading(content));
      continue;
    }

    // List items
    if (raw.startsWith("- ")) {
      flushPara();
      const content = terminalInlineFormat(raw.slice(2), theme, linkMode, links, features);
      output.push(`${styles.listBullet("•")} ${styles.listItem(content)}`);
      continue;
    }

    // Blockquotes
    if (raw.startsWith("> ")) {
      flushPara();
      const content = terminalInlineFormat(raw.slice(2), theme, linkMode, links, features);
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
      output.push(...formatTableRows(tableRows, theme, linkMode, links, styles, ansi, features));
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
    output.push(...formatTableRows(tableRows, theme, linkMode, links, styles, ansi, features));
  }

  // Word-wrap each line individually
  const wrapped = output.map(line => (line === "" ? "" : wordWrap(line, cols))).join("\n");

  return { text: wrapped, links };
}
