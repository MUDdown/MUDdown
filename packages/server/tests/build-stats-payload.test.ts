import { describe, it, expect } from "vitest";
import { buildStatsPayload } from "../src/helpers.js";

function room(region: string | undefined): { attributes: Record<string, unknown> } {
  return { attributes: region === undefined ? {} : { region } };
}

describe("buildStatsPayload", () => {
  it("counts distinct non-empty regions as areas", () => {
    const rooms = new Map([
      ["a", room("village")],
      ["b", room("village")],
      ["c", room("forest")],
      ["d", room("forest")],
      ["e", room("cave")],
    ]);
    const p = buildStatsPayload({
      players: 0, uptime: 0, rooms,
      itemDefsSize: 0, npcDefsSize: 0, helpfilesCount: 0, classesCount: 0,
    });
    expect(p.areas).toBe(3);
    expect(p.rooms).toBe(5);
  });

  it("ignores rooms with missing, empty, or non-string region attributes", () => {
    const rooms = new Map<string, { attributes: Record<string, unknown> }>([
      ["a", { attributes: {} }],
      ["b", { attributes: { region: "" } }],
      ["c", { attributes: { region: 42 } }],
      ["d", { attributes: { region: "village" } }],
    ]);
    const p = buildStatsPayload({
      players: 0, uptime: 0, rooms,
      itemDefsSize: 0, npcDefsSize: 0, helpfilesCount: 0, classesCount: 0,
    });
    expect(p.areas).toBe(1);
  });

  it("passes through scalar counts and uptime", () => {
    const p = buildStatsPayload({
      players: 7,
      uptime: 1745500000,
      rooms: new Map(),
      itemDefsSize: 120,
      npcDefsSize: 23,
      helpfilesCount: 12,
      classesCount: 4,
    });
    expect(p).toEqual({
      players: 7,
      uptime: 1745500000,
      areas: 0,
      rooms: 0,
      objects: 120,
      mobiles: 23,
      helpfiles: 12,
      classes: 4,
      levels: 0,
    });
  });

  it("always emits levels=0 (no level system yet)", () => {
    const p = buildStatsPayload({
      players: 0, uptime: 0, rooms: new Map(),
      itemDefsSize: 0, npcDefsSize: 0, helpfilesCount: 0, classesCount: 0,
    });
    expect(p.levels).toBe(0);
  });
});
