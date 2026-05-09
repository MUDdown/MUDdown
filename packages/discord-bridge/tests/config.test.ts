import { describe, it, expect } from "vitest";
import { loadConfig, DiscordBridgeConfigError } from "../src/config.js";

describe("loadConfig", () => {
  it("throws when MUDDOWN_DISCORD_BOT_TOKEN is absent", () => {
    try {
      loadConfig({ MUDDOWN_SERVER_URL: "ws://localhost:3300" });
      expect.fail("loadConfig should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DiscordBridgeConfigError);
      expect((err as Error).message).toMatch(/MUDDOWN_DISCORD_BOT_TOKEN is required/);
    }
  });

  it("throws when MUDDOWN_DISCORD_BOT_TOKEN is the empty string", () => {
    expect(() =>
      loadConfig({
        MUDDOWN_DISCORD_BOT_TOKEN: "",
        MUDDOWN_SERVER_URL: "ws://localhost:3300",
      }),
    ).toThrow(/MUDDOWN_DISCORD_BOT_TOKEN is required/);
  });

  it("throws when MUDDOWN_DISCORD_BOT_TOKEN is whitespace-only", () => {
    // Without a .trim(), discord.js would attempt to log in with "   "
    // and surface a cryptic API error far from startup.
    expect(() =>
      loadConfig({
        MUDDOWN_DISCORD_BOT_TOKEN: "   ",
        MUDDOWN_SERVER_URL: "ws://localhost:3300",
      }),
    ).toThrow(/MUDDOWN_DISCORD_BOT_TOKEN is required/);
  });

  it("throws when MUDDOWN_SERVER_URL is absent", () => {
    expect(() => loadConfig({ MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi" })).toThrow(
      /MUDDOWN_SERVER_URL is required/,
    );
  });

  it("throws when MUDDOWN_SERVER_URL is whitespace-only", () => {
    expect(() =>
      loadConfig({
        MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi",
        MUDDOWN_SERVER_URL: "   ",
      }),
    ).toThrow(/MUDDOWN_SERVER_URL is required/);
  });

  it("throws when MUDDOWN_SERVER_URL is not a valid URL", () => {
    expect(() =>
      loadConfig({
        MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi",
        MUDDOWN_SERVER_URL: "not-a-url",
      }),
    ).toThrow(/MUDDOWN_SERVER_URL must be a valid ws:\/\/ or wss:\/\/ URL/);
  });

  it("throws when MUDDOWN_SERVER_URL does not use ws/wss", () => {
    expect(() =>
      loadConfig({
        MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi",
        MUDDOWN_SERVER_URL: "https://muddown.com/ws",
      }),
    ).toThrow(/MUDDOWN_SERVER_URL must use ws:\/\/ or wss:\/\//);
  });

  it("returns a populated config when required vars are set", () => {
    const config = loadConfig({
      MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi",
      MUDDOWN_SERVER_URL: "ws://localhost:3300",
    });
    expect(config).toEqual({
      botToken: "abc.def.ghi",
      serverUrl: "ws://localhost:3300",
      guildId: undefined,
    });
  });

  it("trims surrounding whitespace from required vars", () => {
    const config = loadConfig({
      MUDDOWN_DISCORD_BOT_TOKEN: "  abc.def.ghi\n",
      MUDDOWN_SERVER_URL: " ws://localhost:3300 ",
    });
    expect(config.botToken).toBe("abc.def.ghi");
    expect(config.serverUrl).toBe("ws://localhost:3300");
  });

  it("includes guildId when MUDDOWN_DISCORD_GUILD_ID is set", () => {
    const config = loadConfig({
      MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi",
      MUDDOWN_SERVER_URL: "ws://localhost:3300",
      MUDDOWN_DISCORD_GUILD_ID: "123456789012345678",
    });
    expect(config.guildId).toBe("123456789012345678");
  });

  it("trims surrounding whitespace from guildId", () => {
    const config = loadConfig({
      MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi",
      MUDDOWN_SERVER_URL: "ws://localhost:3300",
      MUDDOWN_DISCORD_GUILD_ID: " 123456789012345678 ",
    });
    expect(config.guildId).toBe("123456789012345678");
  });

  it("converts whitespace-only guildId to undefined", () => {
    const config = loadConfig({
      MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi",
      MUDDOWN_SERVER_URL: "ws://localhost:3300",
      MUDDOWN_DISCORD_GUILD_ID: "   ",
    });
    expect(config.guildId).toBeUndefined();
  });

  it("leaves guildId undefined when MUDDOWN_DISCORD_GUILD_ID is absent", () => {
    const config = loadConfig({
      MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi",
      MUDDOWN_SERVER_URL: "ws://localhost:3300",
    });
    expect(config.guildId).toBeUndefined();
  });

  it("DiscordBridgeConfigError carries the right name for instanceof checks", () => {
    try {
      loadConfig({});
      expect.fail("loadConfig should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DiscordBridgeConfigError);
      expect((err as Error).name).toBe("DiscordBridgeConfigError");
    }
  });
});
