import { describe, it, expect } from "vitest";
import {
  requestNewEnviron,
  parseNewEnviron,
  IAC,
  SB,
  SE,
  OPT_NEW_ENVIRON,
  NEW_ENVIRON_IS,
  NEW_ENVIRON_INFO,
  NEW_ENVIRON_SEND,
  NEW_ENVIRON_VAR,
  NEW_ENVIRON_VALUE,
  NEW_ENVIRON_ESC,
  NEW_ENVIRON_USERVAR,
} from "../src/telnet.js";
import type { ParsedNewEnviron } from "../src/telnet.js";
import { buildOsc8Hyperlink, isCapabilityEnabled } from "../src/helpers.js";

/**
 * Parse `payload` and assert the parser did not return `undefined`. Gives
 * a clear failure message and lets the rest of the test access the typed
 * result without a non-null assertion.
 */
function expectParsed(payload: Buffer): ParsedNewEnviron {
  const parsed = parseNewEnviron(payload);
  expect(parsed).toBeDefined();
  if (!parsed) throw new Error("parseNewEnviron returned undefined");
  return parsed;
}

describe("requestNewEnviron", () => {
  it("builds an empty SEND request asking for all vars", () => {
    const buf = requestNewEnviron();
    expect([...buf]).toEqual([IAC, SB, OPT_NEW_ENVIRON, NEW_ENVIRON_SEND, IAC, SE]);
  });

  it("builds a SEND request targeting specific USERVARs", () => {
    const buf = requestNewEnviron(["OSC_HYPERLINKS", "OSC_HYPERLINKS_SEND"]);
    const expected: number[] = [
      IAC, SB, OPT_NEW_ENVIRON, NEW_ENVIRON_SEND,
      NEW_ENVIRON_USERVAR, ...Buffer.from("OSC_HYPERLINKS", "ascii"),
      NEW_ENVIRON_USERVAR, ...Buffer.from("OSC_HYPERLINKS_SEND", "ascii"),
      IAC, SE,
    ];
    expect([...buf]).toEqual(expected);
  });

  it("throws on non-ASCII USERVAR names instead of silently truncating", () => {
    // U+3042 ('あ') would truncate to 0x42 ('B') under the old bitmask.
    expect(() => requestNewEnviron(["OSCあ"])).toThrow(RangeError);
    expect(() => requestNewEnviron(["OSCあ"])).toThrow(/non-printable-ASCII/);
  });

  it("throws on NEW-ENVIRON control bytes inside a USERVAR name", () => {
    // VAR (0x00), VALUE (0x01), ESC (0x02), USERVAR (0x03) must not appear
    // raw in a name — they would desynchronise the wire format.
    for (const code of [0x00, 0x01, 0x02, 0x03]) {
      const name = `A${String.fromCharCode(code)}B`;
      expect(() => requestNewEnviron([name])).toThrow(RangeError);
    }
  });

  it("throws on DEL and C0 control characters", () => {
    expect(() => requestNewEnviron(["A\tB"])).toThrow(RangeError);
    expect(() => requestNewEnviron(["A\nB"])).toThrow(RangeError);
    expect(() => requestNewEnviron(["A\x7fB"])).toThrow(RangeError);
  });
});

