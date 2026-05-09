/**
 * MUDdown → Discord renderer.
 *
 * Converts a {@link ServerMessage} envelope into a Discord embed plus
 * action-row components (buttons/select). Pure — no discord.js client
 * coupling — so it's exercised in unit tests by inspecting the returned
 * shape directly.
 *
 * Discord limits enforced here:
 * - Embed description: 4096 chars (split into multiple embeds when over)
 * - Buttons per action row: 5
 * - Action rows per message: 5 (so 25 buttons max; overflow → select menu)
 * - Button custom_id: ≤ 100 chars
 */

import type { ServerMessage } from "@muddown/shared";

/** Discord embed colors, by ServerMessage.type, mirroring ARIA-role intent. */
export const BLOCK_COLORS: Readonly<Record<ServerMessage["type"], number>> = Object.freeze({
  room: 0x3b82f6,      // blue
  system: 0xef4444,    // red
  combat: 0xf97316,    // orange
  dialogue: 0x22c55e,  // green
  narrative: 0x9ca3af, // neutral gray
});

/** Hard limits taken from Discord's API documentation. */
export const DISCORD_LIMITS = Object.freeze({
  embedDescription: 4096,
  buttonsPerRow: 5,
  rowsPerMessage: 5,
  customIdLength: 100,
});

/** Subset of the discord.js APIEmbed shape — kept local so tests don't need discord.js. */
export interface RenderedEmbed {
  title: string;
  description: string;
  color: number;
}

/** Subset of the discord.js APIButtonComponent shape. */
export interface RenderedButton {
  type: "button";
  label: string;
  customId: string;
  /** Maps to discord.js ButtonStyle: 1=Primary, 2=Secondary, 3=Success, 4=Danger. */
  style: 1 | 2 | 3 | 4;
}

/** Subset of the discord.js APISelectMenuComponent shape. */
export interface RenderedSelect {
  type: "select";
  customId: string;
  placeholder: string;
  options: Array<{ label: string; value: string }>;
}

export interface RenderedMessage {
  embeds: RenderedEmbed[];
  components: Array<RenderedButton[] | RenderedSelect>;
}

/**
 * Strip MUDdown container fences (`:::room{...}` / `:::`) and YAML
 * frontmatter from the body so the description is plain Markdown that
 * Discord renders cleanly.
 */
export function stripContainerScaffolding(muddown: string): string {
  let body = muddown;
  // Strip leading YAML frontmatter
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---\n", 4);
    if (end !== -1) body = body.slice(end + 5);
  }
  // Strip outer ::: container fences (one open + one close).
  // Anchors are start-/end-of-string, not line — using /m would match
  // an inner ::: fence on the first inner line instead of the outer one.
  body = body.replace(/^:::[a-z][a-z0-9-]*(?:\{[^}]*\})?\s*\n/, "");
  // The close fence may be preceded by a newline (typical) or sit at
  // the start of the remaining body (when the container has no inner
  // content, e.g. `:::system\n:::`).
  body = body.replace(/(?:^|\n):::\s*$/, "");
  return body.trim();
}

/**
 * Split a long description into chunks that fit
 * {@link DISCORD_LIMITS.embedDescription}, preferring paragraph breaks.
 */
export function chunkDescription(text: string, max = DISCORD_LIMITS.embedDescription): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    // Prefer the last paragraph break before the limit; fall back to the
    // last whitespace boundary so we don't split mid-word; only hard-cut
    // at `max` when neither boundary is reachable. Keep the split
    // delimiter in one chunk so joining chunks reproduces the original
    // content exactly.
    const slice = remaining.slice(0, max);
    const lastPara = slice.lastIndexOf("\n\n");
    const lastSpace = slice.lastIndexOf(" ");
    let cut: number;
    if (lastPara > max / 2) cut = lastPara + 2;
    else if (lastSpace > max / 2) cut = lastSpace + 1;
    else cut = max;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/** Title-case a ServerMessage.type for the embed title. */
function titleFor(envelope: ServerMessage): string {
  return envelope.type.charAt(0).toUpperCase() + envelope.type.slice(1);
}

/**
 * Render a server envelope into the Discord-ready shape.
 *
 * The renderer is intentionally minimal at this stage — link extraction
 * and button generation are delegated to a follow-up commit so this
 * commit's diff is easy to review. Today: embed(s) only; components is
 * always an empty array.
 */
export function renderEnvelope(envelope: ServerMessage): RenderedMessage {
  const body = stripContainerScaffolding(envelope.muddown);
  // Discord rejects embeds with an empty description (HTTP 400). Drop
  // the message entirely when the envelope contains only container
  // scaffolding so the bot doesn't fail silently.
  if (!body) return { embeds: [], components: [] };
  // BLOCK_COLORS is exhaustive over ServerMessage["type"] — TypeScript
  // guarantees a hit; no runtime fallback needed.
  const color = BLOCK_COLORS[envelope.type];
  const title = titleFor(envelope);
  const embeds = chunkDescription(body).map((description) => ({
    title,
    description,
    color,
  }));
  return { embeds, components: [] };
}
