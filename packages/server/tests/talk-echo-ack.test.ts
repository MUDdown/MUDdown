import { describe, it, expect } from "vitest";
import {
  buildPlayerTalkEcho,
  buildNpcAcknowledgement,
  buildTalkFillerMessages,
  NPC_ACKNOWLEDGEMENT_POSES,
} from "../src/helpers.js";

describe("buildPlayerTalkEcho", () => {
  it("wraps the player's message in a :::dialogue block naming the NPC", () => {
    const block = buildPlayerTalkEcho("crier", "Town Crier", "What news of the realm?");
    expect(block).toBe(
      `:::dialogue{npc="crier" mood="player-says"}\n` +
      `> **You** say to **Town Crier**, "What news of the realm?"\n` +
      `:::`,
    );
  });

  it("escapes double-quotes in the player's message so attributes don't break", () => {
    const block = buildPlayerTalkEcho("guard-7", "Town Guard", 'I said "stop"!');
    expect(block).toContain(`"I said 'stop'!"`);
    expect(block).not.toContain(`""`);
  });

  it("trims surrounding whitespace from the message", () => {
    const block = buildPlayerTalkEcho("crier", "Town Crier", "   hello   ");
    expect(block).toContain(`"hello"`);
  });

  it("returns an empty string for empty or whitespace-only messages", () => {
    expect(buildPlayerTalkEcho("crier", "Town Crier", "")).toBe("");
    expect(buildPlayerTalkEcho("crier", "Town Crier", "   \n\t  ")).toBe("");
  });
});

describe("buildNpcAcknowledgement", () => {
  it("emits a :::dialogue block with the NPC id, a thoughtful mood, and a pose line", () => {
    const rng = () => 0; // always selects the first pose
    const block = buildNpcAcknowledgement("crier", "Town Crier", rng);
    expect(block).toBe(
      `:::dialogue{npc="crier" mood="thoughtful"}\n` +
      `**Town Crier** ${NPC_ACKNOWLEDGEMENT_POSES[0]}.\n` +
      `:::`,
    );
  });

  it("uses the RNG to deterministically select a pose", () => {
    // rng() * length = 2 → index 2
    const rng = () => 2 / NPC_ACKNOWLEDGEMENT_POSES.length;
    const block = buildNpcAcknowledgement("crier", "Town Crier", rng);
    expect(block).toContain(NPC_ACKNOWLEDGEMENT_POSES[2]);
  });

  it("handles rng values at or near 1.0 without overflowing the pose list", () => {
    // Math.random() never returns exactly 1, but guard against pathological rngs.
    const rng = () => 0.9999999;
    const block = buildNpcAcknowledgement("crier", "Town Crier", rng);
    // Math.floor(0.9999999 * N) === N - 1 for any N > 0 — explicit index
    // so the assertion keeps testing the "last element" claim even if
    // someone adds poses.
    const last = NPC_ACKNOWLEDGEMENT_POSES[NPC_ACKNOWLEDGEMENT_POSES.length - 1];
    expect(block).toContain(last);
  });

  it("clamps pathological rng values >= 1.0 to the last pose instead of emitting undefined", () => {
    // Math.floor(1.0 * N) === N (out of bounds) — the clamp should recover.
    const rng = () => 1.0;
    const block = buildNpcAcknowledgement("crier", "Town Crier", rng);
    expect(block).not.toContain("undefined");
    const last = NPC_ACKNOWLEDGEMENT_POSES[NPC_ACKNOWLEDGEMENT_POSES.length - 1];
    expect(block).toContain(last);
  });

  it("never emits the literal string 'undefined' even with a hostile rng", () => {
    for (const value of [-1, 0, 0.5, 1.0, 5, NaN, Infinity]) {
      const block = buildNpcAcknowledgement("crier", "Town Crier", () => value);
      expect(block).not.toContain("undefined");
      expect(block).toMatch(/\*\*Town Crier\*\* [^.]+\./);
    }
  });

  it("defaults to Math.random when no rng is supplied", () => {
    const block = buildNpcAcknowledgement("crier", "Town Crier");
    expect(block).toMatch(/^:::dialogue\{npc="crier" mood="thoughtful"\}\n/);
    expect(block).toMatch(/\n:::$/);
    const pose = NPC_ACKNOWLEDGEMENT_POSES.some((p) => block.includes(p));
    expect(pose).toBe(true);
  });
});

describe("NPC_ACKNOWLEDGEMENT_POSES", () => {
  it("contains at least a handful of variety so players don't see the same line often", () => {
    expect(NPC_ACKNOWLEDGEMENT_POSES.length).toBeGreaterThanOrEqual(4);
  });

  it("poses are sentence fragments that read naturally after an NPC name", () => {
    // e.g. "Crier pauses, considering your words." — no leading capital, no trailing punctuation.
    for (const pose of NPC_ACKNOWLEDGEMENT_POSES) {
      expect(pose[0]).toBe(pose[0].toLowerCase());
      expect(pose.endsWith(".")).toBe(false);
      expect(pose.endsWith("!")).toBe(false);
    }
  });
});

describe("buildTalkFillerMessages", () => {
  const rng = () => 0; // deterministic pose selection

  it("returns an empty array for the 'start' greeting path (playerMessage === null)", () => {
    // No utterance to echo and no perceived gap worth filling — the caller
    // is about to issue the opening greeting to the LLM.
    expect(buildTalkFillerMessages("crier", "Town Crier", null, rng)).toEqual([]);
  });

  it("returns [echo, ack] for a normal player utterance, in display order", () => {
    const messages = buildTalkFillerMessages("crier", "Town Crier", "hello there", rng);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain(`> **You** say to **Town Crier**, "hello there"`);
    expect(messages[1]).toContain(`**Town Crier** ${NPC_ACKNOWLEDGEMENT_POSES[0]}.`);
  });

  it("suppresses the echo but still emits the acknowledgement for a whitespace-only utterance", () => {
    // The player typed something like `talk crier    ` — we can't echo
    // nothing meaningful back, but the NPC should still acknowledge the
    // interaction so the channel doesn't feel dead.
    const messages = buildTalkFillerMessages("crier", "Town Crier", "   \t  ", rng);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/^:::dialogue\{npc="crier" mood="thoughtful"\}/);
  });

  it("suppresses the echo but still emits the acknowledgement for an empty-string utterance (same as whitespace-only via the trim in echo)", () => {
    const messages = buildTalkFillerMessages("crier", "Town Crier", "", rng);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("thoughtful");
  });

  it("never emits a block containing the literal string 'undefined'", () => {
    const messages = buildTalkFillerMessages("crier", "Town Crier", "test", () => 1.0);
    for (const m of messages) {
      expect(m).not.toContain("undefined");
    }
  });

  it("defaults to Math.random when rng is not supplied", () => {
    const messages = buildTalkFillerMessages("crier", "Town Crier", "hi");
    expect(messages).toHaveLength(2);
    // Any of the real poses is fine.
    const hasKnownPose = NPC_ACKNOWLEDGEMENT_POSES.some((p) => messages[1].includes(p));
    expect(hasKnownPose).toBe(true);
  });
});

