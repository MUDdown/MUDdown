/**
 * Telnet protocol constants and helpers.
 *
 * Implements the subset of the telnet protocol needed for the MUDdown bridge:
 * - IAC command parsing/generation
 * - NAWS (Negotiate About Window Size) — RFC 1073
 * - TTYPE (Terminal Type) — RFC 1091
 * - ECHO suppression — RFC 857
 * - SGA (Suppress Go Ahead) — RFC 858
 */

// ─── IAC Command Bytes ───────────────────────────────────────────────────────

/** Interpret As Command — prefix for all telnet commands. */
export const IAC = 0xff;
/** End of sub-negotiation. */
export const SE = 0xf0;
/** No Operation — used as keepalive. */
export const NOP = 0xf1;
/** Begin sub-negotiation. */
export const SB = 0xfa;
/** Indicates the desire to begin performing an option. */
export const WILL = 0xfb;
/** Indicates refusal to perform an option. */
export const WONT = 0xfc;
/** Indicates the request that the other party perform an option. */
export const DO = 0xfd;
/** Indicates the demand that the other party stop performing an option. */
export const DONT = 0xfe;

// ─── Telnet Option Codes ─────────────────────────────────────────────────────

/** Echo option — RFC 857. */
export const OPT_ECHO = 1;
/** Suppress Go Ahead — RFC 858. */
export const OPT_SGA = 3;
/** Terminal Type — RFC 1091. */
export const OPT_TTYPE = 24;
/** Negotiate About Window Size — RFC 1073. */
export const OPT_NAWS = 31;

// ─── Sub-negotiation constants ───────────────────────────────────────────────

/** TTYPE IS (client sends terminal type). */
export const TTYPE_IS = 0;
/** TTYPE SEND (server requests terminal type). */
export const TTYPE_SEND = 1;

// ─── Command builders ────────────────────────────────────────────────────────

/** Build an IAC DO <option> command. */
export function iacDo(option: number): Buffer {
  return Buffer.from([IAC, DO, option]);
}

/** Build an IAC WILL <option> command. */
export function iacWill(option: number): Buffer {
  return Buffer.from([IAC, WILL, option]);
}

/** Build an IAC WONT <option> command. */
export function iacWont(option: number): Buffer {
  return Buffer.from([IAC, WONT, option]);
}

/** Build an IAC DONT <option> command. */
export function iacDont(option: number): Buffer {
  return Buffer.from([IAC, DONT, option]);
}

/** Build a sub-negotiation sequence: IAC SB <option> <...payload> IAC SE. */
export function iacSub(option: number, ...payload: number[]): Buffer {
  return Buffer.from([IAC, SB, option, ...payload, IAC, SE]);
}

/** Build an IAC NOP (keepalive). */
export function iacNop(): Buffer {
  return Buffer.from([IAC, NOP]);
}

/** Request TTYPE from client: IAC SB TTYPE SEND IAC SE. */
export function requestTtype(): Buffer {
  return iacSub(OPT_TTYPE, TTYPE_SEND);
}

// ─── Negotiation state machine ───────────────────────────────────────────────

/** Parsed IAC event from the telnet stream. */
export type IacEvent =
  | { type: "will"; option: number }
  | { type: "wont"; option: number }
  | { type: "do"; option: number }
  | { type: "dont"; option: number }
  | { type: "subneg"; option: number; data: Buffer }
  | { type: "nop" }
  | { type: "data"; data: Buffer };

/**
 * State machine that parses a raw TCP byte stream and separates telnet
 * IAC sequences from user data.
 *
 * Feed it chunks via `feed()` and collect the resulting events.
 */
export class TelnetParser {
  private state: "data" | "iac" | "will" | "wont" | "do" | "dont" | "sb" | "sb-data" | "sb-iac" = "data";
  private subOption = 0;
  private subData: number[] = [];

  /** Feed raw bytes and return parsed events. */
  feed(chunk: Buffer): IacEvent[] {
    const events: IacEvent[] = [];
    const dataBytes: number[] = [];

    const flushData = (): void => {
      if (dataBytes.length > 0) {
        events.push({ type: "data", data: Buffer.from(dataBytes) });
        dataBytes.length = 0;
      }
    };

    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      switch (this.state) {
        case "data":
          if (byte === IAC) {
            flushData();
            this.state = "iac";
          } else {
            dataBytes.push(byte);
          }
          break;

        case "iac":
          switch (byte) {
            case IAC: // escaped 0xFF in data
              dataBytes.push(0xff);
              this.state = "data";
              break;
            case WILL:
              this.state = "will";
              break;
            case WONT:
              this.state = "wont";
              break;
            case DO:
              this.state = "do";
              break;
            case DONT:
              this.state = "dont";
              break;
            case SB:
              this.state = "sb";
              break;
            case NOP:
              events.push({ type: "nop" });
              this.state = "data";
              break;
            case SE:
              // Unexpected SE outside sub-negotiation; ignore
              this.state = "data";
              break;
            default:
              // Unknown command; skip
              this.state = "data";
              break;
          }
          break;

        case "will":
          events.push({ type: "will", option: byte });
          this.state = "data";
          break;

        case "wont":
          events.push({ type: "wont", option: byte });
          this.state = "data";
          break;

        case "do":
          events.push({ type: "do", option: byte });
          this.state = "data";
          break;

        case "dont":
          events.push({ type: "dont", option: byte });
          this.state = "data";
          break;

        case "sb":
          this.subOption = byte;
          this.subData = [];
          this.state = "sb-data";
          break;

        case "sb-data":
          if (byte === IAC) {
            this.state = "sb-iac";
          } else {
            this.subData.push(byte);
          }
          break;

        case "sb-iac":
          if (byte === SE) {
            events.push({
              type: "subneg",
              option: this.subOption,
              data: Buffer.from(this.subData),
            });
            this.state = "data";
          } else if (byte === IAC) {
            // Escaped 0xFF inside sub-negotiation
            this.subData.push(0xff);
            this.state = "sb-data";
          } else {
            // Malformed: IAC followed by a command byte inside subneg.
            // Terminate the sub-negotiation, then re-parse the byte as a
            // command (it follows the IAC we already consumed).
            events.push({
              type: "subneg",
              option: this.subOption,
              data: Buffer.from(this.subData),
            });
            this.state = "iac";
            i--; // re-process this byte as the IAC command byte
          }
          break;
      }
    }

