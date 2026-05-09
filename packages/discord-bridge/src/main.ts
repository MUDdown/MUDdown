#!/usr/bin/env node

/**
 * MUDdown Discord Bridge — entry point.
 *
 * Parallel to packages/bridge/src/main.ts. Kept thin so future
 * environment-level setup (process.env tweaks, signal handlers) can
 * happen before the dynamic import of bridge.ts.
 */

process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("[muddown-discord-bridge] unhandled rejection:", reason);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  // eslint-disable-next-line no-console
  console.error("[muddown-discord-bridge] uncaught exception:", err);
  process.exit(1);
});

let shuttingDown = false;
let shutdownBridge: (() => Promise<void>) | undefined;

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (shuttingDown) {
      // eslint-disable-next-line no-console
      console.error(
        `[muddown-discord-bridge] received ${signal} during shutdown, forcing exit`,
      );
      process.exit(1);
    }

    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[muddown-discord-bridge] received ${signal}, shutting down gracefully`);

    void (async () => {
      try {
        if (shutdownBridge) await shutdownBridge();
        process.exit(0);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[muddown-discord-bridge] graceful shutdown failed:", err);
        process.exit(1);
      }
    })();
  });
}

const { main, shutdown } = await import("./bridge.js");
shutdownBridge = shutdown;
try {
  await main();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(
    `[muddown-discord-bridge] ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

export {};