describe("parseNewEnviron", () => {
  it("parses a single USERVAR with value", () => {
    const payload = Buffer.from([
      NEW_ENVIRON_IS,
      NEW_ENVIRON_USERVAR, ...Buffer.from("OSC_HYPERLINKS", "ascii"),
      NEW_ENVIRON_VALUE, ...Buffer.from("1", "ascii"),
    ]);
    const parsed = parseNewEnviron(payload);
    expect(parsed).toBeDefined();
    expect(parsed!.uservars.get("OSC_HYPERLINKS")).toBe("1");
    expect(parsed!.vars.size).toBe(0);
  });

  it("parses multiple USERVARs in one payload", () => {
    const payload = Buffer.from([
      NEW_ENVIRON_IS,
      NEW_ENVIRON_USERVAR, ...Buffer.from("OSC_HYPERLINKS", "ascii"),
      NEW_ENVIRON_VALUE, ...Buffer.from("1", "ascii"),
      NEW_ENVIRON_USERVAR, ...Buffer.from("OSC_HYPERLINKS_SEND", "ascii"),
      NEW_ENVIRON_VALUE, ...Buffer.from("1", "ascii"),
      NEW_ENVIRON_USERVAR, ...Buffer.from("OSC_HYPERLINKS_MENU", "ascii"),
      NEW_ENVIRON_VALUE, ...Buffer.from("0", "ascii"),
    ]);
    const parsed = expectParsed(payload);
    expect(parsed.uservars.get("OSC_HYPERLINKS")).toBe("1");
    expect(parsed.uservars.get("OSC_HYPERLINKS_SEND")).toBe("1");
    expect(parsed.uservars.get("OSC_HYPERLINKS_MENU")).toBe("0");
  });

  it("treats a USERVAR with no VALUE as an empty string", () => {
    const payload = Buffer.from([
      NEW_ENVIRON_IS,
      NEW_ENVIRON_USERVAR, ...Buffer.from("OSC_HYPERLINKS", "ascii"),
    ]);
    const parsed = expectParsed(payload);
    expect(parsed.uservars.get("OSC_HYPERLINKS")).toBe("");
  });

  it("separates VARs from USERVARs", () => {
    const payload = Buffer.from([
      NEW_ENVIRON_IS,
      NEW_ENVIRON_VAR, ...Buffer.from("USER", "ascii"),
      NEW_ENVIRON_VALUE, ...Buffer.from("alice", "ascii"),
      NEW_ENVIRON_USERVAR, ...Buffer.from("OSC_HYPERLINKS", "ascii"),
      NEW_ENVIRON_VALUE, ...Buffer.from("1", "ascii"),
    ]);
    const parsed = expectParsed(payload);
    expect(parsed.vars.get("USER")).toBe("alice");
    expect(parsed.uservars.get("OSC_HYPERLINKS")).toBe("1");
  });

  it("accepts INFO payloads (unsolicited updates)", () => {
    const payload = Buffer.from([
      NEW_ENVIRON_INFO,
      NEW_ENVIRON_USERVAR, ...Buffer.from("OSC_HYPERLINKS", "ascii"),
      NEW_ENVIRON_VALUE, ...Buffer.from("1", "ascii"),
    ]);
    const parsed = expectParsed(payload);
    expect(parsed.uservars.get("OSC_HYPERLINKS")).toBe("1");
  });

  it("handles ESC-quoted bytes inside values", () => {
    // Value contains a literal VAR byte (0x00) via ESC-escape
    const payload = Buffer.from([
      NEW_ENVIRON_IS,
      NEW_ENVIRON_USERVAR, ...Buffer.from("X", "ascii"),
      NEW_ENVIRON_VALUE,
      NEW_ENVIRON_ESC, NEW_ENVIRON_VAR,
      ...Buffer.from("rest", "ascii"),
    ]);
    const parsed = expectParsed(payload);
    const value = parsed.uservars.get("X");
    expect(value).toBeDefined();
    if (value === undefined) return;
    expect(value.charCodeAt(0)).toBe(NEW_ENVIRON_VAR);
    expect(value.slice(1)).toBe("rest");
  });

  it("handles ESC-quoted bytes inside names", () => {
    // Name contains a literal VALUE byte (0x01) via ESC-escape
    const payload = Buffer.from([
      NEW_ENVIRON_IS,
      NEW_ENVIRON_USERVAR,
      ...Buffer.from("A", "ascii"),
      NEW_ENVIRON_ESC, NEW_ENVIRON_VALUE,
      ...Buffer.from("B", "ascii"),
      NEW_ENVIRON_VALUE, ...Buffer.from("ok", "ascii"),
    ]);
    const parsed = expectParsed(payload);
    // Name should be "A" + char(0x01) + "B"
    const [name, value] = [...parsed.uservars.entries()][0];
    expect(name.charCodeAt(0)).toBe(0x41); // 'A'
    expect(name.charCodeAt(1)).toBe(NEW_ENVIRON_VALUE);
    expect(name.charCodeAt(2)).toBe(0x42); // 'B'
    expect(value).toBe("ok");
  });

  it("returns undefined for non-IS/INFO payloads", () => {
    expect(parseNewEnviron(Buffer.from([NEW_ENVIRON_SEND]))).toBeUndefined();
    expect(parseNewEnviron(Buffer.from([]))).toBeUndefined();
  });

  it("bails out gracefully when top-level type byte is invalid", () => {
    const payload = Buffer.from([NEW_ENVIRON_IS, 0x42]);
    const parsed = expectParsed(payload);
    expect(parsed.uservars.size).toBe(0);
    expect(parsed.vars.size).toBe(0);
  });

  it("records a warning and preserves the partial name when ESC appears at end of a name", () => {
    // Packet boundary splits the frame after ESC in the variable name.
    const payload = Buffer.from([
      NEW_ENVIRON_IS,
      NEW_ENVIRON_USERVAR, ...Buffer.from("OSC", "ascii"),
      NEW_ENVIRON_ESC, // truncated here — no byte to escape
    ]);
    const parsed = expectParsed(payload);
    expect(parsed.uservars.get("OSC")).toBe("");
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatch(/trailing ESC in variable name/i);
  });

  it("records a warning and preserves the partial value when ESC appears at end of a value", () => {
    const payload = Buffer.from([
      NEW_ENVIRON_IS,
      NEW_ENVIRON_USERVAR, ...Buffer.from("X", "ascii"),
      NEW_ENVIRON_VALUE, ...Buffer.from("abc", "ascii"),
      NEW_ENVIRON_ESC, // truncated
    ]);
    const parsed = expectParsed(payload);
    expect(parsed.uservars.get("X")).toBe("abc");
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings[0]).toMatch(/trailing ESC in variable value/i);
  });

  it("returns an empty warnings array on a clean parse", () => {
    const payload = Buffer.from([
      NEW_ENVIRON_IS,
      NEW_ENVIRON_USERVAR, ...Buffer.from("OSC_HYPERLINKS", "ascii"),
      NEW_ENVIRON_VALUE, ...Buffer.from("1", "ascii"),
    ]);
    const parsed = expectParsed(payload);
    expect(parsed.warnings).toEqual([]);
  });
});

