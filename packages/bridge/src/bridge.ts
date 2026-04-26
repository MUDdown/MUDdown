/**
 * MUDdown Telnet Bridge — implementation module
 *
 * Imported by main.ts after FORCE_COLOR is set.  Do not import this
 * module directly; use main.ts as the entry point so chalk picks up
 * the process-level color override before any ESM imports resolve.
 *
 * Features:
 * - TLS-only connections (TELNETS) on port 2323
 * - Telnet protocol negotiation (NAWS, TTYPE, ECHO, SGA)
 * - ANSI color auto-detection via TTYPE
 * - Browser-based OAuth login (login command → URL → token-poll)
 * - Guest play without auth
 * - Plain text and numbered link modes
 * - Keepalive via telnet NOP
 * - Graceful shutdown on SIGTERM/SIGINT
 */

import { createServer as createTlsServer } from "node:tls";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

import WebSocket from "ws";
import {
  MUDdownConnection,
  renderTerminal,
  CommandHistory,
} from "@muddown/client";
import type { LinkMode, NumberedLink } from "@muddown/client";
import { CHARACTER_CLASSES } from "@muddown/shared";
import {
  TelnetParser,
  iacDo,
  iacDont,
  iacWill,
  iacWont,
  iacNop,
  requestTtype,
  requestNewEnviron,
  parseNaws,
  parseTtype,
  parseNewEnviron,
  detectColorLevel,
  OPT_ECHO,
  OPT_SGA,
  OPT_TTYPE,
  OPT_NAWS,
  OPT_NEW_ENVIRON,
  OPT_MSSP,
} from "./telnet.js";
import type { IacEvent, ColorLevel } from "./telnet.js";

import {
  loadConfig,
  getBanner,
  getStartupMenu,
  wsToHttpBase,
  buildLoginUrl,
  displayProviderName,
  updateTtypeCycle,
  buildOsc8Hyperlink,
  isCapabilityEnabled,
  deriveLinkMode,
  nextLinkMode,
  buildMsspVars,
  buildMsspSubneg,
  MSSP_STATS_UNKNOWN,
} from "./helpers.js";
import type { BridgeConfig, MsspStats } from "./helpers.js";

// @ts-expect-error — MUDdownConnection expects browser WebSocket global
globalThis.WebSocket = WebSocket;

// ─── Sentinel errors ─────────────────────────────────────────────────────────

/**
 * Thrown into a pending `prompt()` promise when the session is disposed
 * (e.g. the user disconnected mid-flow). Callers in the startup menu /
 * login flow check for this so a normal disconnect doesn't surface as an
 * error in operator logs.
 */
class SessionDisposedError extends Error {
  constructor() {
    super("session disposed");
    this.name = "SessionDisposedError";
  }
}

// ─── HTTP helpers (reused from terminal client pattern) ──────────────────────

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 5000, externalSignal?: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Forward an external abort (e.g. dispose / picker race) into the
  // fetch's own signal so an in-flight HTTP request is cancelled
  // immediately instead of running for the full timeout window.
  const onExternalAbort = () => controller.abort();
  let listenerAttached = false;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      listenerAttached = true;
    }
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (listenerAttached) {
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

async function fetchProviders(httpBase: string): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(`${httpBase}/auth/providers`);
    if (!res.ok) return [];
    const data = await res.json() as { providers?: string[] };
    return data.providers ?? [];
  } catch (err) {
    console.error("[bridge] fetchProviders failed:", err);
    return [];
  }
}

async function pollForToken(httpBase: string, nonce: string, maxAttempts: number, intervalMs: number, signal?: AbortSignal): Promise<string | undefined> {
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) return undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, intervalMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return undefined;
      throw err;
    }
    if (signal?.aborted) return undefined;
    try {
      const res = await fetchWithTimeout(
        `${httpBase}/auth/token-poll?nonce=${encodeURIComponent(nonce)}`,
        {},
        5000,
        signal,
      );
      if (res.status === 200) {
        try {
          const data = await res.json() as { token?: string };
          return data.token;
        } catch (parseErr: unknown) {
          console.error("[bridge] pollForToken: failed to parse 200 response as JSON:", parseErr);
          return undefined;
        }
      }
      if (res.status !== 202) return undefined;
    } catch (err: unknown) {
      const isAbort = (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.name === "AbortError");
      if (isAbort) {
        // External abort (dispose / picker race) — exit cleanly. The
        // per-request timeout also surfaces as AbortError, but in that
        // case `signal?.aborted` is false; treat both as retryable
        // network failures only when no external cancellation is in
        // play.
        //
        // Invariant: between the two `signal?.aborted` checks below
        // (this one and the one at the top of the next iteration), no
        // external abort can interleave because JavaScript is
        // single-threaded — the abort handler can only run at the next
        // microtask boundary, which we don't await here.
        if (signal?.aborted) return undefined;
        // Per-request timeout: treat as a transient network error and
        // retry on the next iteration.
        continue;
      }

      // Detect network errors by checking error properties rather than
      // brittle message text. Node's undici-based fetch throws TypeError
      // with a `cause` carrying a system error code. Anything without a
      // recognised code is non-retryable.
      let isNetworkError = false;
      if (err instanceof TypeError) {
        const cause = (err as { cause?: { code?: string } }).cause;
        const code = cause?.code ?? (err as { code?: string }).code;
        if (code) {
          // System-level connection failures (ECONNREFUSED, ECONNRESET,
          // ENOTFOUND, ETIMEDOUT, EPIPE, etc.)
          isNetworkError = /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|UND_ERR)/.test(code);
        }
      }

      if (isNetworkError) {
        continue;
      }
      console.error("[bridge] pollForToken: non-retryable error:", err);
      return undefined;
    }
  }
  const redactedNonce = nonce.length > 8
    ? `${nonce.slice(0, 4)}…${nonce.slice(-4)}`
    : "[redacted]";
  console.error(`[bridge] pollForToken: exhausted ${maxAttempts} attempts for nonce ${redactedNonce}`);
  return undefined;
}

