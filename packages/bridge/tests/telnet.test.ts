import { describe, it, expect } from "vitest";
import {
  TelnetParser,
  iacDo,
  iacWill,
  iacWont,
  iacDont,
  iacSub,
  iacNop,
  requestTtype,
  parseNaws,
  parseTtype,
  supportsAnsi,
  detectColorLevel,
  IAC,
  SE,
  SB,
  WILL,
  WONT,
  DO,
  DONT,
  NOP,
  OPT_ECHO,
  OPT_SGA,
  OPT_TTYPE,
  OPT_NAWS,
  TTYPE_IS,
  TTYPE_SEND,
} from "../src/telnet.js";

// ─── Command Builders ────────────────────────────────────────────────────────

describe("command builders", () => {
  it("iacDo builds IAC DO <option>", () => {
    expect(iacDo(OPT_NAWS)).toEqual(Buffer.from([IAC, DO, OPT_NAWS]));
  });

  it("iacWill builds IAC WILL <option>", () => {
    expect(iacWill(OPT_ECHO)).toEqual(Buffer.from([IAC, WILL, OPT_ECHO]));
  });

  it("iacWont builds IAC WONT <option>", () => {
    expect(iacWont(OPT_SGA)).toEqual(Buffer.from([IAC, WONT, OPT_SGA]));
  });

  it("iacDont builds IAC DONT <option>", () => {
    expect(iacDont(OPT_TTYPE)).toEqual(Buffer.from([IAC, DONT, OPT_TTYPE]));
  });

  it("iacNop builds IAC NOP", () => {
    expect(iacNop()).toEqual(Buffer.from([IAC, NOP]));
  });

  it("iacSub builds sub-negotiation sequence", () => {
    const result = iacSub(OPT_TTYPE, TTYPE_SEND);
    expect(result).toEqual(Buffer.from([IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE]));
  });

  it("requestTtype builds TTYPE SEND sub-negotiation", () => {
    expect(requestTtype()).toEqual(Buffer.from([IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE]));
  });
});

// ─── TelnetParser ────────────────────────────────────────────────────────────