    flushData();
    return events;
  }
}

// ─── NAWS parsing ────────────────────────────────────────────────────────────

/**
 * Parse a NAWS sub-negotiation payload.
 * NAWS sends 4 bytes: width-hi, width-lo, height-hi, height-lo.
 */
export function parseNaws(data: Buffer): { cols: number; rows: number } | undefined {
  if (data.length < 4) return undefined;
  const cols = data.readUInt16BE(0);
  const rows = data.readUInt16BE(2);
  // Sanity-check: ignore nonsensical values
  if (cols < 10 || cols > 500 || rows < 1 || rows > 200) return undefined;
  return { cols, rows };
}

// ─── TTYPE parsing ───────────────────────────────────────────────────────────

/**
 * Parse a TTYPE IS sub-negotiation payload.
 * Payload: IS (0x00) followed by ASCII terminal type string.
 */
export function parseTtype(data: Buffer): string | undefined {
  if (data.length < 2 || data[0] !== TTYPE_IS) return undefined;
  return data.subarray(1).toString("ascii").trim().toUpperCase();
}

// ─── ANSI capability heuristic ───────────────────────────────────────────────

/** Terminal types known to support ANSI color. */
const ANSI_TERMINALS = new Set([
  "XTERM", "XTERM-256COLOR", "XTERM-COLOR",
  "VT100", "VT102", "VT220", "VT320",
  "ANSI", "LINUX", "SCREEN", "SCREEN-256COLOR",
  "TMUX", "TMUX-256COLOR", "RXVT", "RXVT-UNICODE",
  "KONSOLE", "GNOME", "GNOME-256COLOR",
  "PUTTY", "CYGWIN", "MINTTY",
  "MUDLET", "MUSHCLIENT", "CMUD", "ZMUD",
  "TINTIN++", "TINYFUGUE",
]);

/**
 * Determine whether a terminal type string suggests ANSI color support.
 * Returns true for known ANSI-capable terminals and anything containing
 * "256COLOR", "XTERM", or "ANSI".
 */
export function supportsAnsi(terminalType: string | undefined): boolean {
  if (!terminalType) return false;
  const upper = terminalType.toUpperCase();
  if (ANSI_TERMINALS.has(upper)) return true;
  return upper.includes("XTERM") || upper.includes("256COLOR") || upper.includes("ANSI");
}

/**
 * Chalk color level: 0 = no color, 1 = basic 16, 2 = 256, 3 = TrueColor (16M).
 */
export type ColorLevel = 0 | 1 | 2 | 3;

/**
 * Determine the best chalk color level from a list of terminal type strings
 * collected via RFC 1091 TTYPE cycling.
 *
 * The TTYPE cycle typically yields:
 *   1. Client name (e.g. "MUDLET")
 *   2. Terminal emulation type (e.g. "ANSI-TRUECOLOR")
 *   3. Repeat of (2) signaling end of cycle
 *
 * We examine all collected types and return the highest level matched:
 *   - 3 (TrueColor) for "TRUECOLOR", "24BIT", or "DIRECT"
 *   - 2 (256-color) for "256COLOR"
 *   - 1 (basic 16) for any other known ANSI terminal
 *   - 0 (no color) if nothing suggests ANSI support
 */
export function detectColorLevel(terminalTypes: string[]): ColorLevel {
  let level: ColorLevel = 0;

  for (const raw of terminalTypes) {
    const upper = raw.toUpperCase();

    // TrueColor indicators
    if (upper.includes("TRUECOLOR") || upper.includes("24BIT") || upper.includes("DIRECT")) {
      return 3;
    }

    // 256-color
    if (upper.includes("256COLOR")) {
      level = Math.max(level, 2) as ColorLevel;
      continue;
    }

    // Basic ANSI
    if (ANSI_TERMINALS.has(upper) || upper.includes("XTERM") || upper.includes("ANSI")) {
      level = Math.max(level, 1) as ColorLevel;
    }
  }

  return level;
}
