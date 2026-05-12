import { describe, it, expect, vi } from "vitest";
import type { ServerMessage } from "@muddown/shared";
import {
  decodeLinkCustomId,
  DISCORD_LIMITS,
  extractGameLinks,
  LINK_SELECT_CUSTOM_ID,
  renderEnvelope,
  stripContainerScaffolding,
  chunkDescription,
  BLOCK_COLORS,
  type RenderedButton,
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

  it("strips interactive-scheme links from the description", () => {
    // Discord embed Markdown does not treat custom URI schemes as
    // hyperlinks, so `[label](go:...)` would render as literal source
    // text. The renderer drops the URI part — interactivity is provided
    // by buttons under the embed.
    const result = renderEnvelope(
      envelope({
        type: "room",
        muddown: "A [stone marker](cmd:examine marker) stands here.\n- [North](go:north) — Road",
      }),
    );
    expect(result.embeds[0]!.description).toBe("A stone marker stands here.\n- North — Road");
    // External http(s) links still pass through untouched.
    const result2 = renderEnvelope(
      envelope({
        type: "narrative",
        muddown: "See the [spec](https://example.com/spec) for details.",
      }),
    );
    expect(result2.embeds[0]!.description).toBe(
      "See the [spec](https://example.com/spec) for details.",
    );
  });

  it("renders game links into button components", () => {
    const result = renderEnvelope(
      envelope({
        type: "room",
        muddown: "- [North](go:north)\n- [Look](cmd:look)",
      }),
    );

    expect(result.components).toHaveLength(1);
    expect(Array.isArray(result.components[0])).toBe(true);
    const buttonRow = result.components[0];
    if (!Array.isArray(buttonRow)) {
      throw new Error("Expected first component to be a button row");
    }
    for (const button of buttonRow) {
      expect(button.type).toBe("button");
    }
    const typedButtonRow = buttonRow as RenderedButton[];
    expect(typedButtonRow.map((button) => button.label)).toEqual(["North", "Look"]);
    expect(decodeLinkCustomId(typedButtonRow[0]!.customId)).toBe("go north");
    expect(decodeLinkCustomId(typedButtonRow[1]!.customId)).toBe("look");
  });

  it("adds overflow select when links exceed button row capacity", () => {
    const links = Array.from({ length: 26 }, (_, index) => `- [Go ${index}](go:${index})`).join("\n");
    const result = renderEnvelope(envelope({ type: "room", muddown: links }));

    expect(result.components).toHaveLength(DISCORD_LIMITS.rowsPerMessage);
    const last = result.components[result.components.length - 1];
    expect(Array.isArray(last)).toBe(false);
    expect((last as { customId: string }).customId).toBe(LINK_SELECT_CUSTOM_ID);
    // 6 = 26 links - 20 buttons (4 rows x 5 buttons).
    expect((last as { options: unknown[] }).options).toHaveLength(6);
  });

  it("warns and annotates select placeholder when links are truncated", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const links = Array.from({ length: 60 }, (_, index) => `- [Go ${index}](go:${index})`).join("\n");
      const result = renderEnvelope(envelope({ type: "room", muddown: links }));

      const last = result.components[result.components.length - 1];
      expect(Array.isArray(last)).toBe(false);
      expect((last as { customId: string }).customId).toBe(LINK_SELECT_CUSTOM_ID);
      expect((last as { placeholder: string }).placeholder).toBe("More actions (showing 45 of 60)");

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("links dropped due to Discord component limits");
      expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
        totalLinks: 60,
        shownLinks: 45,
        dropped: 15,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("extractGameLinks", () => {
  it("deduplicates identical links and ignores unsupported schemes", () => {
    const links = extractGameLinks(
      [
        "[North](go:north)",
        "[North](go:north)",
        "[Site](url:https://example.com)",
      ].join("\n"),
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.label).toBe("North");
    expect(decodeLinkCustomId(links[0]!.customId)).toBe("go north");
  });

  it("matches labels containing escaped closing brackets", () => {
    const links = extractGameLinks("[label\\]](go:north)");
    expect(links).toHaveLength(1);
    expect(links[0]!.label).toBe("label]");
    expect(decodeLinkCustomId(links[0]!.customId)).toBe("go north");
  });

  it("supports npc and item schemes", () => {
    const links = extractGameLinks(
      [
        "[Blacksmith](npc:blacksmith)",
        "[Rusty Key](item:rusty-key)",
      ].join("\n"),
    );

    expect(links).toHaveLength(2);
    expect(decodeLinkCustomId(links[0]!.customId)).toBe("talk blacksmith");
    expect(decodeLinkCustomId(links[1]!.customId)).toBe("examine rusty-key");
  });

  it("truncates long labels to 80 characters", () => {
    const label = `${"L".repeat(79)}ABCD`;
    const links = extractGameLinks(`[${label}](go:north)`);

    expect(links).toHaveLength(1);
    expect(links[0]!.label).toHaveLength(80);
    expect(links[0]!.label).toBe(`${"L".repeat(79)}A`);
  });

  it("drops links whose encoded custom id would exceed Discord limits", () => {
    const longTarget = "x".repeat(120);
    const links = extractGameLinks(`[Too Long](cmd:${longTarget})`);
    expect(links).toEqual([]);
  });

  it("ignores links with empty labels or targets", () => {
    const links = extractGameLinks(
      [
        "[](go:north)",
        "[North](go:)",
      ].join("\n"),
    );
    expect(links).toEqual([]);
  });
});

