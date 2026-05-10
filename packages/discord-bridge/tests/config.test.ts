import { describe, it, expect } from "vitest";
import { loadConfig, DiscordBridgeConfigError, parsePositiveIntEnv } from "../src/config.js";
import {
  GAMEPLAY_DELIVERY_BACKOFF_MS,
  GAMEPLAY_DELIVERY_RETRIES,
  MAX_CONSECUTIVE_DELIVERY_FAILURES,
  MAX_GAMEPLAY_DELIVERY_BACKOFF_MS,
} from "../src/delivery-policy.js";
import { IDLE_CHECK_INTERVAL_MS, IDLE_TIMEOUT_MS } from "../src/idle-policy.js";

const REQUIRED_ENV = {
  MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi",
  MUDDOWN_SERVER_URL: "ws://localhost:3300",
} as const;

const DEFAULT_TUNABLES = {
  idleTimeoutMs: IDLE_TIMEOUT_MS,
  idleCheckIntervalMs: IDLE_CHECK_INTERVAL_MS,
  deliveryRetries: GAMEPLAY_DELIVERY_RETRIES,
  deliveryBackoffMs: GAMEPLAY_DELIVERY_BACKOFF_MS,
  maxDeliveryBackoffMs: MAX_GAMEPLAY_DELIVERY_BACKOFF_MS,
  maxConsecutiveDeliveryFailures: MAX_CONSECUTIVE_DELIVERY_FAILURES,
};

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
      feedChannelId: undefined,
      tunables: DEFAULT_TUNABLES,
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

  it("includes feedChannelId when MUDDOWN_DISCORD_FEED_CHANNEL_ID is a valid snowflake", () => {
    const config = loadConfig({
      MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi",
      MUDDOWN_SERVER_URL: "ws://localhost:3300",
      MUDDOWN_DISCORD_FEED_CHANNEL_ID: "987654321098765432",
    });
    expect(config.feedChannelId).toBe("987654321098765432");
  });

  // Pin both ends of /^[1-9]\d{16,19}$/ so a future tightening (e.g. fixing
  // length to exactly 18) would surface as a regression rather than silently
  // rejecting historical or far-future Discord IDs.
  for (const good of [
    "12345678901234567",    // 17 digits (minimum)
    "12345678901234567890", // 20 digits (maximum)
  ]) {
    it(`accepts feedChannelId ${JSON.stringify(good)} at the snowflake length boundary`, () => {
      const config = loadConfig({
        MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi",
        MUDDOWN_SERVER_URL: "ws://localhost:3300",
        MUDDOWN_DISCORD_FEED_CHANNEL_ID: good,
      });
      expect(config.feedChannelId).toBe(good);
    });
  }

  it("trims surrounding whitespace from feedChannelId", () => {
    const config = loadConfig({
      MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi",
      MUDDOWN_SERVER_URL: "ws://localhost:3300",
      MUDDOWN_DISCORD_FEED_CHANNEL_ID: " 987654321098765432 ",
    });
    expect(config.feedChannelId).toBe("987654321098765432");
  });

  it("treats whitespace-only feedChannelId as unset", () => {
    const config = loadConfig({
      MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi",
      MUDDOWN_SERVER_URL: "ws://localhost:3300",
      MUDDOWN_DISCORD_FEED_CHANNEL_ID: "   ",
    });
    expect(config.feedChannelId).toBeUndefined();
  });

  it("leaves feedChannelId undefined when MUDDOWN_DISCORD_FEED_CHANNEL_ID is absent", () => {
    const config = loadConfig({
      MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi",
      MUDDOWN_SERVER_URL: "ws://localhost:3300",
    });
    expect(config.feedChannelId).toBeUndefined();
  });

  for (const bad of [
    "abc",                  // non-numeric
    "0123456789012345678",  // leading zero
    "1234567890123456",     // 16 digits (too short)
    "123456789012345678901",// 21 digits (too long)
    "12345 67890123456789", // embedded whitespace
    "123456789012345678a",  // trailing junk
  ]) {
    it(`rejects feedChannelId ${JSON.stringify(bad)} as not a snowflake`, () => {
      expect(() =>
        loadConfig({
          MUDDOWN_DISCORD_BOT_TOKEN: "abc.def.ghi",
          MUDDOWN_SERVER_URL: "ws://localhost:3300",
          MUDDOWN_DISCORD_FEED_CHANNEL_ID: bad,
        }),
      ).toThrow(/MUDDOWN_DISCORD_FEED_CHANNEL_ID must be a Discord snowflake/);
    });
  }

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

