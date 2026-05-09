import { describe, it, expect } from "vitest";
import { SessionRegistry, type DiscordSession } from "../src/sessions.js";

function makeSession(overrides: Partial<DiscordSession> = {}): DiscordSession {
  return {
    discordUserId: "111111111111111111",
    accountId: "acct-1",
    sessionToken: "session-token-1",
    characterId: null,
    startedAt: new Date("2026-05-08T00:00:00.000Z"),
    lastActivityAt: new Date("2026-05-08T00:00:00.000Z"),
    ...overrides,
  };
}

describe("SessionRegistry", () => {
  it("starts empty", () => {
    const registry = new SessionRegistry();
    expect(registry.size()).toBe(0);
    expect(registry.get("anyone")).toBeUndefined();
  });

  it("opens and retrieves a session by Discord user ID", () => {
    const registry = new SessionRegistry();
    const session = makeSession();
    expect(registry.open(session)).toBe(true);
    expect(registry.size()).toBe(1);
    expect(registry.get(session.discordUserId)).toBe(session);
  });

  it("close() returns false for an unknown user", () => {
    const registry = new SessionRegistry();
    expect(registry.close("nobody")).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it("close() returns true for an open session and removes it", () => {
    const registry = new SessionRegistry();
    const session = makeSession();
    expect(registry.open(session)).toBe(true);
    expect(registry.close(session.discordUserId)).toBe(true);
    expect(registry.size()).toBe(0);
    expect(registry.get(session.discordUserId)).toBeUndefined();
  });

  it("size() tracks open and close across multiple users", () => {
    const registry = new SessionRegistry();
    const s1 = registry.open(makeSession({ discordUserId: "1" }));
    const s2 = registry.open(makeSession({ discordUserId: "2" }));
    expect(s1).toBe(true);
    expect(s2).toBe(true);
    expect(registry.size()).toBe(2);
    registry.close("1");
    expect(registry.size()).toBe(1);
  });

  it("ignores open() when discordUserId is empty", () => {
    const registry = new SessionRegistry();
    expect(registry.open(makeSession({ discordUserId: "" }))).toBe(false);
    expect(registry.open(makeSession({ discordUserId: "   " }))).toBe(false);
    expect(registry.size()).toBe(0);
  });

  it("get() and close() short-circuit for empty discordUserId", () => {
    const registry = new SessionRegistry();
    expect(registry.open(makeSession({ discordUserId: "1" }))).toBe(true);
    expect(registry.get("")).toBeUndefined();
    expect(registry.get("   ")).toBeUndefined();
    expect(registry.close("")).toBe(false);
    expect(registry.close("   ")).toBe(false);
    // Existing valid session remains untouched.
    expect(registry.size()).toBe(1);
    expect(registry.get("1")).toBeDefined();
  });

  it("open() returns false and preserves existing session when user already exists", () => {
    const registry = new SessionRegistry();
    const original = makeSession({ accountId: "acct-1" });
    const replacement = makeSession({ accountId: "acct-2" });
    expect(registry.open(original)).toBe(true);
    expect(registry.open(replacement)).toBe(false);
    expect(registry.size()).toBe(1);
    expect(registry.get(original.discordUserId)).toBe(original);
  });

  it("clear() removes all open sessions", () => {
    const registry = new SessionRegistry();
    expect(registry.open(makeSession({ discordUserId: "1" }))).toBe(true);
    expect(registry.open(makeSession({ discordUserId: "2" }))).toBe(true);
    expect(registry.size()).toBe(2);
    expect(registry.clear()).toBe(2);
    expect(registry.size()).toBe(0);
    expect(registry.get("1")).toBeUndefined();
    expect(registry.get("2")).toBeUndefined();
    expect(registry.open(makeSession({ discordUserId: "1" }))).toBe(true);
  });

  it("clear() returns zero when already empty", () => {
    const registry = new SessionRegistry();
    expect(registry.clear()).toBe(0);
  });

  it("touch() updates lastActivityAt for an open session", () => {
    const registry = new SessionRegistry();
    const session = makeSession();
    registry.open(session);
    const before = session.lastActivityAt;
    const next = new Date(before.getTime() + 60_000);
    expect(registry.touch(session.discordUserId, next)).toBe(true);
    expect(registry.get(session.discordUserId)?.lastActivityAt).toBe(next);
  });

  it("touch() defaults to a fresh Date when no timestamp is provided", () => {
    const registry = new SessionRegistry();
    const session = makeSession();
    registry.open(session);
    const before = session.lastActivityAt.getTime();
    expect(registry.touch(session.discordUserId)).toBe(true);
    const updated = registry.get(session.discordUserId)?.lastActivityAt;
    expect(updated).toBeInstanceOf(Date);
    expect((updated as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("touch() repeated calls always overwrite with the latest timestamp", () => {
    const registry = new SessionRegistry();
    const session = makeSession();
    registry.open(session);
    const first = new Date(session.lastActivityAt.getTime() + 1_000);
    const second = new Date(session.lastActivityAt.getTime() + 2_000);
    registry.touch(session.discordUserId, first);
    registry.touch(session.discordUserId, second);
    expect(registry.get(session.discordUserId)?.lastActivityAt).toBe(second);
  });

  it("touch() returns false for unknown or empty IDs", () => {
    const registry = new SessionRegistry();
    expect(registry.touch("nobody")).toBe(false);
    expect(registry.touch("")).toBe(false);
    expect(registry.touch("   ")).toBe(false);
  });

  it("values() returns an empty iterator when the registry is empty", () => {
    const registry = new SessionRegistry();
    expect(Array.from(registry.values())).toEqual([]);
  });

  it("values() iterates over open sessions", () => {
    const registry = new SessionRegistry();
    registry.open(makeSession({ discordUserId: "1" }));
    registry.open(makeSession({ discordUserId: "2" }));
    const ids = Array.from(registry.values()).map((session) => session.discordUserId).sort();
    expect(ids).toEqual(["1", "2"]);
  });
});
