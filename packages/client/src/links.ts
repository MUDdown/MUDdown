/**
 * Resolve MUDdown game-link schemes into player commands.
 *
 * Game links in MUDdown use URI-like schemes (e.g. `go:north`, `npc:crier`).
 * This function maps a scheme + target pair to the command string that should
 * be sent to the server.
 */

import type { LinkScheme } from "@muddown/shared";

/** Map a game-link scheme and target to the command string to send. */
export function resolveGameLink(scheme: LinkScheme | string, target: string): string | null {
  // Strip control characters and trim to prevent command injection via newlines/separators
  const clean = target.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!clean) return null;

  switch (scheme) {
    case "go":
      return `go ${clean}`;
    case "cmd":
      return clean;
    case "npc":
      return `talk ${clean}`;
    case "item":
      return `examine ${clean}`;
    case "help":
      return `help ${clean}`;
    case "player":
      return `look ${clean}`;
    default:
      return null;
  }
}
