import { describe, it, expect, beforeEach } from "vitest";
import {
  registerHook, fireHook, clearHooks,
  createGreetingHook, resetGreetings,
} from "../src/hooks.js";
import type { HookContext } from "@muddown/shared";

beforeEach(() => {
  clearHooks();
  resetGreetings();
});

// ─── registerHook / fireHook ─────────────────────────────────────────────────

describe("registerHook + fireHook", () => {
  it("passes the full HookContext to the handler", () => {
    let capturedCtx: HookContext | undefined;
    registerHook("npc", "guard", "onContact", (ctx) => {
      capturedCtx = ctx;
      return undefined;
    });

    const ctx: HookContext = {
      event: "onContact",
      entityId: "guard",
      entityType: "npc",
      contactId: "player-1",
      contactType: "player",
      roomId: "town-square",
    };

    fireHook(ctx);
    expect(capturedCtx).toEqual(ctx);
  });

  it("fires a registered hook and returns results", () => {
    registerHook("npc", "guard", "onContact", () => ({
      message: "The guard nods at you.",
    }));

    const ctx: HookContext = {
      event: "onContact",
      entityId: "guard",
      entityType: "npc",
      contactId: "player-1",
      contactType: "player",
      roomId: "town-square",
    };

    const results = fireHook(ctx);
    expect(results).toHaveLength(1);
    expect(results[0].message).toBe("The guard nods at you.");
  });

  it("returns empty array when no hooks are registered", () => {
    const ctx: HookContext = {
      event: "onContact",
      entityId: "nobody",
      entityType: "npc",
      contactId: "player-1",
      contactType: "player",
      roomId: "test-room",
    };

    expect(fireHook(ctx)).toEqual([]);
  });

  it("fires multiple hooks for the same entity+event", () => {
    registerHook("npc", "guard", "onContact", () => ({ message: "First" }));
    registerHook("npc", "guard", "onContact", () => ({ message: "Second" }));

    const results = fireHook({
      event: "onContact",
      entityId: "guard",
      entityType: "npc",
      contactId: "player-1",
      contactType: "player",
      roomId: "town-square",
    });

    expect(results).toHaveLength(2);
    expect(results[0].message).toBe("First");
    expect(results[1].message).toBe("Second");
  });

  it("ignores hooks for different events", () => {
    registerHook("npc", "guard", "onCreate", () => ({ message: "Created!" }));

    const results = fireHook({
      event: "onContact",
      entityId: "guard",
      entityType: "npc",
      contactId: "player-1",
      contactType: "player",
      roomId: "town-square",
    });

    expect(results).toEqual([]);
  });

  it("ignores hooks for different entities", () => {
    registerHook("npc", "guard", "onContact", () => ({ message: "Hello" }));

    const results = fireHook({
      event: "onContact",
      entityId: "baker",
      entityType: "npc",
      contactId: "player-1",
      contactType: "player",
      roomId: "town-square",
    });

    expect(results).toEqual([]);
  });

  it("skips handlers that return undefined", () => {
    registerHook("npc", "guard", "onContact", () => undefined);
    registerHook("npc", "guard", "onContact", () => ({ message: "Only this" }));

    const results = fireHook({
      event: "onContact",
      entityId: "guard",
      entityType: "npc",
      contactId: "player-1",
      contactType: "player",
      roomId: "town-square",
    });

    expect(results).toHaveLength(1);
    expect(results[0].message).toBe("Only this");
  });

  it("catches handler exceptions and continues to remaining handlers", () => {
    registerHook("npc", "guard", "onContact", () => {
      throw new Error("boom");
    });
    registerHook("npc", "guard", "onContact", () => ({ message: "Still runs" }));

    const results = fireHook({
      event: "onContact",
      entityId: "guard",
      entityType: "npc",
      contactId: "player-1",
      contactType: "player",
      roomId: "town-square",
    });

    expect(results).toHaveLength(1);
    expect(results[0].message).toBe("Still runs");
  });
});

// ─── createGreetingHook ──────────────────────────────────────────────────────

describe("createGreetingHook", () => {
  it("greets a player once on first contact", () => {
    const handler = createGreetingHook("guard", "Welcome, traveler!");
    registerHook("npc", "guard", "onContact", handler);

    const ctx: HookContext = {
      event: "onContact",
      entityId: "guard",
      entityType: "npc",
      contactId: "player-1",
      contactType: "player",
      roomId: "town-square",
    };

    const first = fireHook(ctx);
    expect(first).toHaveLength(1);
    expect(first[0].message).toBe("Welcome, traveler!");

    // Second visit — no greeting
    const second = fireHook(ctx);
    expect(second).toEqual([]);
  });

  it("greets different players independently", () => {
    const handler = createGreetingHook("guard", "Hello!");
    registerHook("npc", "guard", "onContact", handler);

    const ctx1: HookContext = {
      event: "onContact",
      entityId: "guard",
      entityType: "npc",
      contactId: "player-1",
      contactType: "player",
      roomId: "town-square",
    };

    const ctx2: HookContext = {
      event: "onContact",
      entityId: "guard",
      entityType: "npc",
      contactId: "player-2",
      contactType: "player",
      roomId: "town-square",
    };

    expect(fireHook(ctx1)).toHaveLength(1);
    expect(fireHook(ctx2)).toHaveLength(1);
  });

  it("ignores non-contact events", () => {
    const handler = createGreetingHook("guard", "Hi!");
    registerHook("npc", "guard", "onReset", handler);

    const results = fireHook({
      event: "onReset",
      entityId: "guard",
      entityType: "npc",
      roomId: "town-square",
    });

    expect(results).toEqual([]);
  });

});

// ─── clearHooks / resetGreetings ─────────────────────────────────────────────

describe("clearHooks", () => {
  it("removes all registered hooks", () => {
    registerHook("npc", "guard", "onContact", () => ({ message: "Hello" }));
    clearHooks();

    const results = fireHook({
      event: "onContact",
      entityId: "guard",
      entityType: "npc",
      contactId: "player-1",
      contactType: "player",
      roomId: "town-square",
    });

    expect(results).toEqual([]);
  });
});

describe("resetGreetings", () => {
  it("allows greeting hooks to fire again after reset", () => {
    const handler = createGreetingHook("guard", "Hello!");
    registerHook("npc", "guard", "onContact", handler);

    const ctx: HookContext = {
      event: "onContact",
      entityId: "guard",
      entityType: "npc",
      contactId: "player-1",
      contactType: "player",
      roomId: "town-square",
    };

    // First greeting
    expect(fireHook(ctx)).toHaveLength(1);

    // No greeting (already greeted)
    expect(fireHook(ctx)).toEqual([]);

    // Reset and re-greet
    resetGreetings();
    expect(fireHook(ctx)).toHaveLength(1);
  });
});