describe("TelnetParser", () => {
  it("passes plain data through", () => {
    const parser = new TelnetParser();
    const events = parser.feed(Buffer.from("hello"));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("data");
    if (events[0].type === "data") {
      expect(events[0].data.toString()).toBe("hello");
    }
  });

  it("parses IAC WILL", () => {
    const parser = new TelnetParser();
    const events = parser.feed(Buffer.from([IAC, WILL, OPT_NAWS]));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "will", option: OPT_NAWS });
  });

  it("parses IAC WONT", () => {
    const parser = new TelnetParser();
    const events = parser.feed(Buffer.from([IAC, WONT, OPT_TTYPE]));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "wont", option: OPT_TTYPE });
  });

  it("parses IAC DO", () => {
    const parser = new TelnetParser();
    const events = parser.feed(Buffer.from([IAC, DO, OPT_ECHO]));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "do", option: OPT_ECHO });
  });

  it("parses IAC DONT", () => {
    const parser = new TelnetParser();
    const events = parser.feed(Buffer.from([IAC, DONT, OPT_SGA]));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "dont", option: OPT_SGA });
  });

  it("parses IAC NOP", () => {
    const parser = new TelnetParser();
    const events = parser.feed(Buffer.from([IAC, NOP]));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "nop" });
  });

  it("parses sub-negotiation", () => {
    const parser = new TelnetParser();
    // IAC SB NAWS <0,80,0,24> IAC SE
    const events = parser.feed(Buffer.from([
      IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE,
    ]));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("subneg");
    if (events[0].type === "subneg") {
      expect(events[0].option).toBe(OPT_NAWS);
      expect(events[0].data).toEqual(Buffer.from([0, 80, 0, 24]));
    }
  });

  it("handles escaped IAC (0xFF) in data", () => {
    const parser = new TelnetParser();
    // IAC IAC in data yields a literal 0xFF byte;
    // the parser flushes data before the IAC boundary, then resumes
    const events = parser.feed(Buffer.from([0x41, IAC, IAC, 0x42]));
    expect(events).toHaveLength(2);
    if (events[0].type === "data") {
      expect(events[0].data).toEqual(Buffer.from([0x41]));
    }
    if (events[1].type === "data") {
      expect(events[1].data).toEqual(Buffer.from([0xff, 0x42]));
    }
  });

  it("handles escaped IAC in sub-negotiation", () => {
    const parser = new TelnetParser();
    const events = parser.feed(Buffer.from([
      IAC, SB, OPT_TTYPE, 0x01, IAC, IAC, 0x02, IAC, SE,
    ]));
    expect(events).toHaveLength(1);
    if (events[0].type === "subneg") {
      expect(events[0].data).toEqual(Buffer.from([0x01, 0xff, 0x02]));
    }
  });

  it("separates data from IAC commands", () => {
    const parser = new TelnetParser();
    const events = parser.feed(Buffer.from([
      0x68, 0x69, // "hi"
      IAC, WILL, OPT_NAWS,
      0x6f, 0x6b, // "ok"
    ]));
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe("data");
    expect(events[1]).toEqual({ type: "will", option: OPT_NAWS });
    expect(events[2].type).toBe("data");
    if (events[0].type === "data") {
      expect(events[0].data.toString()).toBe("hi");
    }
    if (events[2].type === "data") {
      expect(events[2].data.toString()).toBe("ok");
    }
  });

  it("handles chunked input across multiple feeds", () => {
    const parser = new TelnetParser();

    // Feed first half: IAC WILL (incomplete)
    const events1 = parser.feed(Buffer.from([IAC]));
    expect(events1).toHaveLength(0);

    // Feed second half
    const events2 = parser.feed(Buffer.from([WILL, OPT_NAWS]));
    expect(events2).toHaveLength(1);
    expect(events2[0]).toEqual({ type: "will", option: OPT_NAWS });
  });

  it("handles chunked sub-negotiation", () => {
    const parser = new TelnetParser();

    // First chunk: start of sub-negotiation
    const events1 = parser.feed(Buffer.from([IAC, SB, OPT_NAWS, 0, 80]));
    expect(events1).toHaveLength(0);

    // Second chunk: finish sub-negotiation
    const events2 = parser.feed(Buffer.from([0, 24, IAC, SE]));
    expect(events2).toHaveLength(1);
    if (events2[0].type === "subneg") {
      expect(events2[0].data).toEqual(Buffer.from([0, 80, 0, 24]));
    }
  });

  it("handles TTYPE IS sub-negotiation", () => {
    const parser = new TelnetParser();
    const ttypeIs = Buffer.from([
      IAC, SB, OPT_TTYPE,
      TTYPE_IS,
      ...Buffer.from("XTERM-256COLOR"),
      IAC, SE,
    ]);
    const events = parser.feed(ttypeIs);
    expect(events).toHaveLength(1);
    if (events[0].type === "subneg") {
      expect(events[0].option).toBe(OPT_TTYPE);
      const parsed = parseTtype(events[0].data);
      expect(parsed).toBe("XTERM-256COLOR");
    }
  });

  it("ignores unexpected SE outside sub-negotiation", () => {
    const parser = new TelnetParser();
    const events = parser.feed(Buffer.from([IAC, SE, 0x41]));
    // SE is ignored, then 0x41 is data
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("data");
    if (events[0].type === "data") {
      expect(events[0].data.toString()).toBe("A");
    }
  });

  it("handles empty buffer feed", () => {
    const parser = new TelnetParser();
    const events = parser.feed(Buffer.alloc(0));
    expect(events).toHaveLength(0);
  });

  it("handles sb-iac with unexpected byte (not SE or IAC)", () => {
    const parser = new TelnetParser();
    // Start subneg, then IAC followed by something other than SE or IAC.
    // This is technically malformed, but the parser should recover by
    // terminating the subnegotiation and then parsing the command normally.
    const events = parser.feed(Buffer.from([
      IAC, SB, OPT_NAWS, 0, 80, IAC, WILL, OPT_ECHO, // IAC WILL inside subneg = exit subneg
    ]));
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("subneg");
    if (events[0].type === "subneg") {
      expect(events[0].option).toBe(OPT_NAWS);
      expect(events[0].data).toEqual(Buffer.from([0, 80]));
    }
    expect(events[1]).toEqual({ type: "will", option: OPT_ECHO });
  });

  it("skips unknown IAC command and resumes parsing", () => {
    const parser = new TelnetParser();
    // 0xF5 = Abort Output (not handled by our parser), then normal data
    const events = parser.feed(Buffer.from([IAC, 0xf5, 0x41]));
    // Unknown command is skipped, 0x41 ('A') is data
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("data");
    if (events[0].type === "data") {
      expect(events[0].data).toEqual(Buffer.from([0x41]));
    }
  });
});

