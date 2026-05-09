/**
 * MUDdown Discord Bridge — implementation entry.
 *
 * Imported by main.ts. The discord.js Client construction, slash command
 * registration, DM intake, and button handlers will land in follow-up
 * commits on this branch (see PROJECT_PLAN.md Phase 9a). For now this
 * file exposes a typed `main()` that fails fast on misconfiguration so
 * the package binary is wired end-to-end.
 */

import { loadConfig } from "./config.js";
import { SessionRegistry } from "./sessions.js";

class BridgeLifecycle {
  private isShuttingDown = false;

  async main(): Promise<void> {
    const config = loadConfig();
    const sessions = new SessionRegistry();
    void sessions; // wired into the discord.js client in the next commit
    // eslint-disable-next-line no-console
    console.log(
      `[muddown-discord-bridge] starting (server=${config.serverUrl}, guild=${config.guildId ?? "<global>"})`,
    );
    // discord.js Client.login() and event handler registration land in the next commit.
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    // discord.js client and upstream socket teardown wiring land in the next commit.
  }

  reset(): void {
    this.isShuttingDown = false;
  }
}

const bridgeLifecycle = new BridgeLifecycle();

export async function main(): Promise<void> {
  await bridgeLifecycle.main();
}

export async function shutdown(): Promise<void> {
  await bridgeLifecycle.shutdown();
}

export function resetBridgeForTests(): void {
  bridgeLifecycle.reset();
}
