import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { GameDatabase } from "../src/db/types.js";
import type { GameServerRecord } from "@muddown/shared";

// Hoisted mock state — available to vi.mock factory
const { mockWsInstances } = vi.hoisted(() => ({
  mockWsInstances: [] as Array<{ handlers: Record<string, (...args: unknown[]) => void> }>,
}));

vi.mock("ws", () => ({
  WebSocket: class MockWebSocket {
    handlers: Record<string, (...args: unknown[]) => void> = {};
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers[event] = handler;
    }
    close() {}
    terminate() {}
    constructor() {
      mockWsInstances.push({ handlers: this.handlers });
    }
  },
}));

import { certificationFromResult, runComplianceChecks, type ComplianceCheckResult } from "../src/compliance.js";

function makeResult(overrides: Partial<ComplianceCheckResult> = {}): ComplianceCheckResult {
  return {
    checkedAt: new Date().toISOString(),
    reachable: false,
    wireProtocol: false,
    containerBlocks: false,
    errors: [],
    ...overrides,
  };
}

describe("certificationFromResult", () => {
  it("returns verified when all checks pass", () => {
    const result = makeResult({ reachable: true, wireProtocol: true, containerBlocks: true });
    expect(certificationFromResult(result, "listed")).toBe("verified");
    expect(certificationFromResult(result, "self-certified")).toBe("verified");
    expect(certificationFromResult(result, "verified")).toBe("verified");
  });

  it("downgrades verified to self-certified when checks fail", () => {
    const result = makeResult({ reachable: true, wireProtocol: true, containerBlocks: false });
    expect(certificationFromResult(result, "verified")).toBe("self-certified");
  });

  it("keeps listed tier when unreachable", () => {
    const result = makeResult({ reachable: false });
    expect(certificationFromResult(result, "listed")).toBe("listed");
  });

  it("keeps self-certified tier when unreachable", () => {
    const result = makeResult({ reachable: false });
    expect(certificationFromResult(result, "self-certified")).toBe("self-certified");
  });

  it("keeps self-certified tier when only partially passing", () => {
    const result = makeResult({ reachable: true, wireProtocol: false });
    expect(certificationFromResult(result, "self-certified")).toBe("self-certified");
  });

  it("keeps listed when missing wire protocol", () => {
    const result = makeResult({ reachable: true, wireProtocol: false, containerBlocks: false });
    expect(certificationFromResult(result, "listed")).toBe("listed");
  });

  it("keeps listed when missing container blocks", () => {
    const result = makeResult({ reachable: true, wireProtocol: true, containerBlocks: false });
    expect(certificationFromResult(result, "listed")).toBe("listed");
  });

  it("downgrades verified to self-certified when server is unreachable", () => {
    const result = makeResult({ reachable: false });
    expect(certificationFromResult(result, "verified")).toBe("self-certified");
  });
});

// ─── runComplianceChecks tests ───────────────────────────────────────────────

const validMessage = JSON.stringify({
  v: 1,
  type: "room",
  muddown: ':::room{id="test"}\n# Test\n:::',
});

function makeServer(overrides: Partial<GameServerRecord> = {}): GameServerRecord {
  return {
    id: "server-1",
    ownerId: "owner-1",
    name: "Test Server",
    description: "A test server",
    hostname: "localhost",
    port: 9999,
    protocol: "websocket",
    websiteUrl: null,
    certification: "self-certified",
    lastCheckAt: null,
    lastCheckResult: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

type ComplianceDb = Pick<GameDatabase, "getAllGameServers" | "updateGameServerCheck">;

function makeMockDb(servers: GameServerRecord[] = [makeServer()]): ComplianceDb {
  return {
    getAllGameServers: vi.fn(() => servers),
    updateGameServerCheck: vi.fn(),
  };
}

describe("runComplianceChecks", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockWsInstances.length = 0;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("skips if a previous run is still in progress", async () => {
    const db = makeMockDb();

    // First call suspends at await checkServer(...) — mock WS never settles
    const p1 = runComplianceChecks(db);

    // Second call should hit the overlap guard
    const p2 = runComplianceChecks(db);
    await p2;

    expect(warnSpy).toHaveBeenCalledWith(
      "Compliance check skipped — previous run still in progress."
    );

    // Settle the first run so the running flag resets
    const { handlers } = mockWsInstances[0];
    handlers["open"]?.();
    handlers["message"]?.(validMessage);

    await p1;
  });

  it("logs failure count when DB write throws", async () => {
    const db = makeMockDb();
    (db.updateGameServerCheck as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("DB write failed");
    });

    const p = runComplianceChecks(db);

    // Settle the check so the loop body continues to the DB write
    const { handlers } = mockWsInstances[0];
    handlers["open"]?.();
    handlers["message"]?.(validMessage);

    await p;

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Test Server"),
      expect.any(Error),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("1 failure")
    );
  });

  it("upgrades a reachable server to verified and writes to DB", async () => {
    const server = makeServer({ certification: "self-certified" });
    const db = makeMockDb([server]);

    const p = runComplianceChecks(db);

    const { handlers } = mockWsInstances[0];
    handlers["open"]?.();
    handlers["message"]?.(validMessage);

    await p;

    const calls = (db.updateGameServerCheck as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(server.id);
    const checkResult = JSON.parse(calls[0][1] as string);
    expect(checkResult.wireProtocol).toBe(true);
    expect(calls[0][2]).toBe("verified");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("skips non-WebSocket servers without probing", async () => {
    const server = makeServer({ protocol: "telnet", certification: "verified" });
    const db = makeMockDb([server]);

    await runComplianceChecks(db);

    expect(mockWsInstances).toHaveLength(0);
    expect(db.updateGameServerCheck).not.toHaveBeenCalled();
  });

  it("allows a new run after a previous one completes", async () => {
    const db = makeMockDb();

    // First run — complete it
    const p1 = runComplianceChecks(db);
    mockWsInstances[0].handlers["open"]?.();
    mockWsInstances[0].handlers["message"]?.(validMessage);
    await p1;

    // Second run — should not hit the overlap guard
    const p2 = runComplianceChecks(db);
    mockWsInstances[1].handlers["open"]?.();
    mockWsInstances[1].handlers["message"]?.(validMessage);
    await p2;

    expect(warnSpy).not.toHaveBeenCalledWith(
      "Compliance check skipped — previous run still in progress.",
    );
  });

  it("handles empty server list without errors", async () => {
    const db = makeMockDb([]);
    await runComplianceChecks(db);
    expect(mockWsInstances).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
