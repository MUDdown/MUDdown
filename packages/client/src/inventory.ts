/**
 * Inventory state types and runtime validation.
 *
 * These types mirror the `inventoryState` payload the server sends in
 * `msg.meta.inventoryState` so any client can validate and render it.
 */

export interface InvItem {
  id: string;
  name: string;
  equippable: boolean;
  usable: boolean;
}

export interface InvState {
  items: InvItem[];
  equipped: Record<string, { id: string; name: string } | null>;
}

/** Runtime type guard for an {@link InvState} payload. */
export function isInvState(v: unknown): v is InvState {
  if (v === null || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  if (!Array.isArray(obj.items)) return false;

  const allItemsValid = obj.items.every((item: unknown) => {
    if (item === null || typeof item !== "object") return false;
    const it = item as Record<string, unknown>;
    return (
      typeof it.id === "string" &&
      typeof it.name === "string" &&
      typeof it.equippable === "boolean" &&
      typeof it.usable === "boolean"
    );
  });
  if (!allItemsValid) return false;

  const equipped = obj.equipped;
  if (equipped === null || typeof equipped !== "object" || Array.isArray(equipped)) return false;

  return Object.values(equipped as Record<string, unknown>).every(val => {
    if (val === null) return true;
    if (typeof val !== "object") return false;
    const vObj = val as Record<string, unknown>;
    return typeof vObj.id === "string" && typeof vObj.name === "string";
  });
}