// ─── NAWS Parsing ────────────────────────────────────────────────────────────

describe("parseNaws", () => {
  it("parses standard 80x24", () => {
    const result = parseNaws(Buffer.from([0, 80, 0, 24]));
    expect(result).toEqual({ cols: 80, rows: 24 });
  });

  it("parses wide terminal", () => {
    const result = parseNaws(Buffer.from([0, 200, 0, 50]));
    expect(result).toEqual({ cols: 200, rows: 50 });
  });

  it("parses 16-bit width", () => {
    // 256 cols = 0x0100
    const result = parseNaws(Buffer.from([1, 0, 0, 40]));
    expect(result).toEqual({ cols: 256, rows: 40 });
  });

  it("returns undefined for too-short data", () => {
    expect(parseNaws(Buffer.from([0, 80]))).toBeUndefined();
  });

  it("returns undefined for nonsensical values", () => {
    // cols=5, below minimum of 10
    expect(parseNaws(Buffer.from([0, 5, 0, 24]))).toBeUndefined();
    // rows=0, below minimum of 1
    expect(parseNaws(Buffer.from([0, 80, 0, 0]))).toBeUndefined();
  });

  it("parses minimum valid size (10 cols, 1 row)", () => {
    const result = parseNaws(Buffer.from([0, 10, 0, 1]));
    expect(result).toEqual({ cols: 10, rows: 1 });
  });

  it("parses boundary col value (500)", () => {
    // 500 = 0x01F4
    const result = parseNaws(Buffer.from([1, 0xf4, 0, 24]));
    expect(result).toEqual({ cols: 500, rows: 24 });
  });

  it("parses boundary row value (200)", () => {
    // 200 = 0x00C8
    const result = parseNaws(Buffer.from([0, 80, 0, 200]));
    expect(result).toEqual({ cols: 80, rows: 200 });
  });

  it("returns undefined for empty buffer", () => {
    expect(parseNaws(Buffer.alloc(0))).toBeUndefined();
  });
  it("returns undefined for cols too large (501)", () => {
    // 501 = 0x01F5
    expect(parseNaws(Buffer.from([0x01, 0xf5, 0x00, 0x18]))).toBeUndefined();
  });

  it("returns undefined for rows too large (201)", () => {
    // 201 = 0x00C9
    expect(parseNaws(Buffer.from([0x00, 0x50, 0x00, 0xc9]))).toBeUndefined();
  });

  it("parses maximum valid size (500 cols, 200 rows)", () => {
    // 500 = 0x01F4, 200 = 0x00C8
    const result = parseNaws(Buffer.from([0x01, 0xf4, 0x00, 0xc8]));
    expect(result).toEqual({ cols: 500, rows: 200 });
  });
});

// ─── TTYPE Parsing ───────────────────────────────────────────────────────────

describe("parseTtype", () => {
  it("parses XTERM", () => {
    const data = Buffer.from([TTYPE_IS, ...Buffer.from("xterm")]);
    expect(parseTtype(data)).toBe("XTERM");
  });

  it("parses XTERM-256COLOR", () => {
    const data = Buffer.from([TTYPE_IS, ...Buffer.from("xterm-256color")]);
    expect(parseTtype(data)).toBe("XTERM-256COLOR");
  });

  it("trims whitespace", () => {
    const data = Buffer.from([TTYPE_IS, ...Buffer.from("  VT100  ")]);
    expect(parseTtype(data)).toBe("VT100");
  });

  it("returns undefined for too-short data", () => {
    expect(parseTtype(Buffer.from([TTYPE_IS]))).toBeUndefined();
  });

  it("returns undefined for missing IS byte", () => {
    expect(parseTtype(Buffer.from([0x01, ...Buffer.from("xterm")]))).toBeUndefined();
  });

  it("returns undefined for empty buffer", () => {
    expect(parseTtype(Buffer.alloc(0))).toBeUndefined();
  });
});

