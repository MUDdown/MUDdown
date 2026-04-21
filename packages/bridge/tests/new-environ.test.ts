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

describe("requestNewEnviron", () => {
  it("builds an empty SEND request asking for all vars", () => {
    const buf = requestNewEnviron();
    // IAC SB NEW-ENVIRON SEND IAC SE
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
    const parsed = parseNewEnviron(payload)!;
    expect(parsed.uservars.get("OSC_HYPERLINKS")).toBe("1");
    expect(parsed.uservars.get("OSC_HYPERLINKS_SEND")).toBe("1");
    expect(parsed.uservars.get("OSC_HYPERLINKS_MENU")).toBe("0");
  });

  it("handles a USERVAR with no VALUE (treated as empty string)", () => {
    const payload = Buffer.from([
      NEW_ENVIRON_IS,
      NEW_ENVIRON_USERVAR, ...Buffer.from("OSC_HYPERLINKS", "ascii"),
    ]);
    const parsed = parseNewEnviron(payload)!;
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
    const parsed = parseNewEnviron(payload)!;
    expect(parsed.vars.get("USER")).toBe("alice");
    expect(parsed.uservars.get("OSC_HYPERLINKS")).toBe("1");
  });

  it("accepts INFO payloads (unsolicited updates)", () => {
    const payload = Buffer.from([
      NEW_ENVIRON_INFO,
      NEW_ENVIRON_USERVAR, ...Buffer.from("OSC_HYPERLINKS", "ascii"),
      NEW_ENVIRON_VALUE, ...Buffer.from("1", "ascii"),
    ]);
    const parsed = parseNewEnviron(payload)!;
    expect(parsed.uservars.get("OSC_HYPERLINKS")).toBe("1");
  });

  it("handles ESC-quoted bytes in values", () => {
    // Value contains a literal VALUE byte (0x01) via ESC-escape
    const payload = Buffer.from([
      NEW_ENVIRON_IS,
      NEW_ENVIRON_USERVAR, ...Buffer.from("X", "ascii"),
      NEW_ENVIRON_VALUE,
      NEW_ENVIRON_ESC, NEW_ENVIRON_VAR,
      ...Buffer.from("rest", "ascii"),
    ]);
    const parsed = parseNewEnviron(payload)!;
    const value = parsed.uservars.get("X")!;
    expect(value.charCodeAt(0)).toBe(NEW_ENVIRON_VAR);
    expect(value.slice(1)).toBe("rest");
  });

  it("returns undefined for non-IS/INFO payloads", () => {
    expect(parseNewEnviron(Buffer.from([NEW_ENVIRON_SEND]))).toBeUndefined();
    expect(parseNewEnviron(Buffer.from([]))).toBeUndefined();
  });

  it("tolerates a truncated payload ending mid-name", () => {
    // IS then a USERVAR name with no VALUE and no trailing separator.
    const payload = Buffer.from([
      NEW_ENVIRON_IS,
      NEW_ENVIRON_USERVAR, ...Buffer.from("OSC_HYPERLINKS", "ascii"),
    ]);
    const parsed = parseNewEnviron(payload)!;
    expect(parsed.uservars.get("OSC_HYPERLINKS")).toBe("");
  });

  it("bails out gracefully when top-level type byte is invalid", () => {
    // IS followed immediately by a byte that isn't VAR or USERVAR —
    // parser should stop cleanly and return an empty result.
    const payload = Buffer.from([NEW_ENVIRON_IS, 0x42]);
    const parsed = parseNewEnviron(payload)!;
    expect(parsed.uservars.size).toBe(0);
    expect(parsed.vars.size).toBe(0);
  });
});
