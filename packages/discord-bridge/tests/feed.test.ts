import { describe, it, expect } from "vitest";
import type { ServerMessage } from "@muddown/shared";
import { isWorldScopeEnvelope } from "../src/feed.js";

function envelope(overrides: Partial<ServerMessage> = {}): ServerMessage {
  return {
    v: 1,
    id: "00000000-0000-0000-0000-000000000000",
    type: "system",
    timestamp: "2026-05-09T00:00:00Z",
    muddown: ':::system{type="notification" scope="world"}\n**Server**: rebooting in 5 minutes.\n:::',
    ...overrides,
  };
}

describe("isWorldScopeEnvelope", () => {
  it("accepts a system envelope with scope=\"world\"", () => {
    expect(isWorldScopeEnvelope(envelope())).toBe(true);
  });

  it("rejects scope=\"player\"", () => {
    expect(
      isWorldScopeEnvelope(
        envelope({
          muddown: ':::system{type="welcome" scope="player"}\nhi\n:::',
        }),
      ),
    ).toBe(false);
  });

  it("rejects a missing scope (defaults to player per spec §3.6)", () => {
    expect(
      isWorldScopeEnvelope(
        envelope({ muddown: ':::system{type="welcome"}\nhi\n:::' }),
      ),
    ).toBe(false);
  });

  it("rejects unknown scope values (forward-compat: never accidentally broadcast)", () => {
    expect(
      isWorldScopeEnvelope(
        envelope({ muddown: ':::system{scope="region"}\nhi\n:::' }),
      ),
    ).toBe(false);
  });

  it("rejects non-system envelope types even when the body claims scope=world", () => {
    for (const type of ["room", "combat", "dialogue", "narrative"] as const) {
      expect(
        isWorldScopeEnvelope(
          envelope({
            type,
            muddown: ':::system{scope="world"}\nspoof\n:::',
          }),
        ),
      ).toBe(false);
    }
  });

  it("rejects an empty muddown payload", () => {
    expect(isWorldScopeEnvelope(envelope({ muddown: "" }))).toBe(false);
  });

  it("rejects malformed muddown without a system fence", () => {
    expect(
      isWorldScopeEnvelope(envelope({ muddown: "no fences here, just text" })),
    ).toBe(false);
  });

  it("looks past leading YAML frontmatter", () => {
    expect(
      isWorldScopeEnvelope(
        envelope({
          muddown: '---\nid: boot-notice\n---\n:::system{scope="world"}\nrebooting\n:::',
        }),
      ),
    ).toBe(true);
  });

  it("ignores nested fences after the outer system fence (anchors on the first match)", () => {
    // The first system fence has scope=world; an inner unrelated fence is irrelevant.
    expect(
      isWorldScopeEnvelope(
        envelope({
          muddown:
            ':::system{scope="world"}\nThe gates open: :::room{id="x"}\nignored\n:::\n:::',
        }),
      ),
    ).toBe(true);
  });
});