// ─── ANSI Capability Detection ───────────────────────────────────────────────

describe("supportsAnsi", () => {
  it("returns true for XTERM", () => {
    expect(supportsAnsi("XTERM")).toBe(true);
  });

  it("returns true for xterm-256color (case-insensitive)", () => {
    expect(supportsAnsi("xterm-256color")).toBe(true);
  });

  it("returns true for VT100", () => {
    expect(supportsAnsi("VT100")).toBe(true);
  });

  it("returns true for MUDLET", () => {
    expect(supportsAnsi("MUDLET")).toBe(true);
  });

  it("returns true for PUTTY", () => {
    expect(supportsAnsi("PUTTY")).toBe(true);
  });

  it("returns true for terminals containing XTERM", () => {
    expect(supportsAnsi("MY-XTERM-VARIANT")).toBe(true);
  });

  it("returns true for terminals containing 256COLOR", () => {
    expect(supportsAnsi("foo-256color")).toBe(true);
  });

  it("returns true for terminals containing ANSI", () => {
    expect(supportsAnsi("my-ansi-term")).toBe(true);
  });

  it("returns false for DUMB", () => {
    expect(supportsAnsi("DUMB")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(supportsAnsi(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(supportsAnsi("")).toBe(false);
  });

  it("returns true for MUD clients", () => {
    expect(supportsAnsi("MUSHCLIENT")).toBe(true);
    expect(supportsAnsi("CMUD")).toBe(true);
    expect(supportsAnsi("ZMUD")).toBe(true);
    expect(supportsAnsi("TINTIN++")).toBe(true);
    expect(supportsAnsi("TINYFUGUE")).toBe(true);
  });
});

// ─── Color Level Detection ──────────────────────────────────────────────────

describe("detectColorLevel", () => {
  it("returns 3 for ANSI-TRUECOLOR in TTYPE cycle", () => {
    expect(detectColorLevel(["MUDLET", "ANSI-TRUECOLOR"])).toBe(3);
  });

  it("returns 3 for 24BIT indicator", () => {
    expect(detectColorLevel(["XTERM", "XTERM-24BIT"])).toBe(3);
  });

  it("returns 3 for DIRECT indicator", () => {
    expect(detectColorLevel(["XTERM-DIRECT"])).toBe(3);
  });

  it("returns 2 for 256COLOR in TTYPE cycle", () => {
    expect(detectColorLevel(["MUDLET", "XTERM-256COLOR"])).toBe(2);
  });

  it("returns 1 for basic ANSI terminal", () => {
    expect(detectColorLevel(["VT100"])).toBe(1);
  });

  it("returns 1 for known MUD client without color suffix", () => {
    expect(detectColorLevel(["MUDLET"])).toBe(1);
  });

  it("returns 0 for empty list", () => {
    expect(detectColorLevel([])).toBe(0);
  });

  it("returns 0 for unknown terminal", () => {
    expect(detectColorLevel(["DUMB"])).toBe(0);
  });

  it("picks highest level across multiple types", () => {
    expect(detectColorLevel(["VT100", "XTERM-256COLOR"])).toBe(2);
  });

  it("is case-insensitive", () => {
    expect(detectColorLevel(["mudlet", "ansi-truecolor"])).toBe(3);
  });

  it("returns 1 for ANSI terminal type", () => {
    expect(detectColorLevel(["ANSI"])).toBe(1);
  });

  it("returns 3 when only truecolor type is present", () => {
    expect(detectColorLevel(["ANSI-TRUECOLOR"])).toBe(3);
  });

  it("returns 2 for 256color without truecolor", () => {
    expect(detectColorLevel(["XTERM-256COLOR"])).toBe(2);
  });
});
