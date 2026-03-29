import { describe, it, expect } from "vitest";
import type { NpcDefinition } from "@muddown/shared";
import { findNpcInRoom } from "../src/helpers.js";

function makeNpc(overrides: Partial<NpcDefinition> & { id: string; name: string }): NpcDefinition {
  return {
    description: "Test NPC",
    location: "test-room",
    dialogue: { start: { text: "Hello", responses: [] } },
    ...overrides,
  } as NpcDefinition;
}

describe("findNpcInRoom", () => {
  const guard = makeNpc({ id: "guard-7", name: "Gate Guard", location: "gate" });
  const baker = makeNpc({ id: "baker", name: "Baker Marta", location: "bakery" });
  const crier = makeNpc({ id: "crier", name: "Town Crier", location: "gate" });

  const npcDefs = new Map<string, NpcDefinition>([
    ["guard-7", guard],
    ["baker", baker],
    ["crier", crier],
  ]);

  const roomNpcs = new Map<string, string[]>([
    ["gate", ["guard-7", "crier"]],
    ["bakery", ["baker"]],
  ]);

  it("finds NPC by exact id", () => {
    expect(findNpcInRoom("guard-7", "gate", roomNpcs, npcDefs)).toBe(guard);
  });

  it("finds NPC by exact name (case-insensitive)", () => {
    expect(findNpcInRoom("Gate Guard", "gate", roomNpcs, npcDefs)).toBe(guard);
    expect(findNpcInRoom("gate guard", "gate", roomNpcs, npcDefs)).toBe(guard);
  });

  it("finds NPC by partial id match", () => {
    expect(findNpcInRoom("guard", "gate", roomNpcs, npcDefs)).toBe(guard);
  });

  it("finds NPC by partial name match", () => {
    expect(findNpcInRoom("Town", "gate", roomNpcs, npcDefs)).toBe(crier);
  });

  it("returns undefined when NPC not in specified room", () => {
    expect(findNpcInRoom("baker", "gate", roomNpcs, npcDefs)).toBeUndefined();
  });

  it("returns undefined when room has no NPCs", () => {
    expect(findNpcInRoom("guard", "empty-room", roomNpcs, npcDefs)).toBeUndefined();
  });

  it("returns undefined for no match", () => {
    expect(findNpcInRoom("wizard", "gate", roomNpcs, npcDefs)).toBeUndefined();
  });

  it("prefers exact match over partial match", () => {
    const crierBob = makeNpc({ id: "crier-bob", name: "Crier Bob", location: "gate" });
    const extDefs = new Map(npcDefs);
    extDefs.set("crier-bob", crierBob);
    const extRoomNpcs = new Map(roomNpcs);
    extRoomNpcs.set("gate", ["guard-7", "crier", "crier-bob"]);
    expect(findNpcInRoom("crier", "gate", extRoomNpcs, extDefs)).toBe(crier);
  });
});
