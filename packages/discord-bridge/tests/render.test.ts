import { describe, it, expect } from "vitest";
import type { ServerMessage } from "@muddown/shared";
import {
  renderEnvelope,
  stripContainerScaffolding,
  chunkDescription,
  BLOCK_COLORS,
  DISCORD_LIMITS,
} from "../src/render.js";

function envelope(partial: Partial<ServerMessage> & Pick<ServerMessage, "type" | "muddown">): ServerMessage {
  return {
    v: 1,
    id: "test-id",
    timestamp: "2026-05-08T00:00:00.000Z",
    ...partial,
  };
}

describe("stripContainerScaffolding", () => {
  it("removes ::: room container fences", () => {
    const input = ':::room{id="town-square"}\n# Town Square\n\nA bustling square.\n:::';
    expect(stripContainerScaffolding(input)).toBe("# Town Square\n\nA bustling square.");
  });

  it("removes leading YAML frontmatter", () => {
    const input = "---\nid: x\n---\n:::system\nHello.\n:::";
    expect(stripContainerScaffolding(input)).toBe("Hello.");
  });

  it("returns the body unchanged when there's no container", () => {
    expect(stripContainerScaffolding("Plain text.")).toBe("Plain text.");
  });

  it("only strips the outer close fence, not an inner one", () => {
    // A nested ::: fence on its own line inside the body must survive.
    const input = ':::room\nOuter line.\n\n:::dialogue\nInner.\n:::\n\nOuter trailing.\n:::';
    const result = stripContainerScaffolding(input);
    expect(result).toBe("Outer line.\n\n:::dialogue\nInner.\n:::\n\nOuter trailing.");
  });

  it("leaves an unclosed frontmatter fence intact", () => {
    // Without a closing `---`, the leading-frontmatter strip must no-op.
    const input = "---\nid: x\nMore body without closing marker.";
    expect(stripContainerScaffolding(input)).toBe(input);
  });
});

describe("chunkDescription", () => {
  it("returns a single chunk when under the limit", () => {
    expect(chunkDescription("short")).toEqual(["short"]);
  });

  it("splits on paragraph boundaries when over the limit", () => {
    const para = "x".repeat(3000);
    const text = `${para}\n\n${para}`;
    const chunks = chunkDescription(text);
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(DISCORD_LIMITS.embedDescription);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("hard-cuts when no paragraph break is reachable", () => {
    const text = "x".repeat(DISCORD_LIMITS.embedDescription + 100);
    const chunks = chunkDescription(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.length).toBe(DISCORD_LIMITS.embedDescription);
  });

  it("falls back to a whitespace boundary instead of mid-word", () => {
    // No paragraph breaks, but spaces every ~50 chars.
    const word = "y".repeat(49);
    const max = 200;
    const text = Array(20).fill(word).join(" ");
    const chunks = chunkDescription(text, max);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(max);
    }
    expect(chunks.join("")).toBe(text);
  });
});

describe("renderEnvelope", () => {
  it("renders a room envelope with the room color", () => {
    const result = renderEnvelope(
      envelope({
        type: "room",
        muddown: ':::room{id="town-square"}\n# Town Square\n\nThe heart of town.\n:::',
      }),
    );
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0]!.title).toBe("Room");
    expect(result.embeds[0]!.description).toBe("# Town Square\n\nThe heart of town.");
    expect(result.embeds[0]!.color).toBe(BLOCK_COLORS.room);
    expect(result.components).toEqual([]);
  });

  it("uses the system color for system envelopes", () => {
    const result = renderEnvelope(
      envelope({ type: "system", muddown: ":::system\nServer restart in 5 minutes.\n:::" }),
    );
    expect(result.embeds[0]!.color).toBe(BLOCK_COLORS.system);
    expect(result.embeds[0]!.title).toBe("System");
  });

  it("uses the combat color for combat envelopes", () => {
    const result = renderEnvelope(
      envelope({ type: "combat", muddown: ":::combat\nYou strike the goblin.\n:::" }),
    );
    expect(result.embeds[0]!.color).toBe(BLOCK_COLORS.combat);
    expect(result.embeds[0]!.title).toBe("Combat");
  });

  it("uses the dialogue color for dialogue envelopes", () => {
    const result = renderEnvelope(
      envelope({ type: "dialogue", muddown: ':::dialogue\n"Hello, traveler."\n:::' }),
    );
    expect(result.embeds[0]!.color).toBe(BLOCK_COLORS.dialogue);
    expect(result.embeds[0]!.title).toBe("Dialogue");
  });

  it("uses the narrative color for narrative envelopes", () => {
    const result = renderEnvelope(envelope({ type: "narrative", muddown: "A breeze stirs." }));
    expect(result.embeds[0]!.color).toBe(BLOCK_COLORS.narrative);
    expect(result.embeds[0]!.title).toBe("Narrative");
  });

  it("returns no embeds when the body is empty after stripping", () => {
    // Container scaffolding only — Discord rejects embeds with empty
    // descriptions, so the renderer must drop the message entirely.
    const result = renderEnvelope(envelope({ type: "system", muddown: ":::system\n:::" }));
    expect(result.embeds).toEqual([]);
    expect(result.components).toEqual([]);
  });

  it("splits long bodies across multiple embeds and preserves content", () => {
    const long = "x".repeat(5000);
    const result = renderEnvelope(envelope({ type: "narrative", muddown: long }));
    expect(result.embeds.length).toBeGreaterThan(1);
    for (const embed of result.embeds) {
      expect(embed.description.length).toBeLessThanOrEqual(DISCORD_LIMITS.embedDescription);
    }
    // No paragraph or whitespace boundaries in the source, so hard-cuts
    // preserve the full content when joined back.
    expect(result.embeds.map((e) => e.description).join("")).toBe(long);
  });
});

