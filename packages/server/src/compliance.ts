import { WebSocket } from "ws";
import type { CertificationTier, ConformanceLevel } from "@muddown/shared";
import type { GameDatabase } from "./db/types.js";

// ─── Compliance Check Result ─────────────────────────────────────────────────

export interface ComplianceCheckResult {
  checkedAt: string;          // ISO 8601
  reachable: boolean;
  wireProtocol: boolean;      // responds with valid v:1 JSON envelope
  containerBlocks: boolean;   // muddown field contains :::type{} blocks
  interactiveLinks: boolean;  // muddown field contains cmd: or go: link schemes
  wireId: boolean;            // envelope contains string `id` field
  wireTimestamp: boolean;     // envelope contains string `timestamp` field
  errors: string[];
}

// ─── Single Server Check ─────────────────────────────────────────────────────

const CHECK_TIMEOUT_MS = 10_000;
const TIMEOUT_ERROR = "Connection timed out";

/**
 * Probe a single game server via WebSocket and validate MUDdown compliance.
 * Returns a ComplianceCheckResult describing what passed/failed.
 */
export function checkServer(hostname: string, port: number | null, protocol: string): Promise<ComplianceCheckResult> {
  return new Promise((resolve) => {
    const result: ComplianceCheckResult = {
      checkedAt: new Date().toISOString(),
      reachable: false,
      wireProtocol: false,
      containerBlocks: false,
      interactiveLinks: false,
      wireId: false,
      wireTimestamp: false,
      errors: [],
    };

    // Only WebSocket servers can be auto-verified
    if (protocol !== "websocket") {
      result.errors.push(`Automated checks only support WebSocket servers (got "${protocol}")`);
      resolve(result);
      return;
    }

    const wsPort = port ?? 3300;
    const wsUrl = `ws://${hostname}:${wsPort}`;
    let settled = false;

    function settle(): void {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, { handshakeTimeout: CHECK_TIMEOUT_MS });
    } catch (err) {
      result.errors.push(`Connection failed: ${String(err)}`);
      settle();
      return;
    }

    const timeout = setTimeout(() => {
      result.errors.push(TIMEOUT_ERROR);
      ws.terminate();
      settle();
    }, CHECK_TIMEOUT_MS);

    ws.on("open", () => {
      result.reachable = true;
    });

    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        let text: string;
        if (typeof data === "string") {
          text = data;
        } else if (Array.isArray(data)) {
          text = Buffer.concat(data).toString("utf8");
        } else {
          text = data.toString("utf8");
        }
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Non-JSON traffic (e.g., WebSocket pings) is not MUDdown-compliant but expected
        return;
      }
      if (msg.v === 1 && typeof msg.muddown === "string" && typeof msg.type === "string") {
        result.wireProtocol = true;
        const md = msg.muddown as string;
        if (/^:::[a-z]+\{/m.test(md)) {
          result.containerBlocks = true;
        }
        if (/\[.*?\]\((cmd|go):/.test(md)) {
          result.interactiveLinks = true;
        }
        if (typeof msg.id === "string" && msg.id.length > 0) {
          result.wireId = true;
        }
        if (typeof msg.timestamp === "string" && msg.timestamp.length > 0) {
          result.wireTimestamp = true;
        }
      }
      if (result.wireProtocol && result.containerBlocks && result.interactiveLinks && result.wireId && result.wireTimestamp) {
        // Full conformance — all signals observed
        clearTimeout(timeout);
        ws.close();
        settle();
      } else if (result.wireProtocol && result.containerBlocks && result.interactiveLinks) {
        // Interactive conformance — wireId/wireTimestamp are envelope-level fields;
        // if absent from this message they won't appear in later ones.
        clearTimeout(timeout);
        ws.close();
        settle();
      }
    });

    ws.on("error", (err) => {
      result.errors.push(`WebSocket error: ${err.message}`);
      clearTimeout(timeout);
      settle();
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      settle();
    });
  });
}

// ─── Determine Conformance Level from Check ─────────────────────────────────

/**
 * Derive which spec conformance level a server satisfies based on check results.
 *
 * - **full**: wire protocol with id+timestamp, container blocks, interactive links
 * - **interactive**: container blocks + interactive links (cmd:/go:)
 * - **text**: reachable + wire protocol (content is valid Markdown in muddown field)
 * - **null**: unreachable or no wire protocol
 */
export function conformanceLevelFromResult(result: ComplianceCheckResult): ConformanceLevel | null {
  if (!result.reachable || !result.wireProtocol) return null;

  if (result.containerBlocks && result.interactiveLinks && result.wireId && result.wireTimestamp) {
    return "full";
  }
  if (result.containerBlocks && result.interactiveLinks) {
    return "interactive";
  }
  return "text";
}

// ─── Determine Certification from Check ──────────────────────────────────────

export function certificationFromResult(result: ComplianceCheckResult, currentTier: CertificationTier): CertificationTier {
  if (result.reachable && result.wireProtocol && result.containerBlocks) {
    return "verified";
  }
  // If it was previously verified but now fails, downgrade to self-certified
  // (the operator claimed compliance at registration)
  if (currentTier === "verified") {
    return "self-certified";
  }
  return currentTier;
}

// ─── Batch Check (Daily) ─────────────────────────────────────────────────────

/**
 * Run compliance checks on all registered servers that use the WebSocket
 * protocol. Updates the DB with results and adjusts certification tiers.
 */
let running = false;

export async function runComplianceChecks(db: Pick<GameDatabase, "getAllGameServers" | "updateGameServerCheck">): Promise<void> {
  if (running) {
    console.warn("Compliance check skipped — previous run still in progress.");
    return;
  }
  running = true;
  let failureCount = 0;
  try {
    const servers = db.getAllGameServers();
    const wsServers = servers.filter(s => s.protocol === "websocket");

    console.log(`Running compliance checks on ${wsServers.length} WebSocket server(s)...`);

    for (const server of wsServers) {
      let result: ComplianceCheckResult;
      try {
        result = await checkServer(server.hostname, server.port, server.protocol);
      } catch (err) {
        console.error(`  ${server.name} (${server.hostname}): probe threw unexpectedly —`, err);
        failureCount++;
        continue;
      }
      const newTier = certificationFromResult(result, server.certification);
      try {
        const newLevel = conformanceLevelFromResult(result);
        const timedOut = result.errors.some(e => e === TIMEOUT_ERROR);
        if (timedOut && result.wireProtocol) {
          console.warn(
            `  ${server.name} (${server.hostname}): timed out before all conformance signals observed ` +
            `(interactiveLinks=${result.interactiveLinks}, wireId=${result.wireId}, wireTimestamp=${result.wireTimestamp}) — ` +
            `conformance capped at "${newLevel ?? "none"}"`
          );
        }
        db.updateGameServerCheck(server.id, JSON.stringify(result), newTier, newLevel);
        console.log(`  ${server.name} (${server.hostname}): ${newTier} (${newLevel ?? "none"}) — reachable=${result.reachable}, wire=${result.wireProtocol}, blocks=${result.containerBlocks}`);
      } catch (err) {
        console.error(`  ${server.name} (${server.hostname}): DB write failed after successful probe (tier=${newTier}, level=unknown) —`, err);
        failureCount++;
      }
    }

    if (failureCount > 0) {
      console.warn(`Compliance checks finished with ${failureCount} failure(s). See errors above.`);
    } else {
      console.log("Compliance checks complete.");
    }
  } finally {
    running = false;
  }
}
