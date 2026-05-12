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
import { resolveGameLink } from "@muddown/client";
import { stripInteractiveLinks } from "./feed.js";
import { rewriteTables } from "./tables.js";

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
  selectOptions: 25,
});

export const LINK_CUSTOM_ID_PREFIX = "muddown-link:";
export const LINK_SELECT_CUSTOM_ID = "muddown-link-select";

const logger = {
  warn: (...args: unknown[]): void => {
    // eslint-disable-next-line no-console
    console.warn(...args);
  },
};

const SUPPORTED_LINK_SCHEMES = new Set(["go", "cmd", "item", "npc", "player", "help"]);

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

export interface RenderedGameLink {
  label: string;
  customId: string;
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

function cleanLabel(label: string): string {
  return label
    .replace(/\\(.)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function parseGameLink(match: RegExpMatchArray): RenderedGameLink | undefined {
  const label = cleanLabel(match[1] ?? "");
  const scheme = (match[2] ?? "").toLowerCase();
  const rawTarget = (match[3] ?? "").trim();
  if (!label || !SUPPORTED_LINK_SCHEMES.has(scheme) || !rawTarget) return undefined;
  const resolved = resolveGameLink(scheme, rawTarget);
  if (!resolved) return undefined;

  const customId = encodeLinkCustomId(resolved);
  if (!customId) return undefined;
  return { label, customId };
}

export function extractGameLinks(muddown: string): RenderedGameLink[] {
  const links: RenderedGameLink[] = [];
  const dedupe = new Set<string>();
  // Allow escaped characters in labels (for example: `[label\]](go:north)`).
  const regex = /\[((?:\\.|[^\]])+)\]\(([^:()\s]+):([^\)]+)\)/g;
  for (const match of muddown.matchAll(regex)) {
    const parsed = parseGameLink(match);
    if (!parsed) continue;
    const key = `${parsed.label}|${parsed.customId}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    links.push(parsed);
  }
  return links;
}

export function encodeLinkCustomId(command: string): string | undefined {
  const encoded = `${LINK_CUSTOM_ID_PREFIX}${encodeURIComponent(command)}`;
  return encoded.length <= DISCORD_LIMITS.customIdLength ? encoded : undefined;
}

export function decodeLinkCustomId(customId: string): string | undefined {
  if (!customId.startsWith(LINK_CUSTOM_ID_PREFIX)) return undefined;
  const encoded = customId.slice(LINK_CUSTOM_ID_PREFIX.length);
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

function buildComponents(links: RenderedGameLink[]): Array<RenderedButton[] | RenderedSelect> {
  if (links.length === 0) return [];

  const fullButtonCapacity = DISCORD_LIMITS.buttonsPerRow * DISCORD_LIMITS.rowsPerMessage;
  const needsOverflowSelect = links.length > fullButtonCapacity;
  const maxButtonRows = needsOverflowSelect
    ? DISCORD_LIMITS.rowsPerMessage - 1
    : DISCORD_LIMITS.rowsPerMessage;
  const maxButtons = DISCORD_LIMITS.buttonsPerRow * maxButtonRows;
  const buttonLinks = links.slice(0, maxButtons);
  const overflowLinks = links.slice(maxButtons, maxButtons + DISCORD_LIMITS.selectOptions);
  const shownLinks = maxButtons + overflowLinks.length;
  const dropped = Math.max(0, links.length - shownLinks);

  if (dropped > 0) {
    logger.warn("[muddown-discord-bridge] links dropped due to Discord component limits", {
      totalLinks: links.length,
      fullButtonCapacity,
      maxButtons,
      overflowOptions: overflowLinks.length,
      shownLinks,
      dropped,
    });
  }

  const rows: RenderedButton[][] = [];
  for (let index = 0; index < buttonLinks.length; index += DISCORD_LIMITS.buttonsPerRow) {
    rows.push(
      buttonLinks.slice(index, index + DISCORD_LIMITS.buttonsPerRow).map((link) => ({
        type: "button",
        label: link.label,
        customId: link.customId,
        style: 2,
      })),
    );
  }

  const components: Array<RenderedButton[] | RenderedSelect> = [...rows];
  if (overflowLinks.length > 0) {
    const placeholder = dropped > 0
      ? `More actions (showing ${shownLinks} of ${links.length})`
      : "More actions";
    components.push({
      type: "select",
      customId: LINK_SELECT_CUSTOM_ID,
      placeholder,
      options: overflowLinks.map((link) => ({
        label: link.label,
        value: link.customId,
      })),
    });
  }

  return components;
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
  const rawBody = stripContainerScaffolding(envelope.muddown);
  const links = extractGameLinks(rawBody);
  // Discord rejects embeds with an empty description (HTTP 400). Drop
  // the message entirely when the envelope contains only container
  // scaffolding so the bot doesn't fail silently.
  if (!rawBody) return { embeds: [], components: [] };
  // Discord's embed Markdown only treats `http(s):` as hyperlinks, so
  // `[north](go:north)` would render as the literal Markdown source.
  // Interactive links surface as buttons under the embed (built from
  // `links` below) — strip them from the description so the prose
  // reads as plain text rather than exposing the URI syntax.
  // Then rewrite GFM tables: Discord renders pipe-tables as literal
  // text, so 2-column tables become bullet lists and N-column tables
  // become padded code blocks. Tables run AFTER link stripping so the
  // bullet/code-block text is already plain prose.
  const description = rewriteTables(stripInteractiveLinks(rawBody));
  // BLOCK_COLORS is exhaustive over ServerMessage["type"] — TypeScript
  // guarantees a hit; no runtime fallback needed.
  const color = BLOCK_COLORS[envelope.type];
  const title = titleFor(envelope);
  const embeds = chunkDescription(description).map((chunk) => ({
    title,
    description: chunk,
    color,
  }));
  return { embeds, components: buildComponents(links) };
}
