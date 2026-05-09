import { describe, expect, it } from "vitest";
import {
  dispatchGameplayCommand,
  handleReconnectError,
  handleSocketClose,
  refreshReconnectTicket,
  resolveGameplayInteractionCommand,
} from "../src/bridge-policy.js";
import { encodeLinkCustomId, LINK_SELECT_CUSTOM_ID } from "../src/render.js";

describe("resolveGameplayInteractionCommand", () => {
  it("resolves button custom ids", () => {
    const encoded = encodeLinkCustomId("go north");
    expect(encoded).toBeDefined();
    if (encoded == null) {
      throw new Error("encodeLinkCustomId returned null");
    }
    expect(resolveGameplayInteractionCommand(encoded, [])).toBe("go north");
  });

  it("resolves select-menu values", () => {
    const encoded = encodeLinkCustomId("look");
    expect(encoded).toBeDefined();
    if (encoded == null) {
      throw new Error("encodeLinkCustomId returned null");
    }
    expect(resolveGameplayInteractionCommand(LINK_SELECT_CUSTOM_ID, [encoded])).toBe("look");
  });

  it("returns undefined for invalid custom ids", () => {
    expect(resolveGameplayInteractionCommand("invalid", [])).toBeUndefined();
    expect(resolveGameplayInteractionCommand(LINK_SELECT_CUSTOM_ID, [])).toBeUndefined();
  });
});

describe("dispatchGameplayCommand", () => {
  it("forwards command when session and connection exist", () => {
    const sessions = { get: (id: string) => (id === "u1" ? { discordUserId: "u1" } : undefined) };
    const sent: string[] = [];
    const connections = new Map<string, { send(command: string): boolean }>([
      [
        "u1",
        {
          send(command: string): boolean {
            sent.push(command);
            return true;
          },
        },
      ],
    ]);

    const closed: string[] = [];
    const result = dispatchGameplayCommand("u1", "go north", sessions, connections, (id) => closed.push(id));
    expect(result).toBe(true);
    expect(sent).toEqual(["go north"]);
    expect(closed).toEqual([]);
  });

  it("returns false when session is missing", () => {
    const sessions = { get: () => undefined };
    const connections = new Map<string, { send(command: string): boolean }>();
    const closed: string[] = [];
    const result = dispatchGameplayCommand("u1", "go north", sessions, connections, (id) => closed.push(id));
    expect(result).toBe(false);
    expect(closed).toEqual([]);
  });

  it("closes session when connection send fails", () => {
    const sessions = { get: (id: string) => (id === "u1" ? { discordUserId: "u1" } : undefined) };
    const connections = new Map<string, { send(command: string): boolean }>([
      ["u1", { send: () => false }],
    ]);
    const closed: string[] = [];
    const result = dispatchGameplayCommand("u1", "look", sessions, connections, (id) => closed.push(id));
    expect(result).toBe(false);
    expect(closed).toEqual(["u1"]);
  });
});

describe("refreshReconnectTicket", () => {
  it("returns refreshed ticket when session exists", async () => {
    const sessions = { get: (id: string) => (id === "u1" ? { sessionToken: "tok-1" } : undefined) };
    const fetchWsTicket = async (sessionToken: string): Promise<string | undefined> =>
      sessionToken === "tok-1" ? "ticket-1" : undefined;

    await expect(refreshReconnectTicket("u1", sessions, fetchWsTicket)).resolves.toBe("ticket-1");
  });

  it("throws when session is missing", async () => {
    const sessions = { get: () => undefined };
    const fetchWsTicket = async (): Promise<string | undefined> => "ticket-1";

    await expect(refreshReconnectTicket("u1", sessions, fetchWsTicket)).rejects.toThrow(
      /No active session available for websocket reconnect/,
    );
  });

  it("throws when ticket refresh returns empty", async () => {
    const sessions = { get: (id: string) => (id === "u1" ? { sessionToken: "tok-1" } : undefined) };
    const fetchWsTicket = async (): Promise<string | undefined> => undefined;

    await expect(refreshReconnectTicket("u1", sessions, fetchWsTicket)).rejects.toThrow(
      /Failed to refresh websocket ticket/,
    );
  });
});

describe("handleReconnectError", () => {
  it("closes session with notification enabled", () => {
    const calls: Array<{ discordUserId: string; notify: boolean }> = [];

    handleReconnectError("u1", (discordUserId, notify) => {
      calls.push({ discordUserId, notify });
    });

    expect(calls).toEqual([{ discordUserId: "u1", notify: true }]);
  });
});

describe("handleSocketClose", () => {
  it("does not close session while reconnecting", () => {
    const calls: Array<{ discordUserId: string; notify: boolean }> = [];

    handleSocketClose("u1", true, (discordUserId, notify) => {
      calls.push({ discordUserId, notify });
    });

    expect(calls).toEqual([]);
  });

  it("closes session with notification when reconnect is not continuing", () => {
    const calls: Array<{ discordUserId: string; notify: boolean }> = [];

    handleSocketClose("u1", false, (discordUserId, notify) => {
      calls.push({ discordUserId, notify });
    });

    expect(calls).toEqual([{ discordUserId: "u1", notify: true }]);
  });
});
