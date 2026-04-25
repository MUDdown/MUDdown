import { describe, it, expect } from "vitest";
import {
  buildMsspVars,
  buildMsspSubneg,
  MSSP_STATS_UNKNOWN,
  type MsspConfig,
  type MsspStats,
} from "../src/helpers.js";
import { IAC, SB, SE, OPT_MSSP, MSSP_VAR, MSSP_VAL } from "../src/telnet.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SAMPLE_CONFIG: MsspConfig = {
  name: "MUDdown",
  hostname: "muddown.com",
  contact: "support@muddown.com",
  website: "https://muddown.com",
  icon: "https://muddown.com/favicon.ico",
  discord: "https://discord.gg/mDFcMT3egK",
  language: "English",
  location: "United States of America",
  created: "2026",
  codebase: "MUDdown",
  genre: "Fantasy",
  subgenre: "Medieval Fantasy",
  gameplay: "Hack and Slash",
  status: "Alpha",
  minimumAge: "13",
};

const SAMPLE_STATS: MsspStats = {
  players: 3,
  uptime: 1745500000,
  areas: 5,
  rooms: 47,
  objects: 120,
  mobiles: 23,
  helpfiles: 12,
  classes: 4,
  levels: 0,
};

// The canonical keyset from the Mudlet wiki's StickMUD example
// (https://wiki.mudlet.org/w/Manual:Supported_Protocols#MSSP), plus
// `XTERM TRUE COLORS` from the official MSSP spec
// (https://mudhalla.net/tintin/protocols/mssp/) since the bridge
// negotiates 24-bit color via TTYPE/COLORTERM. `IP` is excluded because
// it is only present when a DNS resolution succeeded.
const EXPECTED_KEYS_WITHOUT_IP = [
  "NAME", "PLAYERS", "UPTIME", "HOSTNAME", "PORT", "TLS", "SSL",
  "CONTACT", "WEBSITE", "ICON", "DISCORD", "LANGUAGE", "LOCATION",
  "CREATED", "CODEBASE", "FAMILY", "GAMESYSTEM", "GENRE", "SUBGENRE",
  "GAMEPLAY", "STATUS", "INTERMUD", "MINIMUM AGE", "PUEBLO",
  "AREAS", "ROOMS", "OBJECTS", "MOBILES", "HELPFILES", "CLASSES",
  "LEVELS", "RACES", "SKILLS",
  "ANSI", "UTF-8", "VT100", "XTERM 256 COLORS", "XTERM TRUE COLORS",
  "MXP", "MSP", "MCP",
  "MCCP", "GMCP", "MSDP",
  "PAY TO PLAY", "PAY FOR PERKS", "HIRING BUILDERS", "HIRING CODERS",
];

// ─── buildMsspVars ───────────────────────────────────────────────────────────

