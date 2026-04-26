import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, getBanner, getStartupMenu, wsToHttpBase, buildLoginUrl, updateTtypeCycle, deriveLinkMode, nextLinkMode } from "../src/helpers.js";

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

  it("converts wss:// to https:// when URL has no path", () => {
    expect(wsToHttpBase("wss://muddown.com")).toBe("https://muddown.com");
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

  it("includes the welcome message", () => {
    const banner = getBanner("TestServer");
    expect(banner).toContain("Welcome to TestServer");
  });

  it("points users at the bridge help command", () => {
    const banner = getBanner("TestServer");
    expect(banner).toContain("Type 'help'");
  });
});

// ─── getStartupMenu ──────────────────────────────────────────────────────────

describe("getStartupMenu", () => {
  it("offers all three startup choices in stable order", () => {
    const menu = getStartupMenu();
    const idxLogin = menu.indexOf("[1] Log in to an existing character");
    const idxCreate = menu.indexOf("[2] Create a new character");
    const idxGuest = menu.indexOf("[3] Play as a guest");
    expect(idxLogin).toBeGreaterThan(-1);
    expect(idxCreate).toBeGreaterThan(idxLogin);
    expect(idxGuest).toBeGreaterThan(idxCreate);
  });

  it("uses telnet line endings (\\r\\n)", () => {
    const menu = getStartupMenu();
    expect(menu).toContain("\r\n");
    expect(menu).not.toMatch(/[^\r]\n/);
  });
});

// ─── buildLoginUrl ───────────────────────────────────────────────────────────

describe("buildLoginUrl", () => {
  it("encodes provider and nonce as query parameters", () => {
    const url = buildLoginUrl("https://muddown.com", "github", "abc-123");
    expect(url).toBe("https://muddown.com/auth/login?provider=github&login_nonce=abc-123");
  });

  it("URL-encodes provider names with reserved characters", () => {
    const url = buildLoginUrl("https://muddown.com", "name with space", "n");
    // URLSearchParams uses application/x-www-form-urlencoded which
    // encodes spaces as '+'. Servers decode '+' back to space, so this is
    // wire-equivalent to %20.
    expect(url).toContain("provider=name+with+space");
  });

  it("URL-encodes nonces with reserved characters", () => {
    const url = buildLoginUrl("https://muddown.com", "github", "a&b=c");
    expect(url).toContain("login_nonce=a%26b%3Dc");
  });

  it("collapses a trailing slash on publicBase", () => {
    const url = buildLoginUrl("https://muddown.com/", "github", "n");
    expect(url).toBe("https://muddown.com/auth/login?provider=github&login_nonce=n");
  });

  it("preserves a path prefix on publicBase", () => {
    const url = buildLoginUrl("https://muddown.com/api", "github", "n");
    expect(url).toBe("https://muddown.com/api/auth/login?provider=github&login_nonce=n");
  });

  it("preserves a path prefix with trailing slash on publicBase", () => {
    const url = buildLoginUrl("https://muddown.com/api/", "github", "n");
    expect(url).toBe("https://muddown.com/api/auth/login?provider=github&login_nonce=n");
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
    "PUBLIC_BASE_URL",
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
    expect(config.publicBaseUrl).toBeUndefined();
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

  it("reads PUBLIC_BASE_URL", () => {
    process.env.PUBLIC_BASE_URL = "https://muddown.com";
    expect(loadConfig().publicBaseUrl).toBe("https://muddown.com");
  });

  it("strips trailing slash from PUBLIC_BASE_URL", () => {
    process.env.PUBLIC_BASE_URL = "https://muddown.com/";
    expect(loadConfig().publicBaseUrl).toBe("https://muddown.com");
  });

  it("treats empty PUBLIC_BASE_URL as unset", () => {
    process.env.PUBLIC_BASE_URL = "";
    expect(loadConfig().publicBaseUrl).toBeUndefined();
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

// ─── updateTtypeCycle ────────────────────────────────────────────────────────

describe("updateTtypeCycle", () => {
  it("returns done:true with existing types when incoming is undefined", () => {
    const result = updateTtypeCycle(["XTERM"], undefined);
    expect(result).toEqual({ done: true, types: ["XTERM"] });
  });

  it("returns done:true when incoming repeats a value already seen", () => {
    const result = updateTtypeCycle(["MUDLET", "XTERM-256COLOR"], "MUDLET");
    expect(result).toEqual({ done: true, types: ["MUDLET", "XTERM-256COLOR"] });
  });

  it("returns done:false and appends a new type", () => {
    const result = updateTtypeCycle(["MUDLET"], "XTERM-256COLOR");
    expect(result).toEqual({ done: false, types: ["MUDLET", "XTERM-256COLOR"] });
  });

  it("returns done:false for the first type on an empty list", () => {
    const result = updateTtypeCycle([], "MUDLET");
    expect(result).toEqual({ done: false, types: ["MUDLET"] });
  });

  it("returns done:true for empty list with undefined incoming", () => {
    const result = updateTtypeCycle([], undefined);
    expect(result).toEqual({ done: true, types: [] });
  });

  it("does not mutate the existing array", () => {
    const existing = ["MUDLET"];
    updateTtypeCycle(existing, "XTERM-256COLOR");
    expect(existing).toEqual(["MUDLET"]);
  });
});

// ─── deriveLinkMode ──────────────────────────────────────────────────────────

describe("deriveLinkMode", () => {
  it("returns the explicit override when set", () => {
    const caps = new Set(["OSC_HYPERLINKS_SEND"]);
    expect(deriveLinkMode("numbered", caps)).toBe("numbered");
    expect(deriveLinkMode("plain", caps)).toBe("plain");
    expect(deriveLinkMode("osc8", new Set())).toBe("osc8");
  });

  it("auto-selects osc8-send when OSC_HYPERLINKS_SEND is advertised", () => {
    const caps = new Set(["OSC_HYPERLINKS", "OSC_HYPERLINKS_SEND"]);
    expect(deriveLinkMode(undefined, caps)).toBe("osc8-send");
  });

  it("falls back to plain when no send capability is advertised", () => {
    expect(deriveLinkMode(undefined, new Set())).toBe("plain");
    expect(deriveLinkMode(undefined, new Set(["OSC_HYPERLINKS"]))).toBe("plain");
  });

  it("override wins even when capabilities would suggest otherwise", () => {
    const caps = new Set(["OSC_HYPERLINKS_SEND"]);
    expect(deriveLinkMode("plain", caps)).toBe("plain");
  });
});

// ─── nextLinkMode ────────────────────────────────────────────────────────────

describe("nextLinkMode", () => {
  it("cycles auto → plain → numbered → osc8-send → auto for capable clients", () => {
    const caps = new Set(["OSC_HYPERLINKS_SEND"]);
    expect(nextLinkMode(undefined, caps)).toBe("plain");
    expect(nextLinkMode("plain", caps)).toBe("numbered");
    expect(nextLinkMode("numbered", caps)).toBe("osc8-send");
    expect(nextLinkMode("osc8-send", caps)).toBeUndefined();
  });

  it("skips osc8-send for non-capable clients", () => {
    const caps = new Set<string>();
    expect(nextLinkMode(undefined, caps)).toBe("plain");
    expect(nextLinkMode("plain", caps)).toBe("numbered");
    expect(nextLinkMode("numbered", caps)).toBeUndefined();
  });

  it("treats OSC_HYPERLINKS alone as non-capable for send mode", () => {
    const caps = new Set(["OSC_HYPERLINKS"]);
    expect(nextLinkMode("numbered", caps)).toBeUndefined();
  });
});
