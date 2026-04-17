#!/usr/bin/env node
/**
 * MUDdown Telnet Bridge
 *
 * A bridge-as-proxy that accepts incoming telnet connections and forwards
 * them to a MUDdown game server over WebSocket.  Each telnet client gets
 * its own WebSocket session.
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
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

import WebSocket from "ws";
import {
  MUDdownConnection,
  buildWsUrl,
  renderTerminal,
  CommandHistory,
} from "@muddown/client";
import type { LinkMode, NumberedLink } from "@muddown/client";
import { CHARACTER_CLASSES } from "@muddown/shared";

import {
  TelnetParser,
  iacDo,
  iacWill,
  iacWont,
  iacNop,
  requestTtype,
  parseNaws,
  parseTtype,
  supportsAnsi,
  OPT_ECHO,
  OPT_SGA,
  OPT_TTYPE,
  OPT_NAWS,
} from "./telnet.js";

import {
  loadConfig,
  getBanner,
  wsToHttpBase,
} from "./helpers.js";
import type { BridgeConfig } from "./helpers.js";

// @ts-expect-error — MUDdownConnection expects browser WebSocket global
globalThis.WebSocket = WebSocket;

// ─── HTTP helpers (reused from terminal client pattern) ──────────────────────

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
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

async function pollForToken(httpBase: string, nonce: string, maxAttempts: number, intervalMs: number): Promise<string | undefined> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    try {
      const res = await fetchWithTimeout(
        `${httpBase}/auth/token-poll?nonce=${encodeURIComponent(nonce)}`,
      );
      if (res.status === 200) {
        const data = await res.json() as { token?: string };
        return data.token;
      }
      if (res.status !== 202) return undefined;
    } catch (err: unknown) {
      // AbortError = our timeout fired
      if (err instanceof DOMException && err.name === "AbortError") {
        continue;
      }
      // SyntaxError = malformed JSON from res.json() — treat as transient
      if (err instanceof SyntaxError) {
        continue;
      }
      // TypeError with fetch-related message = network failure
      if (err instanceof TypeError && /fetch/i.test(err.message)) {
        continue;
      }
      console.error("[bridge] pollForToken unexpected error:", err);
      return undefined;
    }
  }
  console.warn("[bridge] pollForToken exhausted all", maxAttempts, "attempts");
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
  private terminalType: string | undefined;
  private ansi = false;
  private negotiationDone = false;
  private negotiationTimer: ReturnType<typeof setTimeout> | undefined;

  // Link mode
  private linkMode: LinkMode = "plain";

  // Auth state
  private sessionToken: string | undefined;
  private wsTicket: string | undefined;

  // Input buffer (line-buffered)
  private inputBuffer = "";
  private echoSuppressed = false;
  private lastWasCR = false;

  // Interactive prompt state for multi-step flows (login, character creation)
  private promptHandler: ((line: string) => void) | null = null;
  private promptReject: ((err: Error) => void) | null = null;

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
    this.socket.on("error", (err) => {
      console.error(`[bridge] [${this.id}] socket error:`, err);
      this.dispose();
    });

    // Start telnet negotiation
    this.negotiate();
  }

  // ─── Telnet Negotiation ──────────────────────────────────────────────

  private negotiate(): void {
    // Request NAWS, TTYPE, and offer ECHO + SGA
    this.write(iacDo(OPT_NAWS));
    this.write(iacDo(OPT_TTYPE));
    this.write(iacWill(OPT_ECHO));
    this.write(iacWill(OPT_SGA));

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

    // Determine ANSI from terminal type
    this.ansi = supportsAnsi(this.terminalType);

    // Send banner
    this.writeLine(getBanner(this.config.serverName));

    // Start keepalive
    this.keepaliveTimer = setInterval(() => {
      if (!this.disposed) this.write(iacNop());
    }, this.config.keepaliveMs);

    // Connect to game server as guest initially
    this.connectToGame();
  }

  // ─── Data handling ───────────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    const events = this.parser.feed(chunk);

    for (const event of events) {
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
      default:
        // Reject unknown options
        this.write(iacWont(option));
        break;
    }
  }

  private handleWont(option: number): void {
    // Client refuses an option — that's fine, we use defaults
    if (option === OPT_TTYPE) {
      // No TTYPE — finish negotiation if NAWS already came or timed out
      if (!this.negotiationDone) this.finishNegotiation();
    }
  }

  private handleDo(option: number): void {
    switch (option) {
      case OPT_ECHO:
      case OPT_SGA:
        // Client agrees to let us handle echo / suppress go-ahead
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
        if (ttype) {
          this.terminalType = ttype;
          this.ansi = supportsAnsi(ttype);
        }
        // TTYPE is often the last negotiation step
        if (!this.negotiationDone) this.finishNegotiation();
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
          if (!this.echoSuppressed) {
            // Erase character: backspace, space, backspace
            this.write(Buffer.from([0x08, 0x20, 0x08]));
          }
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

        if (!this.echoSuppressed) {
          this.write(Buffer.from("\r\n"));
        }

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
        if (!this.echoSuppressed) {
          this.write(Buffer.from([byte]));
        }
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

    if (lower === "linkmode") {
      this.linkMode = this.linkMode === "plain" ? "numbered" : "plain";
      this.writeLine(`\r\nLink mode: ${this.linkMode}\r\n`);
      return;
    }

    if (lower === "login") {
      this.handleLogin().catch((err) => {
        console.error(`[bridge] [${this.id}] login error:`, err);
        this.writeLine("\r\nLogin failed unexpectedly.\r\n");
        this.promptHandler = null;
        this.promptReject = null;
      });
      return;
    }

    if (lower === "legend" && this.linkMode === "numbered" && this.activeLinks.length > 0) {
      this.writeLine("");
      for (const link of this.activeLinks) {
        this.writeLine(`  [${link.index}] ${link.command}`);
      }
      this.writeLine("");
      return;
    }

    // Numbered link shortcut
    if (this.linkMode === "numbered" && /^\d+$/.test(trimmed)) {
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

  private async handleLogin(): Promise<void> {
    const httpBase = wsToHttpBase(this.config.gameServerUrl);
    const providers = await fetchProviders(httpBase);

    if (providers.length === 0) {
      this.writeLine("\r\nNo login providers available on this server.\r\n");
      return;
    }

    let provider = "github";
    if (providers.length === 1) {
      provider = providers[0];
    } else {
      // Show provider picker
      this.writeLine("\r\nLogin Provider:");
      for (let i = 0; i < providers.length; i++) {
        this.writeLine(`  [${i + 1}] ${providers[i]}`);
      }

      const choice = await this.prompt(`\r\nProvider [1]: `);
      const idx = choice === "" ? 1 : parseInt(choice, 10);
      if (isNaN(idx) || idx < 1 || idx > providers.length) {
        this.writeLine("Invalid choice, using first provider.\r\n");
        provider = providers[0];
      } else {
        provider = providers[idx - 1];
      }
    }

    const nonce = randomUUID();
    const loginUrl = `${httpBase}/auth/login?provider=${encodeURIComponent(provider)}&login_nonce=${encodeURIComponent(nonce)}`;

    this.writeLine("\r\nOpen this URL in your browser to log in:\r\n");
    this.writeLine(`  ${loginUrl}\r\n`);
    this.writeLine("Waiting for login (up to 2 minutes)...");

    const sessionToken = await pollForToken(httpBase, nonce, 60, 2000);
    if (!sessionToken) {
      this.writeLine("\r\nLogin timed out.\r\n");
      return;
    }

    this.sessionToken = sessionToken;
    this.writeLine("\r\nLogged in! Selecting character...\r\n");

    await this.handleCharacterSelection(httpBase, sessionToken);
  }

  private async handleCharacterSelection(httpBase: string, sessionToken: string): Promise<void> {
    const characters = await fetchCharacters(httpBase, sessionToken);

    if (characters.length > 0) {
      this.writeLine("\r\nCharacters:");
      for (let i = 0; i < characters.length; i++) {
        const ch = characters[i];
        this.writeLine(`  [${i + 1}] ${ch.name} (${ch.characterClass})`);
      }
      this.writeLine("  [0] Create a new character\r\n");

      const pick = await this.prompt("Character [1]: ");
      const idx = pick === "" ? 1 : parseInt(pick, 10);

      if (isNaN(idx)) {
        this.writeLine("Invalid choice.\r\n");
        return;
      }

      if (idx > 0 && idx <= characters.length) {
        const selected = characters[idx - 1];
        const ok = await postSelectCharacter(httpBase, sessionToken, selected.id);
        if (!ok) {
          this.writeLine("Failed to select character.\r\n");
          return;
        }
        this.writeLine(`Playing as ${selected.name}\r\n`);
      } else {
        await this.handleCharacterCreation(httpBase, sessionToken);
      }
    } else {
      this.writeLine("\r\nNo characters found. Let's create one!\r\n");
      await this.handleCharacterCreation(httpBase, sessionToken);
    }

    // Reconnect with auth ticket
    const ticket = await fetchWsTicket(httpBase, sessionToken);
    if (ticket) {
      this.wsTicket = ticket;
      this.reconnectWithAuth(ticket);
    } else {
      this.writeLine("Failed to get auth ticket. Continuing as guest.\r\n");
    }
  }

  private async handleCharacterCreation(httpBase: string, sessionToken: string): Promise<void> {
    const name = await this.prompt("Character name: ");
    if (!name) {
      this.writeLine("Name cannot be empty.\r\n");
      return;
    }

    this.writeLine("\r\nClass:");
    for (let i = 0; i < CHARACTER_CLASSES.length; i++) {
      const cls = CHARACTER_CLASSES[i];
      this.writeLine(`  [${i + 1}] ${cls.charAt(0).toUpperCase() + cls.slice(1)}`);
    }

    const classChoice = await this.prompt("\r\nClass [1]: ");
    const cidx = classChoice === "" ? 1 : parseInt(classChoice, 10);
    const characterClass = (!isNaN(cidx) && cidx >= 1 && cidx <= CHARACTER_CLASSES.length)
      ? CHARACTER_CLASSES[cidx - 1]
      : CHARACTER_CLASSES[0];

    this.writeLine("Creating character...");
    const ok = await postCreateCharacter(httpBase, sessionToken, name, characterClass);
    if (ok) {
      this.writeLine(`Created ${name} the ${characterClass}!\r\n`);
    } else {
      this.writeLine("Failed to create character.\r\n");
    }
  }

  // ─── Interactive prompt helper ───────────────────────────────────────

  private prompt(text: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.writeRaw(text);
      this.promptReject = reject;
      this.promptHandler = (line: string) => {
        this.promptHandler = null;
        this.promptReject = null;
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
        onMessage: (muddown: string) => {
          this.renderAndSend(muddown);
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
              this.writeLine("\r\n[Warning] Could not refresh auth ticket. Reconnecting as guest.\r\n");
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

  private renderAndSend(muddown: string): void {
    const opts = { cols: this.cols, linkMode: this.linkMode, ansi: this.ansi };
    const { text, links } = renderTerminal(muddown, opts);

    this.activeLinks = links;

    // Convert \n to \r\n for telnet
    const telnetText = text.replace(/(?<!\r)\n/g, "\r\n");
    this.writeLine("\r\n" + telnetText);

    // Show link legend if in numbered mode and there are links
    if (this.linkMode === "numbered" && links.length > 0) {
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

    // Reject any pending prompt so the async chain doesn't hang forever
    if (this.promptHandler) {
      this.promptHandler = null;
    }
    if (this.promptReject) {
      this.promptReject(new Error("session disposed"));
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
      console.error("[bridge] TELNET_TLS_CERT and TELNET_TLS_KEY are required.");
      process.exit(1);
    }

    try {
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
    } catch (err) {
      console.error("[bridge] Failed to start TLS server:", err);
      process.exit(1);
    }
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

  /** Shut down the bridge and all sessions. */
  shutdown(): void {
    for (const session of this.sessions) {
      session.dispose();
    }
    this.sessions.clear();
    this.tlsServer?.close();
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function main(): void {
  const config = loadConfig();

  console.log("MUDdown Telnet Bridge (TLS)");
  console.log(`  Game server: ${config.gameServerUrl}`);
  console.log(`  Port:        ${config.port}`);

  const bridge = new BridgeServer(config);
  bridge.start();

  // Graceful shutdown — use process.once to avoid duplicate handlers
  const shutdown = (): void => {
    console.log("Shutting down bridge...");
    bridge.shutdown();
    process.exit(0);
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