describe("buildMsspVars", () => {
  it("emits exactly the expected keys when no IP is provided", () => {
    const vars = buildMsspVars(SAMPLE_CONFIG, SAMPLE_STATS, 2323, "");
    expect(Object.keys(vars).sort()).toEqual([...EXPECTED_KEYS_WITHOUT_IP].sort());
  });

  it("includes IP when a non-empty value is provided", () => {
    const vars = buildMsspVars(SAMPLE_CONFIG, SAMPLE_STATS, 2323, "198.51.100.42");
    expect(vars["IP"]).toBe("198.51.100.42");
    expect(Object.keys(vars).sort()).toEqual(
      [...EXPECTED_KEYS_WITHOUT_IP, "IP"].sort(),
    );
  });

  it("omits IP when the value is an empty string", () => {
    const vars = buildMsspVars(SAMPLE_CONFIG, SAMPLE_STATS, 2323, "");
    expect(vars).not.toHaveProperty("IP");
  });

  it("advertises the bridge port for PORT, TLS, and SSL", () => {
    const vars = buildMsspVars(SAMPLE_CONFIG, SAMPLE_STATS, 2323, "");
    expect(vars["PORT"]).toBe("2323");
    expect(vars["TLS"]).toBe("2323");
    expect(vars["SSL"]).toBe("2323");
  });

  it("serialises numeric stats as decimal strings", () => {
    const vars = buildMsspVars(SAMPLE_CONFIG, SAMPLE_STATS, 2323, "");
    expect(vars["PLAYERS"]).toBe("3");
    expect(vars["UPTIME"]).toBe("1745500000");
    expect(vars["AREAS"]).toBe("5");
    expect(vars["ROOMS"]).toBe("47");
    expect(vars["OBJECTS"]).toBe("120");
    expect(vars["MOBILES"]).toBe("23");
    expect(vars["HELPFILES"]).toBe("12");
    expect(vars["CLASSES"]).toBe("4");
    expect(vars["LEVELS"]).toBe("0");
  });

  it("emits -1 for unknown stats (MSSP 'no value' sentinel)", () => {
    const vars = buildMsspVars(SAMPLE_CONFIG, MSSP_STATS_UNKNOWN, 2323, "");
    expect(vars["PLAYERS"]).toBe("-1");
    expect(vars["ROOMS"]).toBe("-1");
    expect(vars["OBJECTS"]).toBe("-1");
  });

  it("always emits -1 for RACES and SKILLS (not yet implemented)", () => {
    const vars = buildMsspVars(SAMPLE_CONFIG, SAMPLE_STATS, 2323, "");
    expect(vars["RACES"]).toBe("-1");
    expect(vars["SKILLS"]).toBe("-1");
  });

  it("does not invent keys outside the documented set", () => {
    const vars = buildMsspVars(SAMPLE_CONFIG, SAMPLE_STATS, 2323, "1.2.3.4");
    for (const key of Object.keys(vars)) {
      expect([...EXPECTED_KEYS_WITHOUT_IP, "IP"]).toContain(key);
    }
    expect(vars).not.toHaveProperty("CRAWL DELAY");
    expect(vars).not.toHaveProperty("CHARSET");
    expect(vars).not.toHaveProperty("MSSP");
  });

  it("advertises XTERM TRUE COLORS=1 (24-bit color via TTYPE/COLORTERM)", () => {
    const vars = buildMsspVars(SAMPLE_CONFIG, SAMPLE_STATS, 2323, "");
    expect(vars["XTERM TRUE COLORS"]).toBe("1");
  });

  it("carries static categorisation fields through unchanged", () => {
    const vars = buildMsspVars(SAMPLE_CONFIG, SAMPLE_STATS, 2323, "");
    expect(vars["NAME"]).toBe("MUDdown");
    expect(vars["FAMILY"]).toBe("Custom");
    expect(vars["GAMESYSTEM"]).toBe("Custom");
    expect(vars["GENRE"]).toBe("Fantasy");
    expect(vars["STATUS"]).toBe("Alpha");
    expect(vars["MINIMUM AGE"]).toBe("13");
    expect(vars["PUEBLO"]).toBe("0");
    expect(vars["INTERMUD"]).toBe("-1");
  });
});

// ─── buildMsspSubneg ─────────────────────────────────────────────────────────

