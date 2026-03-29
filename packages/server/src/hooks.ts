import type { HookEvent, HookContext } from "@muddown/shared";

// ─── Hook Handler Type ───────────────────────────────────────────────────────

export type HookHandler = (ctx: HookContext) => HookResult | undefined;

export interface HookResult {
  message?: string;   // MUDdown text to send to the triggering player
  broadcast?: string; // MUDdown text to broadcast to all players in the room
}

// ─── Hook Registry ───────────────────────────────────────────────────────────
// Hooks are registered per entity (by ID) and per event type.
// Multiple hooks can be registered for the same entity + event.

const registry = new Map<string, Map<HookEvent, HookHandler[]>>();

function hookKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

export function registerHook(
  entityType: "npc" | "item" | "room",
  entityId: string,
  event: HookEvent,
  handler: HookHandler,
): void {
  const key = hookKey(entityType, entityId);
  let entityHooks = registry.get(key);
  if (!entityHooks) {
    entityHooks = new Map();
    registry.set(key, entityHooks);
  }
  let handlers = entityHooks.get(event);
  if (!handlers) {
    handlers = [];
    entityHooks.set(event, handlers);
  }
  handlers.push(handler);
}

export function fireHook(ctx: HookContext): HookResult[] {
  const key = hookKey(ctx.entityType, ctx.entityId);
  const entityHooks = registry.get(key);
  if (!entityHooks) return [];

  const handlers = entityHooks.get(ctx.event);
  if (!handlers) return [];

  const results: HookResult[] = [];
  for (const handler of handlers) {
    try {
      const result = handler(ctx);
      if (result) results.push(result);
    } catch (err) {
      console.error(`Hook handler error for ${ctx.entityType}:${ctx.entityId} ${ctx.event}:`, err);
    }
  }
  return results;
}

export function clearHooks(): void {
  registry.clear();
}

// ─── Built-in Hook: NPC One-Time Greeting ────────────────────────────────────
// Tracks which (npcId, playerId) pairs have already greeted, so an NPC
// greets a player only once per server session.

const greeted = new Set<string>();

export function resetGreetings(): void {
  greeted.clear();
}

export function createGreetingHook(npcId: string, greeting: string): HookHandler {
  return (ctx: HookContext): HookResult | undefined => {
    if (ctx.event !== "onContact") return undefined;
    if (ctx.contactType !== "player") return undefined;
    const key = `${npcId}:${ctx.contactId}`;
    if (greeted.has(key)) return undefined;
    greeted.add(key);
    return { message: greeting };
  };
}
