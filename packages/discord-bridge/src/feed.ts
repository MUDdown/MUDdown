/**
 * World-scope feed helpers.
 *
 * The Discord bridge can post world-scope system messages (server boot/reboot,
 * scheduled downtime, public events) to a configured channel so the wider
 * community sees them without joining a DM session. The detection here is
 * intentionally conservative:
 *
 * - Only `system` envelopes are eligible; every other type is per-player by
 *   construction.
 * - The block must explicitly carry `scope="world"`. A missing or unknown
 *   value falls back to `player` per SPECIFICATION.md §3.6 so a forward-
 *   compat bridge never accidentally broadcasts content the server treats
 *   as private.
 * - Parsing reuses {@link parseAttributes} from the canonical parser rather
 *   than a local regex, so attribute quoting/whitespace edge cases stay
 *   consistent with the rest of the platform.
 */

import { parseAttributes } from "@muddown/parser";
import type { ServerMessage } from "@muddown/shared";

/**
 * Match the opening `:::system{...}` fence at the start of a line and
 * capture the attribute body. The `m` flag makes `^` match any line start,
 * so this regex on its own can still match a fence on a non-first line —
 * the caller MUST verify `match.index === 0` to reject inner fences (see
 * the guard in {@link isWorldScopeEnvelope} immediately below `exec()`).
 * The `^` anchor only rules out `:::system{...}` substrings that appear
 * mid-line in narrative text.
 */
const SYSTEM_OPEN_FENCE = /^:::system\{([^}]*)\}/m;

/**
 * Returns true when `envelope` is a world-scope system broadcast eligible
 * for the public feed channel. Returns false for every other case (different
 * envelope type, missing scope, `scope="player"`, unknown scope value, or
 * malformed muddown payload).
 *
 * Fails closed: any unexpected error during attribute parsing returns false
 * so a single malformed/hostile envelope cannot crash the bridge.
 */
export function isWorldScopeEnvelope(envelope: ServerMessage): boolean {
  if (envelope.type !== "system") return false;
  const muddown = envelope.muddown;
  if (typeof muddown !== "string" || muddown.length === 0) return false;

  // Strip optional YAML frontmatter so the system fence can be the first
  // non-frontmatter line. Also strip any leading blank lines before the
  // fence so the `^` anchor in SYSTEM_OPEN_FENCE matches the first
  // significant line, not blank space.
  let body = muddown;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4);
    if (end !== -1) body = body.slice(end + 5);
  }
  body = body.replace(/^\s*\n/, "");

  const match = SYSTEM_OPEN_FENCE.exec(body);
  if (!match) return false;

  // Require the fence to be on the very first line of the (post-frontmatter,
  // post-leading-blank-line) body. Without this guard, the multiline `^` in
  // SYSTEM_OPEN_FENCE would also match a fence on any later line — e.g. a
  // per-player envelope whose narrative section begins a line with
  // `:::system{scope="world"}` — and incorrectly route it to the public feed.
  if (match.index !== 0) return false;

  try {
    const attrs = parseAttributes(match[1] ?? "");
    return attrs.scope === "world";
  } catch {
    return false;
  }
}
