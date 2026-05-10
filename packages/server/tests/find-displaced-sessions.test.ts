import { describe, it, expect, vi } from "vitest";
import { findDisplacedSessions, displaceSession } from "../src/helpers.js";

interface MockSession {
  characterId: string | null;
  name: string;
  currentRoom: string;
}

describe("findDisplacedSessions", () => {
  it("returns an empty array when the sessions map is empty", () => {
    const newWs = { id: "new" };
    const sessions = new Map<object, MockSession>();
    expect(findDisplacedSessions(sessions, newWs, "char-42")).toEqual([]);
  });

  it("returns the existing session bound to the same characterId", () => {
    const oldWs = { id: "old" };
    const newWs = { id: "new" };
    const sessions = new Map<object, MockSession>([
      [oldWs, { characterId: "char-42", name: "Alice", currentRoom: "town-square" }],
    ]);
    const result = findDisplacedSessions(sessions, newWs, "char-42");
    expect(result).toHaveLength(1);
    expect(result[0].ws).toBe(oldWs);
    expect(result[0].session.name).toBe("Alice");
  });

  it("excludes the new ws even if it is already in the map", () => {
    const ws = { id: "shared" };
    const sessions = new Map<object, MockSession>([
      [ws, { characterId: "char-42", name: "Alice", currentRoom: "town-square" }],
    ]);
    expect(findDisplacedSessions(sessions, ws, "char-42")).toEqual([]);
  });

  it("returns nothing when the new connection is a guest", () => {
    const oldWs = { id: "old" };
    const newWs = { id: "new" };
    const sessions = new Map<object, MockSession>([
      [oldWs, { characterId: "char-42", name: "Alice", currentRoom: "town-square" }],
      [newWs, { characterId: null, name: "Guest-1", currentRoom: "town-square" }],
    ]);
    expect(findDisplacedSessions(sessions, newWs, null)).toEqual([]);
  });

  it("does not match other characters or other guests", () => {
    const wsA = { id: "a" };
    const wsB = { id: "b" };
    const wsGuest = { id: "g" };
    const newWs = { id: "new" };
    const sessions = new Map<object, MockSession>([
      [wsA, { characterId: "char-42", name: "Alice", currentRoom: "town-square" }],
      [wsB, { characterId: "char-99", name: "Bob", currentRoom: "tavern" }],
      [wsGuest, { characterId: null, name: "Guest-1", currentRoom: "town-square" }],
    ]);
    const result = findDisplacedSessions(sessions, newWs, "char-99");
    expect(result.map((r) => r.ws)).toEqual([wsB]);
  });

  it("returns multiple matches when more than one stale session shares the character", () => {
    // Defensive: the eviction loop runs on every connect, so in practice
    // there's at most one stale session — but if a previous bug ever leaks
    // duplicates into the map, we want to evict all of them.
    const wsA = { id: "a" };
    const wsB = { id: "b" };
    const newWs = { id: "new" };
    const sessions = new Map<object, MockSession>([
      [wsA, { characterId: "char-42", name: "Alice", currentRoom: "town-square" }],
      [wsB, { characterId: "char-42", name: "Alice", currentRoom: "town-square" }],
    ]);
    const result = findDisplacedSessions(sessions, newWs, "char-42");
    expect(result).toHaveLength(2);
  });
});

describe("displaceSession", () => {
  function makeMatch() {
    const ws = { id: "old" } as const;
    const session: MockSession = {
      characterId: "char-42",
      name: "Alice",
      currentRoom: "town-square",
    };
    return { ws, session };
  }

  it("calls effects in order: save → delete → notify → close", () => {
    const order: string[] = [];
    const match = makeMatch();
    displaceSession(match, {
      save: () => { order.push("save"); return true; },
      deleteFromRegistry: () => { order.push("delete"); },
      notify: () => { order.push("notify"); },
      close: () => { order.push("close"); },
    });
    expect(order).toEqual(["save", "delete", "notify", "close"]);
  });

  it("invokes onSaveFailed when save returns false but still proceeds with eviction", () => {
    // Save failure must not abort eviction — the new connection has
    // already claimed the character and the old socket needs to be told
    // to go away regardless of whether DB persistence succeeded.
    const match = makeMatch();
    const onSaveFailed = vi.fn();
    const close = vi.fn();
    displaceSession(match, {
      save: () => false,
      deleteFromRegistry: () => undefined,
      notify: () => undefined,
      close,
      onSaveFailed,
    });
    expect(onSaveFailed).toHaveBeenCalledWith(match.session);
    expect(close).toHaveBeenCalledWith(match.ws);
  });

  it("swallows notify and close errors so a misbehaving socket cannot block eviction", () => {
    const match = makeMatch();
    const deleteFromRegistry = vi.fn();
    displaceSession(match, {
      save: () => true,
      deleteFromRegistry,
      notify: () => { throw new Error("send failed"); },
      close: () => { throw new Error("close failed"); },
    });
    // Both effects threw, but the registry was still cleared first.
    expect(deleteFromRegistry).toHaveBeenCalledWith(match.ws);
  });

  it("swallows a throwing save and treats it as a save failure", () => {
    // Mirrors the notify/close error-isolation guarantee: a thrown DB
    // error must not abort eviction, otherwise the stale session stays
    // bound and the new connection fights it.
    const match = makeMatch();
    const onSaveFailed = vi.fn();
    const close = vi.fn();
    const deleteFromRegistry = vi.fn();
    displaceSession(match, {
      save: () => { throw new Error("DB connection failed"); },
      deleteFromRegistry,
      notify: () => undefined,
      close,
      onSaveFailed,
    });
    expect(onSaveFailed).toHaveBeenCalledWith(match.session);
    expect(deleteFromRegistry).toHaveBeenCalledWith(match.ws);
    expect(close).toHaveBeenCalledWith(match.ws);
  });

  it("swallows a throwing deleteFromRegistry so notify and close still run", () => {
    // If a future registry implementation throws on delete, we still
    // want to notify and close the old socket — otherwise the stale
    // connection stays open and re-creates the ping-pong condition this
    // helper exists to prevent.
    const match = makeMatch();
    const notify = vi.fn();
    const close = vi.fn();
    displaceSession(match, {
      save: () => true,
      deleteFromRegistry: () => { throw new Error("registry corrupt"); },
      notify,
      close,
    });
    expect(notify).toHaveBeenCalledWith(match.ws);
    expect(close).toHaveBeenCalledWith(match.ws);
  });
});
