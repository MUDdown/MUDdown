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
 * Match the opening `:::system{...}` fence and capture the attribute body.
 * Anchored to the start of the document (after optional leading whitespace
 * or YAML frontmatter) so an inner nested fence with `scope="world"` cannot
 * smuggle a per-player envelope onto the public channel.
 */
const SYSTEM_OPEN_FENCE = /:::system\{([^}]*)\}/;

/**
 * Returns true when `envelope` is a world-scope system broadcast eligible
 * for the public feed channel. Returns false for every other case (different
 * envelope type, missing scope, `scope="player"`, unknown scope value, or
 * malformed muddown payload).
 */
export function isWorldScopeEnvelope(envelope: ServerMessage): boolean {
  if (envelope.type !== "system") return false;
  const muddown = envelope.muddown;
  if (typeof muddown !== "string" || muddown.length === 0) return false;

  // Strip optional YAML frontmatter so the system fence can be the first
  // non-frontmatter line.
  let body = muddown;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4);
    if (end !== -1) body = body.slice(end + 5);
  }

  const match = SYSTEM_OPEN_FENCE.exec(body);
  if (!match) return false;
  const attrs = parseAttributes(match[1] ?? "");
  return attrs.scope === "world";
}
