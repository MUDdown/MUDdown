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

  it("rejects a `:::system{scope=\"world\"}` substring smuggled mid-line inside a per-player envelope", () => {
    // Hostile/legitimate-but-confusing per-player content that mentions the world fence
    // syntax in narrative text MUST NOT route to the public channel. The anchor is what
    // enforces this — without it the second fence on the line would be picked up.
    expect(
      isWorldScopeEnvelope(
        envelope({
          muddown:
            ':::system{type="hint" scope="player"}\nA world-fence looks like :::system{scope="world"} in the spec.\n:::',
        }),
      ),
    ).toBe(false);
  });

  it("rejects an envelope whose first non-blank line is narrative text, not a system fence", () => {
    expect(
      isWorldScopeEnvelope(
        envelope({
          muddown:
            'Some preamble text.\n:::system{scope="world"}\nbroadcast\n:::',
        }),
      ),
    ).toBe(false);
  });

  it("tolerates leading blank lines before the system fence", () => {
    expect(
      isWorldScopeEnvelope(
        envelope({
          muddown: '\n\n:::system{scope="world"}\nrebooting\n:::',
        }),
      ),
    ).toBe(true);
  });

  it("tolerates 3+ leading blank lines before the system fence", () => {
    // The `/^\s*\n/` strip is greedy and consumes runs of blank lines in one
    // pass. Pin that behavior so a future "simplification" to `/^\n/` (which
    // would only strip one blank line) breaks loudly instead of silently
    // routing legitimate world broadcasts to the floor.
    expect(
      isWorldScopeEnvelope(
        envelope({
          muddown: '\n\n\n:::system{scope="world"}\nrebooting\n:::',
        }),
      ),
    ).toBe(true);
  });

  it("fails closed when attribute parsing throws", () => {
    // parseAttributes treats certain odd inputs as throws; even if it didn't,
    // the contract here is fail-closed: never broadcast on a parse error.
    // We pick a deliberately weird shape that exercises the catch path
    // without depending on parser internals — if parseAttributes ever
    // changes to be more permissive, the worst case is the test still
    // rejects via the scope!=="world" branch, which is still correct.
    expect(
      isWorldScopeEnvelope(
        envelope({
          muddown: ':::system{scope=\u0000}\nbroken\n:::',
        }),
      ),
    ).toBe(false);
  });
});
