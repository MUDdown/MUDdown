import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function createFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "muddown-test-"));
  mkdirSync(join(dir, "items"), { recursive: true });
  mkdirSync(join(dir, "npcs"), { recursive: true });
  return dir;
}

export function cleanupFixtureDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function writeRoom(dir: string, region: string, filename: string, content: string): void {
  const regionDir = join(dir, region);
  mkdirSync(regionDir, { recursive: true });
  writeFileSync(join(regionDir, filename), content);
}

export function writeItem(dir: string, filename: string, item: Record<string, unknown>): void {
  writeFileSync(join(dir, "items", filename), JSON.stringify(item, null, 2));
}

export function writeNpc(dir: string, filename: string, npc: Record<string, unknown>): void {
  writeFileSync(join(dir, "npcs", filename), JSON.stringify(npc, null, 2));
}

export function writeRecipes(dir: string, recipes: Record<string, unknown>[]): void {
  writeFileSync(join(dir, "recipes.json"), JSON.stringify(recipes, null, 2));
}
