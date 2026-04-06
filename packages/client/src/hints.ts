/**
 * Parse MUDdown hint blocks into structured data.
 *
 * Hint blocks are `:::system{type="hint"}` containers sent by the server.
 * This module extracts the hint text and any suggested commands.
 */

export interface ParsedHint {
  hint: string;
  commands: string[];
}

/**
 * Parse a MUDdown string that may contain a hint system block.
 *
 * Returns `null` if the string does not contain a `type="hint"` block.
 */
export function parseHintBlock(muddown: string): ParsedHint | null {
  if (!/:::system\s*\{[^}]*\btype\s*=\s*(['"])hint\1[^}]*\}/.test(muddown)) return null;

  // Strip container fences
  const body = muddown
    .replace(/^:::[\w-]+\{[^}]*\}\s*$/gm, "")
    .replace(/^:::\s*$/gm, "")
    .trim();

  const parts = body.split(/\*\*Try:\*\*/);
  const hint = parts[0].trim();
  if (!hint) return null;

  const commands: string[] = [];
  if (parts[1]) {
    for (const line of parts[1].split("\n")) {
      const m = line.match(/^- `([^`]+)`/);
      if (m) commands.push(m[1]);
    }
  }
  return { hint, commands };
}
