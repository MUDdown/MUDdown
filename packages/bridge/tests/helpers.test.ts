import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, getBanner, wsToHttpBase } from "../src/helpers.js";

// ─── wsToHttpBase ────────────────────────────────────────────────────────────

describe("wsToHttpBase", () => {
  it("converts wss:// to https://", () => {
    expect(wsToHttpBase("wss://muddown.com/ws")).toBe("https://muddown.com");
  });

  it("converts ws:// to http://", () => {
    expect(wsToHttpBase("ws://localhost:3300/ws")).toBe("http://localhost:3300");
  });

  it("strips trailing /ws with subdomain and port", () => {
    expect(wsToHttpBase("wss://sub.example.com:1234/ws")).toBe("https://sub.example.com:1234");
  });

  it("preserves path if not /ws", () => {
    expect(wsToHttpBase("wss://example.com/other")).toBe("https://example.com/other");
  });

  it("returns input unchanged for non-ws URLs", () => {
    expect(wsToHttpBase("https://example.com")).toBe("https://example.com");
  });
});

// ─── getBanner ───────────────────────────────────────────────────────────────

describe("getBanner", () => {
  it("includes the server name", () => {
    const banner = getBanner("TestServer");
    expect(banner).toContain("TestServer");
  });

  it("uses telnet line endings (\\r\\n)", () => {
    const banner = getBanner("TestServer");
    // All newlines should be \r\n (telnet convention)
    const lines = banner.split("\r\n");
    expect(lines.length).toBeGreaterThan(5);
    // No bare \n without preceding \r
    expect(banner).not.toMatch(/[^\r]\n/);
  });

  it("includes login instructions", () => {
    const banner = getBanner("TestServer");
    expect(banner).toContain("login");
    expect(banner).toContain("linkmode");
  });
});

// ─── loadConfig ──────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  const envBackup: Record<string, string | undefined> = {};
  const envKeys = [
    "BRIDGE_PORT",
    "TELNET_TLS_CERT",
    "TELNET_TLS_KEY",
    "GAME_SERVER_URL",
    "TELNET_KEEPALIVE_MS",
    "BRIDGE_SERVER_NAME",
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (envBackup[key] !== undefined) {
        process.env[key] = envBackup[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it("returns defaults when no env vars are set", () => {
    const config = loadConfig();
    expect(config.port).toBe(2323);
    expect(config.tlsCert).toBe("");
    expect(config.tlsKey).toBe("");
    expect(config.gameServerUrl).toBe("wss://muddown.com/ws");
    expect(config.keepaliveMs).toBe(30000);
    expect(config.serverName).toBe("MUDdown");
  });

  it("reads BRIDGE_PORT", () => {
    process.env.BRIDGE_PORT = "4000";
    expect(loadConfig().port).toBe(4000);
  });

  it("reads TLS cert and key paths", () => {
    process.env.TELNET_TLS_CERT = "/etc/ssl/cert.pem";
    process.env.TELNET_TLS_KEY = "/etc/ssl/key.pem";
    const config = loadConfig();
    expect(config.tlsCert).toBe("/etc/ssl/cert.pem");
    expect(config.tlsKey).toBe("/etc/ssl/key.pem");
  });

  it("reads GAME_SERVER_URL", () => {
    process.env.GAME_SERVER_URL = "ws://localhost:3300/ws";
    expect(loadConfig().gameServerUrl).toBe("ws://localhost:3300/ws");
  });

  it("reads TELNET_KEEPALIVE_MS", () => {
    process.env.TELNET_KEEPALIVE_MS = "60000";
    expect(loadConfig().keepaliveMs).toBe(60000);
  });

  it("reads BRIDGE_SERVER_NAME", () => {
    process.env.BRIDGE_SERVER_NAME = "MyMUD";
    expect(loadConfig().serverName).toBe("MyMUD");
  });

  it("falls back to defaults for non-numeric BRIDGE_PORT", () => {
    process.env.BRIDGE_PORT = "abc";
    expect(loadConfig().port).toBe(2323);
  });

  it("falls back to defaults for non-numeric TELNET_KEEPALIVE_MS", () => {
    process.env.TELNET_KEEPALIVE_MS = "";
    expect(loadConfig().keepaliveMs).toBe(30000);
  });
});