async function fetchWsTicket(httpBase: string, sessionToken: string): Promise<string | undefined> {
  try {
    const res = await fetchWithTimeout(`${httpBase}/auth/ws-ticket`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    if (!res.ok) return undefined;
    const data = await res.json() as { ticket?: string };
    return data.ticket;
  } catch (err) {
    console.error("[bridge] fetchWsTicket failed:", err);
    return undefined;
  }
}

interface CharacterEntry {
  id: string;
  name: string;
  characterClass: string;
}

async function fetchCharacters(httpBase: string, token: string): Promise<CharacterEntry[]> {
  try {
    const res = await fetchWithTimeout(`${httpBase}/auth/characters`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json() as { characters?: CharacterEntry[] };
    return data.characters ?? [];
  } catch (err) {
    console.error("[bridge] fetchCharacters failed:", err);
    return [];
  }
}

async function postSelectCharacter(httpBase: string, token: string, characterId: string): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${httpBase}/auth/select-character`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ characterId }),
    });
    return res.ok;
  } catch (err) {
    console.error("[bridge] postSelectCharacter failed:", err);
    return false;
  }
}

async function postCreateCharacter(
  httpBase: string,
  token: string,
  name: string,
  characterClass: string,
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(`${httpBase}/auth/create-character`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, characterClass }),
    });
    return res.ok;
  } catch (err) {
    console.error("[bridge] postCreateCharacter failed:", err);
    return false;
  }
}

// ─── MSSP state ──────────────────────────────────────────────────────────────

/**
 * Unix seconds at bridge process start. Advertised as MSSP `UPTIME`.
 * Reflects bridge startup, not game-server startup — restarting just the
 * game server will not advance this value.
 */
const BRIDGE_STARTED_AT = Math.floor(Date.now() / 1000);

/** Minimum ms between `/stats` fetches when the previous one succeeded. */
const MSSP_STATS_TTL_MS = 30_000;
/** Minimum ms between `/stats` fetches when the previous one failed. */
const MSSP_STATS_FAILURE_BACKOFF_MS = 5_000;

let msspStatsCache: MsspStats = MSSP_STATS_UNKNOWN;
let msspStatsFetchedAt = 0;
/**
 * Whether the most recent `/stats` fetch succeeded. Drives the TTL/backoff
 * choice independently of the cache contents so that a successful fetch
 * followed by a failure still applies the short backoff (rather than
 * sticking with the 30s success TTL because the last-good snapshot is
 * still in the cache).
 */
let msspLastFetchSucceeded = false;
/**
 * In-flight `/stats` fetch shared across concurrent callers. Without
 * this, two `IAC DO MSSP` requests arriving in the same event-loop turn
 * before the first fetch settles would each pass the TTL guard and spawn
 * their own `fetchWithTimeout` call.
 */
let msspStatsInFlight: Promise<MsspStats> | undefined;
let msspResolvedIp = "";

/** Maximum wall time to wait for the startup DNS lookup. */
const MSSP_DNS_TIMEOUT_MS = 5_000;

/**
 * Resolve the hostname to an IPv4 address once at startup so MSSP `IP`
 * carries a real value. A lookup failure or timeout leaves `msspResolvedIp`
 * empty, which causes `buildMsspVars` to omit the key entirely. Not
 * retried — operators should verify DNS is reachable at boot.
 *
 * `dns.promises.lookup` does not accept an `AbortSignal` (the underlying
 * `getaddrinfo` is uncancellable), so we race the lookup against a timer
 * to bound how long startup can stall on a wedged resolver. The orphaned
 * lookup promise will eventually settle and is intentionally ignored.
 */
export async function resolveMsspIp(hostname: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`DNS lookup timed out after ${MSSP_DNS_TIMEOUT_MS}ms`)),
      MSSP_DNS_TIMEOUT_MS,
    );
  });
  try {
    const { address } = await Promise.race([
      dnsLookup(hostname, { family: 4 }),
      timeout,
    ]);
    msspResolvedIp = address;
  } catch (err) {
    console.error(`[bridge] MSSP IP lookup for ${JSON.stringify(hostname)} failed; omitting IP for this bridge lifetime:`, err);
    msspResolvedIp = "";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Fetch `/stats` from the game server with a short timeout and cache the
 * result. Returns the last successful snapshot (or `MSSP_STATS_UNKNOWN`
 * if none yet).
 *
 * Cache policy:
 * - On success, serve the snapshot for {@link MSSP_STATS_TTL_MS} (30s).
 * - On failure, back off for {@link MSSP_STATS_FAILURE_BACKOFF_MS} (5s)
 *   so a storm of crawler DO MSSP requests does not hammer a wedged
 *   game server with concurrent 3-second fetches.
 *
 * `uptime` is overwritten with the bridge process start time — `/stats`
 * has no opinion on it. Any field missing or of the wrong type in the
 * response falls back to `-1` (MSSP's "unknown" sentinel), so a schema
 * drift (e.g. field rename) advertises "unknown" rather than silently
 * zeroing out.
 */
export async function getMsspStats(httpBase: string): Promise<MsspStats> {
  const now = Date.now();
  const ttl = msspLastFetchSucceeded ? MSSP_STATS_TTL_MS : MSSP_STATS_FAILURE_BACKOFF_MS;
  if (msspStatsFetchedAt > 0 && now - msspStatsFetchedAt < ttl) {
    return msspStatsCache;
  }
  // Share an in-flight fetch across concurrent callers so a burst of
  // `IAC DO MSSP` requests during a cold cache (or just-expired window)
  // collapses to a single `/stats` call.
  if (msspStatsInFlight) return msspStatsInFlight;
  msspStatsInFlight = (async () => {
    try {
      const res = await fetchWithTimeout(`${httpBase}/stats`, {}, 3000);
      if (res.ok) {
        const data = await res.json() as Partial<MsspStats>;
        msspStatsCache = {
          players: typeof data.players === "number" ? data.players : -1,
          uptime: BRIDGE_STARTED_AT,
          areas: typeof data.areas === "number" ? data.areas : -1,
          rooms: typeof data.rooms === "number" ? data.rooms : -1,
          objects: typeof data.objects === "number" ? data.objects : -1,
          mobiles: typeof data.mobiles === "number" ? data.mobiles : -1,
          helpfiles: typeof data.helpfiles === "number" ? data.helpfiles : -1,
          classes: typeof data.classes === "number" ? data.classes : -1,
          levels: typeof data.levels === "number" ? data.levels : -1,
        };
        msspLastFetchSucceeded = true;
      } else {
        console.warn(`[bridge] /stats returned HTTP ${res.status}; using cached MSSP values`);
        msspLastFetchSucceeded = false;
      }
    } catch (err) {
      console.warn("[bridge] /stats fetch failed; using cached MSSP values:", err);
      msspLastFetchSucceeded = false;
    } finally {
      msspStatsFetchedAt = Date.now();
      msspStatsInFlight = undefined;
    }
    return msspStatsCache;
  })();
  return msspStatsInFlight;
}

/** Hook for tests to reset the module-level MSSP cache. */
export function __resetMsspCacheForTesting(): void {
  msspStatsCache = MSSP_STATS_UNKNOWN;
  msspStatsFetchedAt = 0;
  msspLastFetchSucceeded = false;
  msspStatsInFlight = undefined;
  msspResolvedIp = "";
}

// ─── Telnet Session ──────────────────────────────────────────────────────────

/**
 * Per-client session state.  Manages telnet negotiation, WebSocket proxy,
 * rendering, input buffering, and auth state.
 */
export class TelnetSession {
  readonly id: string;
  private socket: Socket | TLSSocket;
  private config: BridgeConfig;
  private parser = new TelnetParser();
  private conn: MUDdownConnection | null = null;
  private history = new CommandHistory();
  private activeLinks: NumberedLink[] = [];
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  // Telnet negotiation state
  private cols = 80;
  private rows = 24;
  private terminalTypes: string[] = [];
  private ansi = true;
  private colorLevel: ColorLevel = 1;
  private negotiationDone = false;
  private negotiationTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Client capabilities advertised via NEW-ENVIRON USERVARs.
   * Populated from Mudlet's OSC_HYPERLINKS* uservars — see
   * https://wiki.mudlet.org/w/Manual:OSC_8_Hyperlinks
   *
   * A USERVAR is considered "advertised" when the client sends it with
   * a truthy value ("1", "true", or empty but present).  The sub-negotiation
   * response `IAC SB NEW-ENVIRON IS USERVAR OSC_HYPERLINKS VALUE 1 ... IAC SE`
   * is the baseline signal that OSC 8 hyperlinks are supported.
   */
  private capabilities = new Set<string>();

  // Link mode. `linkMode` is the user's explicit override (set via the
  // `linkmode` command); `undefined` means "auto" — derive from capabilities
  // at render time. When the client advertises `OSC_HYPERLINKS_SEND`
  // (Mudlet, Fado, MudForge, any other OSC 8-send-aware client) we prefer
  // the `osc8-send` mode so game-command links become clickable.
  private linkMode: LinkMode | undefined = undefined;

  /** Link mode actually used for rendering, considering capabilities. */
  private get effectiveLinkMode(): LinkMode {
    return deriveLinkMode(this.linkMode, this.capabilities);
  }

  // Auth state
  private sessionToken: string | undefined;
  private wsTicket: string | undefined;

  // Input buffer (line-buffered)
  private inputBuffer = "";
  private lastWasCR = false;

  // Login flow guard
  private loginInProgress = false;

  // Interactive prompt state for multi-step flows (login, character creation)
  private promptHandler: ((line: string) => void) | null = null;
  private promptReject: ((err: Error) => void) | null = null;

  // Aborts any in-flight pollForToken (provider picker race + retry-loop
  // poll) so dispose() can promptly stop background HTTP traffic instead
  // of letting it run for up to the full 2-minute poll window.
  private loginAbort: AbortController | null = null;

  // Tracks the live OAuth nonce so disconnect paths (dispose, picker
  // exhaustion, picker bailout, retry-loop guest fallback) can fire a
  // best-effort POST /auth/login-cancel to drop the server-side
  // completedLogins entry immediately rather than wait the 10-minute TTL.
  // Cleared once the token has been consumed (no cancel needed) or once
  // a cancel has been dispatched.
  private currentLoginHttpBase: string | null = null;
  private currentLoginNonce: string | null = null;

  private disposed = false;

  constructor(socket: Socket | TLSSocket, config: BridgeConfig) {
    this.id = randomUUID();
    this.socket = socket;
    this.config = config;

    this.socket.on("data", (chunk: Buffer) => {
      try {
        this.onData(chunk);
      } catch (err) {
        console.error(`[bridge] [${this.id}] onData error:`, err);
        this.dispose();
      }
    });
    this.socket.on("close", () => this.dispose());
    this.socket.on("error", (err: Error) => {
      console.error(`[bridge] session ${this.id}: socket error from ${this.socket.remoteAddress ?? "unknown"}:`, err.stack ?? err.message);
      this.dispose();
    });

    // Start telnet negotiation
    this.negotiate();
  }

  // ─── Telnet Negotiation ──────────────────────────────────────────────

  private negotiate(): void {
    // Request NAWS, TTYPE, NEW-ENVIRON, and offer SGA + MSSP.
    // Note: we do NOT send WILL ECHO — Mudlet treats that as password-masking
    // mode and shows asterisks instead of typed characters. The client handles
    // local echo, so the bridge must not echo input back.
    this.write(iacDo(OPT_NAWS));
    this.write(iacDo(OPT_TTYPE));
    this.write(iacDo(OPT_NEW_ENVIRON));
    this.write(iacWill(OPT_SGA));
    // Offer MSSP so crawlers and listing clients can query server metadata.
    // Responds on IAC DO MSSP with a single sub-negotiation — see handleDo.
    this.write(iacWill(OPT_MSSP));

    // Give client 1.5s to respond to negotiation before proceeding
    this.negotiationTimer = setTimeout(() => {
      if (!this.negotiationDone) {
        this.finishNegotiation();
      }
    }, 1500);
  }

  private finishNegotiation(): void {
    if (this.negotiationDone) return;
    this.negotiationDone = true;
    clearTimeout(this.negotiationTimer);

    // Determine color level from all collected terminal types
    this.colorLevel = detectColorLevel(this.terminalTypes);
    this.ansi = this.colorLevel > 0;

    console.log(`[bridge] [${this.id}] negotiation complete: ttype=[${this.terminalTypes.join(", ")}], colorLevel=${this.colorLevel}, cols=${this.cols}, capabilities=[${[...this.capabilities].map((c) => JSON.stringify(c)).join(", ")}], effectiveLinkMode=${this.effectiveLinkMode}`);

    // Send banner
    this.writeLine(getBanner(this.config.serverName));

    // Start keepalive
    this.keepaliveTimer = setInterval(() => {
      if (!this.disposed) this.write(iacNop());
    }, this.config.keepaliveMs);

    // Show the opening menu (login existing / create new / play as guest).
    // The game-server connection is deferred until the user picks a path.
    void this.runStartupMenu();
  }

  // ─── Data handling ───────────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    let events: IacEvent[];
    try {
      events = this.parser.feed(chunk);
    } catch (err: unknown) {
      console.error(`[bridge] session ${this.id}: parser error; dropping connection:`, err);
      this.dispose();
      return;
    }

    for (const event of events) {
      try {
        switch (event.type) {
          case "will":
            this.handleWill(event.option);
            break;
          case "wont":
            this.handleWont(event.option);
            break;
          case "do":
            this.handleDo(event.option);
            break;
          case "dont":
            this.handleDont(event.option);
            break;
          case "subneg":
            this.handleSubneg(event.option, event.data);
            break;
          case "data":
            this.handleUserData(event.data);
            break;
          case "nop":
            // Ignore client NOPs
            break;
        }
      } catch (err: unknown) {
        console.error(`[bridge] session ${this.id}: error handling telnet event ${event.type}:`, err);
        this.dispose();
        return;
      }
    }
  }

  private handleWill(option: number): void {
    switch (option) {
      case OPT_NAWS:
        // Client agrees to send window size — we'll get it via subneg
        break;
      case OPT_TTYPE:
        // Client agrees to send terminal type — request it
        this.write(requestTtype());
        break;
      case OPT_NEW_ENVIRON:
        // Client agrees to send environment vars — ask for everything it has.
        // Mudlet responds with its OSC_HYPERLINKS* capability uservars.
        this.write(requestNewEnviron());
        break;
      default:
        // Reject unknown options (DONT is the correct response to WILL)
        this.write(iacDont(option));
        break;
    }
  }

  private handleWont(option: number): void {
    // Client refuses an option — that's fine, we use defaults
    if (option === OPT_TTYPE) {
      // No TTYPE — finish negotiation if NAWS already came or timed out
      if (!this.negotiationDone) this.finishNegotiation();
    } else if (option === OPT_NEW_ENVIRON) {
      // Client revoked (or refused) NEW-ENVIRON. Drop any advertised
      // capabilities so we don't keep sending OSC 8 sequences to a
      // client that has opted out.
      if (this.capabilities.size > 0) {
        console.log(`[bridge] [${this.id}] client sent WONT NEW-ENVIRON; clearing capabilities`);
        this.capabilities.clear();
      }
    }
  }

  private handleDo(option: number): void {
    switch (option) {
      case OPT_SGA:
        // Client agrees to suppress go-ahead
        break;
      case OPT_ECHO:
        // We are NOT handling echo — client does local echo
        this.write(iacWont(OPT_ECHO));
        break;
      case OPT_MSSP:
        // Client requested MSSP variables; send one sub-negotiation then
        // drop through. Crawlers typically disconnect right after parsing.
        this.sendMssp();
        break;
      default:
        this.write(iacWont(option));
        break;
    }
  }

  private handleDont(option: number): void {
    // Client doesn't want us to do something — acknowledge
    if (option === OPT_ECHO || option === OPT_SGA) {
      this.write(iacWont(option));
    }
    // OPT_MSSP DONT is a benign no-op — there's no ongoing state to unwind.
  }

  /** Emit the MSSP sub-negotiation with the current cached stats snapshot. */
  private sendMssp(): void {
    const httpBase = wsToHttpBase(this.config.gameServerUrl);
    getMsspStats(httpBase).then((stats) => {
      if (this.disposed) return;
      try {
        const vars = buildMsspVars(this.config.mssp, stats, this.config.port, msspResolvedIp);
        this.write(buildMsspSubneg(vars));
      } catch (err) {
        // buildMsspSubneg rejects reserved bytes in names/values. The client
        // already saw IAC WILL MSSP and is waiting for the sub-negotiation,
        // so emit IAC WONT MSSP to cleanly withdraw the offer instead of
        // letting the crawler time out.
        console.error(`[bridge] [${this.id}] buildMsspSubneg failed; sending WONT MSSP:`, err);
        this.write(iacWont(OPT_MSSP));
      }
    }).catch((err) => {
      console.error(`[bridge] [${this.id}] sendMssp failed:`, err);
      this.write(iacWont(OPT_MSSP));
    });
  }

  private handleSubneg(option: number, data: Buffer): void {
    switch (option) {
      case OPT_NAWS: {
        const naws = parseNaws(data);
        if (naws) {
          this.cols = naws.cols;
          this.rows = naws.rows;
        }
        break;
      }
      case OPT_TTYPE: {
        const ttype = parseTtype(data);
        const { done, types } = updateTtypeCycle(this.terminalTypes, ttype);
        this.terminalTypes = types;
        if (done) {
          if (!this.negotiationDone) this.finishNegotiation();
        } else if (this.negotiationDone) {
          // Late TTYPE after timeout — recompute color level from what
          // we have but stop requesting more types.
          this.colorLevel = detectColorLevel(this.terminalTypes);
          this.ansi = this.colorLevel > 0;
        } else {
          this.write(requestTtype());
        }
        break;
      }
      case OPT_NEW_ENVIRON: {
        const parsed = parseNewEnviron(data);
        if (!parsed) {
          console.warn(`[bridge] [${this.id}] ignoring malformed NEW-ENVIRON sub-negotiation (len=${data.length}, first=0x${data[0]?.toString(16) ?? "??"})`);
          break;
        }
        for (const warning of parsed.warnings) {
          console.warn(`[bridge] [${this.id}] NEW-ENVIRON: ${warning}`);
        }
        if (this.negotiationDone) {
          console.log(`[bridge] [${this.id}] NEW-ENVIRON arrived after negotiation timeout; capabilities still accepted`);
        }
        // Mudlet advertises OSC 8 capability tiers as USERVARs with a
        // truthy value ("", "1", "true"). Any other explicit value
        // (e.g. "0") means the capability is disabled.
        for (const [name, value] of parsed.uservars) {
          const enabled = isCapabilityEnabled(value);
          const had = this.capabilities.has(name);
          // Log name via JSON.stringify so embedded control bytes in a
          // client-supplied USERVAR name can't inject escape sequences
          // or forge newlines in the operator console.
          if (enabled) {
            this.capabilities.add(name);
            if (!had) console.log(`[bridge] [${this.id}] capability +${JSON.stringify(name)} (value=${JSON.stringify(value)})`);
          } else {
            this.capabilities.delete(name);
            if (had) console.log(`[bridge] [${this.id}] capability -${JSON.stringify(name)} (value=${JSON.stringify(value)})`);
          }
        }
        break;
      }
    }
  }

  // ─── User input handling ─────────────────────────────────────────────

  private handleUserData(data: Buffer): void {
    for (const byte of data) {
      // Handle backspace (0x08 or 0x7F)
      if (byte === 0x08 || byte === 0x7f) {
        if (this.inputBuffer.length > 0) {
          this.inputBuffer = this.inputBuffer.slice(0, -1);
        }
        continue;
      }

      // Carriage return or newline = submit line
      if (byte === 0x0d || byte === 0x0a) {
        // Skip the LF after CR (CR+LF pair)
        if (byte === 0x0a && this.lastWasCR) {
          this.lastWasCR = false;
          continue;
        }
        this.lastWasCR = byte === 0x0d;

        const line = this.inputBuffer;
        this.inputBuffer = "";

        if (line.trim()) {
          this.history.push(line.trim());
        }

        this.processLine(line);
        continue;
      }

      this.lastWasCR = false;

      // Printable ASCII
      if (byte >= 0x20 && byte < 0x7f) {
        this.inputBuffer += String.fromCharCode(byte);
      }
    }
  }

  private processLine(line: string): void {
    const trimmed = line.trim();

    // If we're in an interactive prompt flow, route to the handler
    if (this.promptHandler) {
      this.promptHandler(trimmed);
      return;
    }

    // Bridge-local commands
    const lower = trimmed.toLowerCase();

    if (lower === "quit" || lower === "exit") {
      this.writeLine("\r\nDisconnecting. Goodbye!\r\n");
      this.dispose();
      return;
    }

    if (lower === "help") {
      this.writeLine("");
      this.writeLine("Bridge commands:");
      this.writeLine("  help      \u2014 show this list");
      this.writeLine("  login     \u2014 log in to your account (OAuth)");
      this.writeLine("  linkmode  \u2014 cycle link rendering (plain / numbered / osc8-send / auto)");
      this.writeLine("  legend    \u2014 list active numbered links");
      this.writeLine("  quit      \u2014 disconnect");
      this.writeLine("");
      return;
    }

    if (lower === "linkmode") {
      // Cycle explicit modes: plain → numbered → (osc8-send if capable) → auto.
      // "auto" clears the override and returns to capability-derived mode.
      this.linkMode = nextLinkMode(this.linkMode, this.capabilities);
      const display = this.linkMode ?? `auto (${this.effectiveLinkMode})`;
      this.writeLine(`\r\nLink mode: ${display}\r\n`);
      return;
    }

    if (lower === "login") {
      if (this.loginInProgress) {
        this.writeLine("\r\nLogin already in progress.\r\n");
        return;
      }
      this.loginInProgress = true;
      this.handleLogin("existing")
        .then((ok) => {
          if (!ok && !this.disposed) {
            this.writeLine("\r\nLogin did not complete.\r\n");
          }
        })
        .catch((err) => {
          if (err instanceof SessionDisposedError) return;
          console.error(`[bridge] [${this.id}] login error:`, err);
          if (!this.disposed) {
            this.writeLine("\r\nLogin failed unexpectedly.\r\n");
          }
        })
        .finally(() => {
          this.promptHandler = null;
          this.promptReject = null;
          this.loginInProgress = false;
        });
      return;
    }

    if (lower === "legend") {
      if (this.effectiveLinkMode !== "numbered") {
        this.writeLine("\r\nLegend is only available in numbered link mode. Use 'linkmode' to switch.\r\n");
        return;
      }
      if (this.activeLinks.length === 0) {
        this.writeLine("\r\nNo active numbered links.\r\n");
        return;
      }
      this.writeLine("");
      for (const link of this.activeLinks) {
        this.writeLine(`  [${link.index}] ${link.command}`);
      }
      this.writeLine("");
      return;
    }

    // Numbered link shortcut
    if (this.effectiveLinkMode === "numbered" && /^\d+$/.test(trimmed)) {
      const idx = parseInt(trimmed, 10);
      const link = this.activeLinks.find(l => l.index === idx);
      if (link) {
        this.sendToGame(link.command);
        return;
      }
    }

    // Forward everything else to the game server
    if (trimmed) {
      this.sendToGame(trimmed);
    }
  }

  // ─── Auth flow ───────────────────────────────────────────────────────

  /**
   * Show the opening menu and dispatch on the user's choice. Runs after
   * telnet negotiation finishes and before the bridge connects to the game
   * server.
   *
   * Guest play is only entered when the user explicitly selects [3]; any
   * other unsuccessful path (cancelled login, empty character name, …)
   * re-shows the menu so the user can pick again. Bounded by
   * `MAX_MENU_ATTEMPTS` so a stuck session can't loop indefinitely.
   * Disposed sessions exit the loop immediately.
   */
  private async runStartupMenu(): Promise<void> {
    const MAX_MENU_ATTEMPTS = 5;
    let connected = false;
    let attempts = 0;

    while (!connected && !this.disposed && attempts < MAX_MENU_ATTEMPTS) {
      attempts++;

      try {
        // Inside try so a synchronous writeLine failure (very unlikely
        // — writeLine no-ops on disposed/non-writable sockets) still
        // hits the finally that clears promptHandler/promptReject
        // rather than leaving a stale handler from a prior iteration.
        this.writeLine(getStartupMenu());
        const choice = await this.prompt("Choice [1]: ");
        let idx = 1;
        if (choice !== "") {
          const parsed = /^\d+$/.test(choice) ? parseInt(choice, 10) : NaN;
          if (isNaN(parsed) || parsed < 1 || parsed > 3) {
            this.writeLine("Invalid choice — logging in to an existing character.\r\n");
          } else {
            idx = parsed;
          }
        }

        if (idx === 2) {
          this.loginInProgress = true;
          try {
            connected = await this.handleLogin("create");
          } finally {
            this.loginInProgress = false;
          }
        } else if (idx === 3) {
          this.writeLine("\r\nPlaying as a guest.\r\n");
          this.connectToGame();
          connected = true;
        } else {
          this.loginInProgress = true;
          try {
            connected = await this.handleLogin("existing");
          } finally {
            this.loginInProgress = false;
          }
        }
      } catch (err) {
        if (err instanceof SessionDisposedError) {
          // Normal disconnect mid-prompt — not an error worth logging.
          return;
        }
        console.error(`[bridge] [${this.id}] startup menu error:`, err);
        if (!this.disposed) {
          this.writeLine("\r\nAn error occurred during login. Please try again later.\r\n");
        }
      } finally {
        this.promptHandler = null;
        this.promptReject = null;
      }
    }

    if (!connected && !this.disposed) {
      this.writeLine(
        `\r\nGiving up after ${MAX_MENU_ATTEMPTS} attempts. Disconnecting.\r\n`,
      );
      this.dispose();
    }
  }

  /**
   * Best-effort cancel of an in-flight OAuth login nonce. Fires a
   * `POST /auth/login-cancel` so the server drops the
   * `completedLogins` entry immediately rather than wait for the
   * 10-minute TTL — narrowing the window in which a fresh session
   * token sits in memory keyed by a nonce we no longer need.
   *
   * Fire-and-forget: failure is non-fatal because the server-side
   * TTL will eventually clean up. Snapshots
   * `currentLoginHttpBase`/`currentLoginNonce`, then clears both
   * fields before issuing the request so repeated disconnect/cleanup
   * paths are best-effort one-shot and avoid double-cancelling.
   */
  private cancelCurrentLoginNonce(): void {
    const httpBase = this.currentLoginHttpBase;
    const nonce = this.currentLoginNonce;
    if (!httpBase || !nonce) return;
    this.currentLoginHttpBase = null;
    this.currentLoginNonce = null;
    fetchWithTimeout(
      `${httpBase}/auth/login-cancel`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce }),
      },
      3000,
    ).catch((err: unknown) => {
      console.warn(`[bridge] [${this.id}] login-cancel failed:`, err);
    });
  }

  /**
   * Run the OAuth login flow.
   *
   * @param mode "existing" jumps into the character picker afterwards;
   *             "create" jumps straight into character creation.
   * @returns true if a connection to the game server has been
   *          established (either authenticated, or guest play after
   *          the user explicitly typed `guest` at the retry prompt).
   *          false means the login attempt did not connect; the caller
   *          (`runStartupMenu`) re-shows the main menu rather than
   *          falling back to guest play implicitly.
   */
  private async handleLogin(mode: "existing" | "create"): Promise<boolean> {
    const httpBase = wsToHttpBase(this.config.gameServerUrl);
    const providers = await fetchProviders(httpBase);

    if (providers.length === 0) {
      this.writeLine("\r\nNo login providers available on this server.\r\n");
      return false;
    }

    const publicBase = this.config.publicBaseUrl ?? httpBase;
    const hyperlinkEnabled = this.capabilities.has("OSC_HYPERLINKS");

    // First nonce is generated before the retry loop so the same value can
    // be used in both the provider-picker URLs (multi-provider case) and
    // the initial login URL inside the loop. On retry we regenerate.
    let nonce = randomUUID();
    // Make the nonce visible to dispose() and other disconnect paths
    // so they can fire a best-effort POST /auth/login-cancel rather
    // than leave the server's completedLogins entry to age out.
    this.currentLoginHttpBase = httpBase;
    this.currentLoginNonce = nonce;

    let provider: string;
    // Track whether OAuth completed via a clicked picker hyperlink so we
    // can skip the URL prompt + second poll inside the retry loop below.
    let prePickedToken: string | undefined;
    if (providers.length === 1) {
      provider = providers[0];
    } else {
      // Provider picker. We deliberately do NOT auto-select a default
      // provider — the user's OAuth provider is personal and picking
      // the wrong one just wastes another login round. On invalid /
      // empty input we re-prompt up to MAX_PICKER_ATTEMPTS times so
      // typos are recoverable; on poll exhaustion (no input AND no
      // OSC 8 click for the full 2-minute window) we disconnect
      // immediately because the user has effectively walked away.
      // All disconnect paths fire a best-effort login-cancel and
      // dispose the session — dispose-then-return-false short-circuits
      // the caller's retry loop in `runStartupMenu` (which is gated on
      // !this.disposed) so the user doesn't see another menu over a
      // dead socket.
      this.writeLine("\r\nLogin Provider:");
      this.writeLine("");
      for (let i = 0; i < providers.length; i++) {
        const name = providers[i];
        const url = buildLoginUrl(publicBase, name, nonce);
        const label = displayProviderName(name);
        this.writeLine(`  [${i + 1}] ${buildOsc8Hyperlink(url, label, hyperlinkEnabled)}`);
      }
      this.writeLine("");

      // Race the picker prompt against an opportunistic poll for the
      // shared nonce: if the user clicks any provider's OSC 8
      // hyperlink, OAuth completes against this nonce server-side and
      // the poll resolves first — we can skip straight to character
      // selection without a second prompt.
      //
      // pollAbort is shared across picker retries (the 2-minute poll
      // budget is the user's overall window to act, not per-typo) and
      // is also stored on the instance (this.loginAbort) so dispose()
      // can stop the in-flight HTTP request immediately rather than
      // wait up to 2 minutes for the poll loop to finish.
      const pollAbort = new AbortController();
      this.loginAbort = pollAbort;
      type PickResult =
        | { kind: "choice"; line: string }
        | { kind: "token"; token: string };
      // .catch on both legs so the loser of the race doesn't bubble up
      // as an unhandled rejection (which Node treats as a fatal
      // error). Real failures are surfaced via the winner path or the
      // explicit poll-error handling in the retry loop below.
      const pollPromise: Promise<PickResult | undefined> = pollForToken(
        httpBase,
        nonce,
        60,
        2000,
        pollAbort.signal,
      ).then(
        (tok): PickResult | undefined => (tok ? { kind: "token", token: tok } : undefined),
        () => undefined,
      );

      const MAX_PICKER_ATTEMPTS = 3;
      let pickedProvider: string | undefined;
      let attempts = 0;
      while (!pickedProvider && !prePickedToken) {
        if (this.disposed) {
          pollAbort.abort();
          this.loginAbort = null;
          return false;
        }

        // Fresh pickAbort per iteration: the previous prompt has
        // settled (with a value or a rejection) and pickAbort.abort()
        // is a no-op once a controller has fired. We need a live
        // controller so a token-win on a subsequent race can still
        // cancel the in-flight prompt.
        const pickAbort = new AbortController();
        const pickPromise: Promise<PickResult | undefined> = this.prompt(
          "\r\nProvider: ",
          pickAbort.signal,
        ).then(
          (line): PickResult => ({ kind: "choice", line }),
          () => undefined,
        );

        const winner = await Promise.race([pickPromise, pollPromise]);

        if (winner && winner.kind === "token") {
          // User clicked a picker link; OAuth completed against the
          // shared nonce. Token is consumed by the poll's
          // one-time-retrieval, so no cancel needed — just clear the
          // tracking fields so dispose() doesn't fire a (now stale)
          // login-cancel.
          pickAbort.abort();
          this.loginAbort = null;
          this.currentLoginHttpBase = null;
          this.currentLoginNonce = null;
          prePickedToken = winner.token;
          // Placeholder so the rest of the function has a provider
          // value; never actually used because prePickedToken
          // short-circuits the retry loop below.
          pickedProvider = providers[0];
          this.writeLine("\r\nLogin completed.\r\n");
          break;
        }

        if (!winner) {
          // Background poll exhausted its 60 attempts without a
          // token AND the user never answered the prompt — they've
          // walked away. Disconnect immediately.
          pickAbort.abort();
          this.loginAbort = null;
          if (!this.disposed) {
            this.writeLine("\r\nLogin session expired without a response. Disconnecting.\r\n");
            this.cancelCurrentLoginNonce();
            this.dispose();
          }
          return false;
        }

        // winner.kind === "choice": user typed something. Validate.
        const choice = winner.line.trim();
        const idx = parseInt(choice, 10);
        if (choice !== "" && !isNaN(idx) && idx >= 1 && idx <= providers.length) {
          pickedProvider = providers[idx - 1];
          pollAbort.abort();
          this.loginAbort = null;
          break;
        }

        // Invalid input — re-prompt unless we've used up our budget.
        attempts++;
        if (attempts >= MAX_PICKER_ATTEMPTS) {
          pollAbort.abort();
          this.loginAbort = null;
          if (!this.disposed) {
            this.writeLine(
              `\r\nNo valid provider selected after ${MAX_PICKER_ATTEMPTS} attempts. Disconnecting.\r\n`,
            );
            this.cancelCurrentLoginNonce();
            this.dispose();
          }
          return false;
        }
        const remaining = MAX_PICKER_ATTEMPTS - attempts;
        this.writeLine(
          `Invalid choice — please enter a number from 1 to ${providers.length} or click one of the links above. (${remaining} attempt${remaining === 1 ? "" : "s"} remaining)`,
        );
      }

      provider = pickedProvider ?? providers[0];
    }

    // Retry loop: timed-out logins regenerate the nonce + URL so an expired
    // 2-minute window is recoverable without restarting the startup menu.
    let sessionToken: string | undefined = prePickedToken;
    let firstAttempt = true;
    while (!sessionToken) {
      if (this.disposed) return false;

      const loginUrl = buildLoginUrl(publicBase, provider, nonce);
      if (!firstAttempt) {
        this.writeLine("\r\nGenerating a new login URL — the previous one is no longer valid.");
      }
      this.writeLine("\r\nOpen this URL in your browser to log in:");
      this.writeLine("");
      this.writeLine(`  ${buildOsc8Hyperlink(loginUrl, loginUrl, hyperlinkEnabled)}`);
      this.writeLine("");
      this.writeLine("Waiting for login (up to 2 minutes)...");
      firstAttempt = false;

      let token: string | undefined;
      let pollError = false;
      const retryAbort = new AbortController();
      this.loginAbort = retryAbort;
      try {
        token = await pollForToken(httpBase, nonce, 60, 2000, retryAbort.signal);
      } catch (err) {
        pollError = true;
        console.error(`[bridge] [${this.id}] pollForToken error:`, err);
        if (!this.disposed) {
          this.writeLine("\r\nUnexpected error while waiting for login.\r\n");
        }
      } finally {
        if (this.loginAbort === retryAbort) this.loginAbort = null;
      }
      if (token) {
        sessionToken = token;
        // Token consumed by the poll's one-time-retrieval — clear the
        // tracking fields so dispose() doesn't fire a stale cancel.
        this.currentLoginHttpBase = null;
        this.currentLoginNonce = null;
        break;
      }

      if (this.disposed) return false;
      if (!pollError) {
        this.writeLine("\r\nLogin timed out.\r\n");
      }
      const retry = await this.prompt(
        "Press enter to try again, or type 'guest' to play as a guest: ",
      );
      if (retry.trim().toLowerCase() === "guest") {
        // User explicitly opted for guest play after a failed login.
        // Drop the unused server-side state and connect as guest here.
        // Clear any stale auth state on this session so a later
        // reconnect can't accidentally promote the guest socket back
        // into an authenticated one via a leftover sessionToken or
        // wsTicket from before the user typed `guest`.
        // The !this.disposed guard around connectToGame mirrors the
        // pattern in runStartupMenu — if the socket closed between the
        // retry prompt resolving and us getting here, connectToGame()
        // would silently no-op and we'd return true over a dead
        // session, leaving runStartupMenu's retry loop with no signal
        // that the user is gone.
        this.cancelCurrentLoginNonce();
        this.sessionToken = undefined;
        this.wsTicket = undefined;
        if (this.disposed) return false;
        this.writeLine("\r\nPlaying as a guest.\r\n");
        this.connectToGame();
        return true;
      }
      // Anything else (including empty) → cancel the old nonce
      // server-side and regenerate so the user gets a fresh URL.
      this.cancelCurrentLoginNonce();
      nonce = randomUUID();
      this.currentLoginHttpBase = httpBase;
      this.currentLoginNonce = nonce;
    }

    this.sessionToken = sessionToken;
    this.writeLine("\r\nLogged in! Selecting character...\r\n");

    return this.handleCharacterSelection(httpBase, sessionToken, mode);
  }

  /**
   * Drive character selection or creation, then fetch the auth ticket and
   * connect to the game server.
   *
   * @returns true if a character was selected/created AND a ws ticket was
   *          obtained AND `reconnectWithAuth` was called. false on any
   *          failure — the caller (`handleLogin` → `runStartupMenu`)
   *          re-shows the main menu so the user can try again. Guest
   *          play is never entered implicitly from this path.
   */
  private async handleCharacterSelection(
    httpBase: string,
    sessionToken: string,
    mode: "existing" | "create",
  ): Promise<boolean> {
    let characterReady = false;
    if (mode === "create") {
      characterReady = await this.handleCharacterCreation(httpBase, sessionToken);
    } else {
      const characters = await fetchCharacters(httpBase, sessionToken);

      if (characters.length > 0) {
        const sendLinks = this.capabilities.has("OSC_HYPERLINKS_SEND");
        this.writeLine("\r\nCharacters:");
        this.writeLine("");
        for (let i = 0; i < characters.length; i++) {
          const ch = characters[i];
          const text = `  [${i + 1}] ${ch.name} (${ch.characterClass})`;
          this.writeLine(
            sendLinks ? buildOsc8Hyperlink(`send:${i + 1}`, text, true) : text,
          );
        }
        const newCharText = "  [0] Create a new character";
        this.writeLine(
          sendLinks ? buildOsc8Hyperlink("send:0", newCharText, true) : newCharText,
        );
        this.writeLine("");

        const pick = await this.prompt("Character [1]: ");
        const idx = pick === "" ? 1 : parseInt(pick, 10);

        if (isNaN(idx)) {
          this.writeLine("Invalid choice.\r\n");
          return false;
        }

        if (idx > 0 && idx <= characters.length) {
          const selected = characters[idx - 1];
          const ok = await postSelectCharacter(httpBase, sessionToken, selected.id);
          if (!ok) {
            this.writeLine("Failed to select character.\r\n");
            return false;
          }
          this.writeLine(`Playing as ${selected.name}\r\n`);
          characterReady = true;
        } else if (idx === 0) {
          characterReady = await this.handleCharacterCreation(httpBase, sessionToken);
        } else {
          this.writeLine(
            `Choice out of range. Pick 0-${characters.length}.\r\n`,
          );
          return false;
        }
      } else {
        this.writeLine("\r\nNo characters found. Let's create one!\r\n");
        characterReady = await this.handleCharacterCreation(httpBase, sessionToken);
      }
    }

    if (!characterReady) {
      return false;
    }

    // Reconnect with auth ticket
    const ticket = await fetchWsTicket(httpBase, sessionToken);
    if (!ticket) {
      this.writeLine("Failed to get auth ticket.\r\n");
      return false;
    }
    this.wsTicket = ticket;
    this.reconnectWithAuth(ticket);
    return true;
  }

  private async handleCharacterCreation(httpBase: string, sessionToken: string): Promise<boolean> {
    const name = await this.prompt("Character name: ");
    if (!name) {
      // Empty name aborts character creation. Don't fall through to
      // guest — returning false bubbles up to runStartupMenu, which
      // re-shows the menu so the user can pick again (or explicitly
      // choose [3] guest).
      this.writeLine("Character name cannot be empty. Returning to the menu.\r\n");
      return false;
    }

    const sendLinks = this.capabilities.has("OSC_HYPERLINKS_SEND");
    this.writeLine("\r\nClass:");
    this.writeLine("");
    for (let i = 0; i < CHARACTER_CLASSES.length; i++) {
      const cls = CHARACTER_CLASSES[i];
      const label = `  [${i + 1}] ${cls.charAt(0).toUpperCase() + cls.slice(1)}`;
      this.writeLine(
        sendLinks ? buildOsc8Hyperlink(`send:${i + 1}`, label, true) : label,
      );
    }
    this.writeLine("");

    const classChoice = await this.prompt("Class [1]: ");
    const cidx = classChoice === "" ? 1 : parseInt(classChoice, 10);
    let characterClass: typeof CHARACTER_CLASSES[number];
    if (!isNaN(cidx) && cidx >= 1 && cidx <= CHARACTER_CLASSES.length) {
      characterClass = CHARACTER_CLASSES[cidx - 1];
    } else {
      characterClass = CHARACTER_CLASSES[0];
      this.writeLine(`Invalid choice \u2014 using ${characterClass}.\r\n`);
    }

    this.writeLine("Creating character...");
    const ok = await postCreateCharacter(httpBase, sessionToken, name, characterClass);
    if (ok) {
      this.writeLine(`Created ${name} the ${characterClass}!\r\n`);
      return true;
    }
    this.writeLine("Failed to create character.\r\n");
    return false;
  }

  // ─── Interactive prompt helper ───────────────────────────────────────

  private prompt(text: string, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // Handle a signal that was already aborted before we even got
      // here. Don't install a handler — the race architecture means the
      // caller treats a settled prompt-loser as cancelled regardless of
      // its resolved value.
      if (signal?.aborted) {
        resolve("");
        return;
      }
      this.writeRaw(text);
      this.promptReject = reject;
      const onAbort = () => {
        this.promptHandler = null;
        this.promptReject = null;
        resolve("");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.promptHandler = (line: string) => {
        this.promptHandler = null;
        this.promptReject = null;
        signal?.removeEventListener("abort", onAbort);
        resolve(line);
      };
    });
  }

  // ─── Game server connection ──────────────────────────────────────────

  private connectToGame(ticket?: string): void {
    if (this.disposed) return;

    // Clean up any existing connection
    this.conn?.dispose();

    this.conn = new MUDdownConnection(
      { wsUrl: this.config.gameServerUrl, autoReconnect: true },
      {
        onOpen: () => {
          // Connection established — no need to announce, the server
          // will send the room description
        },
        onMessage: (muddown: string, type: string) => {
          this.renderAndSend(muddown, type);
        },
        onHint: (hint) => {
          // Render hint as a system message
          let hintText = `\r\n[Hint] ${hint.hint}\r\n`;
          if (hint.commands.length > 0) {
            hintText += `  Try: ${hint.commands.join(", ")}\r\n`;
          }
          this.writeLine(hintText);
        },
        onInventory: () => {
          // Telnet clients use the 'inventory' command instead of UI panels
        },
        onClose: (willReconnect: boolean) => {
          if (!willReconnect && !this.disposed) {
            this.writeLine("\r\nDisconnected from game server.\r\n");
          }
        },
        onError: () => {
          if (!this.disposed) {
            this.writeLine("\r\nConnection error.\r\n");
          }
        },
        onReconnecting: async () => {
          if (this.sessionToken) {
            const httpBase = wsToHttpBase(this.config.gameServerUrl);
            const ticket = await fetchWsTicket(httpBase, this.sessionToken);
            if (!ticket) {
              console.error(`[bridge] session ${this.id}: failed to refresh WS ticket; reconnecting as guest`);
              if (!this.disposed) {
                this.writeLine("\r\n[Warning] Could not refresh authentication — reconnecting as guest.\r\n");
              }
            }
            return ticket;
          }
          return undefined;
        },
      },
    );

    this.conn.connect(ticket);
  }

  private reconnectWithAuth(ticket: string): void {
    this.connectToGame(ticket);
  }

  private sendToGame(command: string): void {
    if (!this.conn?.connected) {
      this.writeLine("\r\nNot connected to game server.\r\n");
      return;
    }
    this.conn.send(command);
  }

  // ─── Rendering ───────────────────────────────────────────────────────

  private renderAndSend(muddown: string, type: string): void {
    const mode = this.effectiveLinkMode;
    let text: string;
    let links: { index: number; command: string }[] = [];
    try {
      const osc8Features = mode === "osc8-send"
        ? {
            tooltip: this.capabilities.has("OSC_HYPERLINKS_TOOLTIP"),
            menu: this.capabilities.has("OSC_HYPERLINKS_MENU"),
          }
        : undefined;
      const opts = { cols: this.cols, linkMode: mode, ansi: this.ansi, colorLevel: this.colorLevel, osc8Features };
      const rendered = renderTerminal(muddown, opts);
      text = rendered.text;
      links = rendered.links;
    } catch (err) {
      console.error(`[bridge] [${this.id}] renderTerminal failed (mode=${mode}, type=${type}):`, err);
      // The renderer threw.  Showing the raw MUDdown source (container
      // fences, Markdown link syntax, etc.) on a plain terminal looks
      // worse than a clean error message, so surface a one-line notice
      // instead and drop the links for this message.
      text = "[A message could not be displayed due to a rendering error.]";
      links = [];
    }

    // Room messages always replace the link table (an empty array clears
    // stale links from a previous room).  Non-room messages (system,
    // narrative, combat, dialogue) only update when they carry links —
    // a follow-up notification shouldn't wipe the current room's links.
    if (type === "room" || links.length > 0) {
      this.activeLinks = links;
    }

    // Convert \n to \r\n for telnet
    const telnetText = text.replace(/(?<!\r)\n/g, "\r\n");
    this.writeLine("\r\n" + telnetText);

    // Show link legend if in numbered mode and there are links
    if (mode === "numbered" && links.length > 0) {
      this.writeLine("");
      for (const link of links) {
        this.writeLine(`  [${link.index}] ${link.command}`);
      }
    }
  }

  // ─── Socket I/O ──────────────────────────────────────────────────────

  private write(data: Buffer): void {
    if (!this.disposed && this.socket.writable) {
      this.socket.write(data, (err) => {
        if (err) {
          console.error(`[bridge] [${this.id}] write error:`, err);
          this.dispose();
        }
      });
    }
  }

  private writeRaw(text: string): void {
    if (!this.disposed && this.socket.writable) {
      this.socket.write(text, (err) => {
        if (err) {
          console.error(`[bridge] [${this.id}] writeRaw error:`, err);
          this.dispose();
        }
      });
    }
  }

  private writeLine(text: string): void {
    // Ensure telnet line endings
    const formatted = text.endsWith("\r\n") ? text : text + "\r\n";
    this.writeRaw(formatted);
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    clearTimeout(this.negotiationTimer);
    clearInterval(this.keepaliveTimer);

    // Cancel any in-flight login poll so dispose() doesn't leak
    // background HTTP requests for the rest of the 2-minute poll window.
    this.loginAbort?.abort();
    this.loginAbort = null;

    // Best-effort drop of the server-side login state (if any). No-op
    // unless the session disposed mid-login with a live nonce that
    // hadn't been consumed; safe to call unconditionally.
    this.cancelCurrentLoginNonce();

    // Reject any pending prompt so the async chain doesn't hang forever
    if (this.promptHandler) {
      this.promptHandler = null;
    }
    if (this.promptReject) {
      this.promptReject(new SessionDisposedError());
      this.promptReject = null;
    }

    this.conn?.dispose();
    this.conn = null;

    if (this.socket.writable) {
      this.socket.end();
    }
    this.socket.destroy();
  }
}

// ─── Bridge Server ───────────────────────────────────────────────────────────

export class BridgeServer {
  private config: BridgeConfig;
  private sessions = new Set<TelnetSession>();
  private tlsServer: ReturnType<typeof createTlsServer> | null = null;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  start(): void {
    if (!this.config.tlsCert || !this.config.tlsKey) {
      throw new Error("TELNET_TLS_CERT and TELNET_TLS_KEY are required.");
    }

    const tlsOptions = {
      cert: readFileSync(this.config.tlsCert),
      key: readFileSync(this.config.tlsKey),
    };
    this.tlsServer = createTlsServer(tlsOptions, (socket) => this.handleConnection(socket));
    this.tlsServer.on("error", (err) => {
      console.error("[bridge] TLS server error:", err);
    });
    this.tlsServer.listen(this.config.port, () => {
      console.log(`TELNETS bridge listening on port ${this.config.port}`);
    });
  }

  private handleConnection(socket: Socket | TLSSocket): void {
    const addr = socket.remoteAddress ?? "unknown";
    console.log(`New telnet connection from ${addr}`);

    const session = new TelnetSession(socket, this.config);
    this.sessions.add(session);

    socket.on("close", () => {
      this.sessions.delete(session);
      console.log(`Telnet connection closed from ${addr}`);
    });
  }

  /** Number of active sessions. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Shut down the bridge and all sessions. Returns when the TLS server is closed. */
  shutdown(): Promise<void> {
    for (const session of this.sessions) {
      session.dispose();
    }
    this.sessions.clear();
    return new Promise<void>((resolve) => {
      if (this.tlsServer) {
        this.tlsServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function main(): void {
  const config = loadConfig();

  console.log("MUDdown Telnet Bridge (TLS)");
  console.log(`  Game server: ${config.gameServerUrl}`);
  if (config.publicBaseUrl) {
    console.log(`  Public URL:  ${config.publicBaseUrl}`);
  }
  console.log(`  Port:        ${config.port}`);

  const bridge = new BridgeServer(config);
  bridge.start();

  // Resolve HOSTNAME to an IPv4 for MSSP `IP`. Fire-and-forget; if the lookup
  // takes a moment to complete, the first MSSP response may omit the IP key
  // and later ones will include it.
  resolveMsspIp(config.mssp.hostname);

  // Graceful shutdown — use process.once to avoid duplicate handlers
  const shutdown = (): void => {
    console.log("Shutting down bridge...");
    bridge.shutdown().then(() => process.exit(0));
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