describe("parsePositiveIntEnv defaultValue validation", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`rejects ${bad} as a default to catch caller bugs`, () => {
      expect(() => parsePositiveIntEnv("X_TEST", undefined, bad)).toThrow(
        DiscordBridgeConfigError,
      );
    });
  }
});

describe("loadConfig tunables", () => {
  const ENV_VARS = [
    "MUDDOWN_DISCORD_IDLE_TIMEOUT_MS",
    "MUDDOWN_DISCORD_IDLE_CHECK_INTERVAL_MS",
    "MUDDOWN_DISCORD_DELIVERY_RETRIES",
    "MUDDOWN_DISCORD_DELIVERY_BACKOFF_MS",
    "MUDDOWN_DISCORD_MAX_DELIVERY_BACKOFF_MS",
    "MUDDOWN_DISCORD_MAX_CONSECUTIVE_DELIVERY_FAILURES",
  ] as const;

  it("applies built-in defaults when no tunable env vars are set", () => {
    const config = loadConfig({ ...REQUIRED_ENV });
    expect(config.tunables).toEqual(DEFAULT_TUNABLES);
  });

  it("applies built-in defaults when tunable env vars are empty strings", () => {
    const overrides: Record<string, string> = { ...REQUIRED_ENV };
    for (const name of ENV_VARS) overrides[name] = "";
    const config = loadConfig(overrides);
    expect(config.tunables).toEqual(DEFAULT_TUNABLES);
  });

  it("applies built-in defaults when tunable env vars are whitespace-only", () => {
    const overrides: Record<string, string> = { ...REQUIRED_ENV };
    for (const name of ENV_VARS) overrides[name] = "   ";
    const config = loadConfig(overrides);
    expect(config.tunables).toEqual(DEFAULT_TUNABLES);
  });

  it("accepts valid positive-integer overrides for every tunable", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      MUDDOWN_DISCORD_IDLE_TIMEOUT_MS: "120000",
      MUDDOWN_DISCORD_IDLE_CHECK_INTERVAL_MS: "5000",
      MUDDOWN_DISCORD_DELIVERY_RETRIES: "5",
      MUDDOWN_DISCORD_DELIVERY_BACKOFF_MS: "100",
      MUDDOWN_DISCORD_MAX_DELIVERY_BACKOFF_MS: "10000",
      MUDDOWN_DISCORD_MAX_CONSECUTIVE_DELIVERY_FAILURES: "10",
    });
    expect(config.tunables).toEqual({
      idleTimeoutMs: 120000,
      idleCheckIntervalMs: 5000,
      deliveryRetries: 5,
      deliveryBackoffMs: 100,
      maxDeliveryBackoffMs: 10000,
      maxConsecutiveDeliveryFailures: 10,
    });
  });

  it("trims surrounding whitespace before parsing", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      MUDDOWN_DISCORD_DELIVERY_RETRIES: "  4\n",
    });
    expect(config.tunables.deliveryRetries).toBe(4);
  });

  it("accepts integer-valued floats like \"2.0\"", () => {
    // Number.isInteger(2.0) === true; this case must remain accepted so a
    // future swap to a regex-based parser would surface as a regression.
    const config = loadConfig({
      ...REQUIRED_ENV,
      MUDDOWN_DISCORD_DELIVERY_RETRIES: "2.0",
    });
    expect(config.tunables.deliveryRetries).toBe(2);
  });

  const REJECTION_CASES: ReadonlyArray<readonly [string, string]> = [
    ["MUDDOWN_DISCORD_IDLE_TIMEOUT_MS", "0"],
    ["MUDDOWN_DISCORD_IDLE_CHECK_INTERVAL_MS", "0"],
    ["MUDDOWN_DISCORD_DELIVERY_RETRIES", "-1"],
    ["MUDDOWN_DISCORD_DELIVERY_BACKOFF_MS", "abc"],
    ["MUDDOWN_DISCORD_MAX_DELIVERY_BACKOFF_MS", "NaN"],
    ["MUDDOWN_DISCORD_MAX_CONSECUTIVE_DELIVERY_FAILURES", "1.5"],
  ];

  for (const [name, invalid] of REJECTION_CASES) {
    it(`rejects ${JSON.stringify(invalid)} for ${name}`, () => {
      expect(() =>
        loadConfig({
          ...REQUIRED_ENV,
          [name]: invalid,
        }),
      ).toThrow(DiscordBridgeConfigError);
    });
  }

  for (const invalid of ["-1", "abc", "Infinity", "NaN", "1.5"]) {
    it(`rejects ${JSON.stringify(invalid)} for MUDDOWN_DISCORD_IDLE_TIMEOUT_MS`, () => {
      expect(() =>
        loadConfig({
          ...REQUIRED_ENV,
          MUDDOWN_DISCORD_IDLE_TIMEOUT_MS: invalid,
        }),
      ).toThrow(DiscordBridgeConfigError);
    });
  }

  it("includes the env var name in the validation error message", () => {
    try {
      loadConfig({
        ...REQUIRED_ENV,
        MUDDOWN_DISCORD_DELIVERY_RETRIES: "-3",
      });
      expect.fail("loadConfig should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DiscordBridgeConfigError);
      expect((err as Error).message).toMatch(/MUDDOWN_DISCORD_DELIVERY_RETRIES/);
      expect((err as Error).message).toMatch(/positive integer/);
    }
  });

  it("rejects idleCheckIntervalMs >= idleTimeoutMs (would sweep on every tick)", () => {
    expect(() =>
      loadConfig({
        ...REQUIRED_ENV,
        MUDDOWN_DISCORD_IDLE_TIMEOUT_MS: "10000",
        MUDDOWN_DISCORD_IDLE_CHECK_INTERVAL_MS: "10000",
      }),
    ).toThrow(/must be less than/);
    expect(() =>
      loadConfig({
        ...REQUIRED_ENV,
        MUDDOWN_DISCORD_IDLE_TIMEOUT_MS: "10000",
        MUDDOWN_DISCORD_IDLE_CHECK_INTERVAL_MS: "20000",
      }),
    ).toThrow(/IDLE_CHECK_INTERVAL_MS/);
  });

  it("accepts idleCheckIntervalMs strictly less than idleTimeoutMs", () => {
    expect(() =>
      loadConfig({
        ...REQUIRED_ENV,
        MUDDOWN_DISCORD_IDLE_TIMEOUT_MS: "10000",
        MUDDOWN_DISCORD_IDLE_CHECK_INTERVAL_MS: "9999",
      }),
    ).not.toThrow();
  });

  it("rejects deliveryBackoffMs > maxDeliveryBackoffMs (cap below first retry)", () => {
    expect(() =>
      loadConfig({
        ...REQUIRED_ENV,
        MUDDOWN_DISCORD_DELIVERY_BACKOFF_MS: "1000",
        MUDDOWN_DISCORD_MAX_DELIVERY_BACKOFF_MS: "500",
      }),
    ).toThrow(/must not exceed/);
  });

  it("accepts deliveryBackoffMs equal to maxDeliveryBackoffMs", () => {
    expect(() =>
      loadConfig({
        ...REQUIRED_ENV,
        MUDDOWN_DISCORD_DELIVERY_BACKOFF_MS: "500",
        MUDDOWN_DISCORD_MAX_DELIVERY_BACKOFF_MS: "500",
      }),
    ).not.toThrow();
  });
});