describe("buildMsspSubneg", () => {
  it("wraps the payload in IAC SB MSSP ... IAC SE", () => {
    const buf = buildMsspSubneg({ NAME: "MUDdown" });
    expect(buf[0]).toBe(IAC);
    expect(buf[1]).toBe(SB);
    expect(buf[2]).toBe(OPT_MSSP);
    expect(buf[buf.length - 2]).toBe(IAC);
    expect(buf[buf.length - 1]).toBe(SE);
  });

  it("encodes a single entry as MSSP_VAR <name> MSSP_VAL <value>", () => {
    const buf = buildMsspSubneg({ NAME: "MUDdown" });
    // Strip the IAC SB <opt> prefix (3 bytes) and IAC SE suffix (2 bytes).
    const inner = buf.subarray(3, buf.length - 2);
    const expected = Buffer.from([
      MSSP_VAR, 0x4e, 0x41, 0x4d, 0x45, // "NAME"
      MSSP_VAL, 0x4d, 0x55, 0x44, 0x64, 0x6f, 0x77, 0x6e, // "MUDdown"
    ]);
    expect(inner.equals(expected)).toBe(true);
  });

  it("encodes multiple entries in iteration order", () => {
    const buf = buildMsspSubneg({ A: "1", B: "2" });
    const inner = buf.subarray(3, buf.length - 2);
    const expected = Buffer.from([
      MSSP_VAR, 0x41, MSSP_VAL, 0x31,
      MSSP_VAR, 0x42, MSSP_VAL, 0x32,
    ]);
    expect(inner.equals(expected)).toBe(true);
  });

  it("IAC-escapes 0xFF bytes inside values (RFC 854)", () => {
    // MSSP forbids IAC in values in theory, but we still rely on iacSub to
    // escape any 0xFF that slips in so the SE terminator is not forged.
    const buf = buildMsspSubneg({ K: "\xff" });
    // The value byte (0xFF) must appear doubled inside the payload, not
    // left as a lone IAC that would prematurely end the sub-negotiation.
    const inner = buf.subarray(3, buf.length - 2);
    // Expect: VAR 'K' VAL 0xFF 0xFF (doubled)
    expect(inner.equals(Buffer.from([MSSP_VAR, 0x4b, MSSP_VAL, 0xff, 0xff]))).toBe(true);
  });

  it("throws when a value contains MSSP_VAR (0x01)", () => {
    expect(() => buildMsspSubneg({ K: "\x01" })).toThrow(/reserved byte 0x01/);
  });

  it("throws when a value contains MSSP_VAL (0x02)", () => {
    expect(() => buildMsspSubneg({ K: "\x02" })).toThrow(/reserved byte 0x02/);
  });

  it("throws when a value contains NUL", () => {
    expect(() => buildMsspSubneg({ K: "\x00" })).toThrow(/reserved byte 0x00/);
  });

  it("throws when a name contains a reserved byte", () => {
    expect(() => buildMsspSubneg({ "\x01": "v" })).toThrow(/reserved byte 0x01/);
  });

  it("rejects high code points whose latin1 truncation lands on a reserved byte", () => {
    // "\u0101" passes a UTF-16 charCodeAt check (257 != 0/1/2) but
    // Buffer.from("\u0101", "latin1") emits byte 0x01 (MSSP_VAR), which
    // would silently desynchronise a crawler's parser. Validation must
    // run on the latin1-encoded bytes, not the source code units.
    expect(() => buildMsspSubneg({ K: "\u0101" })).toThrow(/reserved byte 0x01/);
    expect(() => buildMsspSubneg({ K: "\u0102" })).toThrow(/reserved byte 0x02/);
    expect(() => buildMsspSubneg({ K: "\u0100" })).toThrow(/reserved byte 0x00/);
    expect(() => buildMsspSubneg({ "\u0101": "v" })).toThrow(/reserved byte 0x01/);
  });

  it("produces a parseable full StickMUD-style payload", () => {
    const vars = buildMsspVars(SAMPLE_CONFIG, SAMPLE_STATS, 2323, "198.51.100.42");
    const buf = buildMsspSubneg(vars);
    // Strip envelope and walk VAR/VAL pairs to reconstruct the record.
    const inner = buf.subarray(3, buf.length - 2);
    const parsed: Record<string, string> = {};
    let i = 0;
    while (i < inner.length) {
      expect(inner[i]).toBe(MSSP_VAR);
      i++;
      const nameStart = i;
      while (i < inner.length && inner[i] !== MSSP_VAL) i++;
      const name = inner.subarray(nameStart, i).toString("utf8");
      expect(inner[i]).toBe(MSSP_VAL);
      i++;
      const valueStart = i;
      while (i < inner.length && inner[i] !== MSSP_VAR) i++;
      const value = inner.subarray(valueStart, i).toString("utf8");
      parsed[name] = value;
    }
    expect(parsed).toEqual(vars);
  });
});