describe("buildOsc8Hyperlink", () => {
  it("returns plain text when disabled", () => {
    expect(buildOsc8Hyperlink("https://example.com", "click me", false)).toBe("click me");
  });

  it("wraps text in the OSC 8 escape sequence when enabled", () => {
    const out = buildOsc8Hyperlink("https://example.com/x", "click me", true);
    // Format: ESC ] 8 ; ; URI ESC \ TEXT ESC ] 8 ; ; ESC \
    expect(out).toBe("\x1b]8;;https://example.com/x\x1b\\click me\x1b]8;;\x1b\\");
  });

  it("uses the String Terminator (ESC \\) not BEL", () => {
    const out = buildOsc8Hyperlink("u", "t", true);
    expect(out.includes("\x07")).toBe(false);
    expect(out.endsWith("\x1b\\")).toBe(true);
  });

  it("keeps URI and text distinct (URI first on the wire, text between STs)", () => {
    const out = buildOsc8Hyperlink("URI_VAL", "TEXT_VAL", true);
    const uriIdx = out.indexOf("URI_VAL");
    const textIdx = out.indexOf("TEXT_VAL");
    expect(uriIdx).toBeGreaterThan(-1);
    expect(textIdx).toBeGreaterThan(uriIdx);
  });
});

describe("isCapabilityEnabled", () => {
  it("treats empty string as enabled (presence-only advertisement)", () => {
    expect(isCapabilityEnabled("")).toBe(true);
  });

  it("treats \"1\" as enabled", () => {
    expect(isCapabilityEnabled("1")).toBe(true);
  });

  it("treats \"true\" (any case) as enabled", () => {
    expect(isCapabilityEnabled("true")).toBe(true);
    expect(isCapabilityEnabled("TRUE")).toBe(true);
    expect(isCapabilityEnabled("True")).toBe(true);
  });

  it("treats \"0\" as disabled", () => {
    expect(isCapabilityEnabled("0")).toBe(false);
  });

  it("treats \"false\" as disabled", () => {
    expect(isCapabilityEnabled("false")).toBe(false);
  });

  it("treats any other explicit value as disabled", () => {
    expect(isCapabilityEnabled("maybe")).toBe(false);
    expect(isCapabilityEnabled("2")).toBe(false);
    expect(isCapabilityEnabled(" ")).toBe(false);
  });
});
