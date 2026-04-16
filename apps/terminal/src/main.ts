#!/usr/bin/env node
/**
 * MUDdown Terminal Client
 *
 * Play MUDdown games from your terminal with styled ANSI output,
 * OSC 8 hyperlinks, and readline command history.
 */

import { createInterface } from "node:readline";
import { argv, stdout, stdin, exit, platform } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import chalk from "chalk";
import WebSocket from "ws";
import {
  MUDdownConnection,
  buildWsUrl,
  CommandHistory,
  renderTerminal,
} from "@muddown/client";
import type {
  LinkMode,
  NumberedLink,
  InvState,
  ParsedHint,
} from "@muddown/client";
import { CHARACTER_CLASSES } from "@muddown/shared";

// ─── WebSocket polyfill for Node.js ──────────────────────────────────────────

// @ts-expect-error — MUDdownConnection expects browser WebSocket global
globalThis.WebSocket = WebSocket;

// ─── CLI argument parsing ────────────────────────────────────────────────────

interface CliOptions {
  server: string;
  serverFromFlag: boolean;
  linkMode: LinkMode;
  token?: string;
  sessionToken?: string; // long-lived session token for reconnect
  cols: number;
  ansi: boolean;
}

const VALID_LINK_MODES: readonly LinkMode[] = ["osc8", "numbered", "plain"];

function parseArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    server: "wss://muddown.com/ws",
    serverFromFlag: false,
    linkMode: "osc8",
    cols: stdout.columns || 80,
    ansi: true,
  };

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--server": {
        const val = args[i + 1];
        if (!val || val.startsWith("--")) {
          console.error("Error: --server requires a URL argument");
          exit(1);
        }
        i++;
        opts.server = val;
        opts.serverFromFlag = true;
        break;
      }
      case "--link-mode": {
        const val = args[i + 1];
        if (!val || val.startsWith("--")) {
          console.error("Error: --link-mode requires a value (osc8, numbered, plain)");
          exit(1);
        }
        i++;
        if (!VALID_LINK_MODES.includes(val as LinkMode)) {
          console.error(`Error: invalid link mode "${val}" (expected: osc8, numbered, plain)`);
          exit(1);
        }
        opts.linkMode = val as LinkMode;
        break;
      }
      case "--token": {
        const val = args[i + 1];
        if (!val || val.startsWith("--")) {
          console.error("Error: --token requires a value");
          exit(1);
        }
        i++;
        opts.token = val;
        break;
      }
      case "--theme": {
        const val = args[i + 1];
        if (!val || val.startsWith("--")) {
          console.error("Error: --theme requires a value");
          exit(1);
        }
        // Reserved for future custom theme support; currently ignored.
        i++;
        break;
      }
      case "--no-color":
        opts.ansi = false;
        break;
      case "--help":
      case "-h":
        printHelp();
        exit(0);
        break;
      case "--version":
      case "-v":
        console.log("muddown 0.1.0");
        exit(0);
        break;
      default:
        if (arg.startsWith("--")) {
          console.error(`Unknown option: ${arg}`);
          printHelp();
          exit(1);
        }
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`
${chalk.bold("muddown")} — MUDdown Terminal Client

${chalk.bold("USAGE")}
  muddown [options]

${chalk.bold("OPTIONS")}
  --server <url>       WebSocket server URL (skips game picker)
  --link-mode <mode>   Link rendering: osc8, numbered, plain (default: osc8)
  --token <token>      Authentication token (skips login wizard)
  --theme <name>       Color theme (default: dark, or: plain) [future]
  --no-color           Disable ANSI color output
  -h, --help           Show this help message
  -v, --version        Show version

${chalk.bold("LINK MODES")}
  osc8       Terminal hyperlinks (iTerm2, Windows Terminal, etc.)
  numbered   Numbered shortcuts — type the number to activate
  plain      Show command in parentheses: Text (command)

${chalk.bold("EXAMPLES")}
  muddown                                   Interactive wizard
  muddown --server ws://localhost:3300/ws    Direct connect
  muddown --link-mode numbered --no-color   Accessible mode
`);
}

// ─── Games directory ─────────────────────────────────────────────────────────

interface GameEntry {
  name: string;
  description: string;
  hostname: string;
  port: number | null;
  protocol: string;
  certification: string;
  websiteUrl?: string | null;
}

const CERT_LABEL: Record<string, string> = {
  verified: "✓ Verified",
  "self-certified": "Self-Certified",
  listed: "Listed",
};

async function fetchGames(ansi: boolean): Promise<GameEntry[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch("https://muddown.com/api/games", { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json() as { servers?: GameEntry[] };
    return (data.servers ?? []).filter(s => s.protocol === "websocket");
  } catch {
    if (ansi) {
      process.stdout.write(chalk.dim("  (Could not reach muddown.com/api/games)\n"));
    } else {
      process.stdout.write("  (Could not reach muddown.com/api/games)\n");
    }
    return [];
  }
}

function gameWsUrl(g: GameEntry): string {
  const h = g.hostname;
  const isLocal =
    h === "localhost" ||
    h.startsWith("127.") ||
    h === "::1" ||
    h === "[::1]" ||
    h === "0.0.0.0";
  const scheme = isLocal ? "ws" : "wss";
  const base = g.port ? `${scheme}://${g.hostname}:${g.port}` : `${scheme}://${g.hostname}`;
  return `${base}/ws`;
}

// ─── Startup wizard ───────────────────────────────────────────────────────────

async function runStartupWizard(opts: CliOptions): Promise<void> {
  const c = opts.ansi;

  process.stdout.write(
    c
      ? chalk.bold.green("\nMUDdown Terminal Client") + chalk.dim(" v0.1.0\n\n")
      : "\nMUDdown Terminal Client v0.1.0\n\n",
  );

  // ── Fetch games directory ────────────────────────────────────────────────
  process.stdout.write(c ? chalk.dim("Fetching games directory…\n") : "Fetching games directory…\n");
  const games = await fetchGames(opts.ansi);

  const rl = createInterface({ input: stdin, output: stdout, terminal: true });

  const question = (prompt: string): Promise<string> =>
    new Promise(resolve => rl.question(prompt, resolve));

  // ── Game picker ──────────────────────────────────────────────────────────
  if (games.length === 0) {
    process.stdout.write(
      c
        ? chalk.yellow("No WebSocket games found in directory. Defaulting to muddown.com.\n\n")
        : "No WebSocket games found in directory. Defaulting to muddown.com.\n\n",
    );
  } else {
    process.stdout.write(c ? chalk.bold("Available Games:\n") : "Available Games:\n");
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      const num = c ? chalk.cyan(`  [${i + 1}]`) : `  [${i + 1}]`;
      const name = c ? chalk.bold.white(g.name) : g.name;
      const cert = CERT_LABEL[g.certification] ?? g.certification;
      const certStr = c ? chalk.dim(` (${cert})`) : ` (${cert})`;
      const desc = g.description ? (c ? chalk.dim(`\n        ${g.description}`) : `\n        ${g.description}`) : "";
      const url = c ? chalk.dim(`\n        ${gameWsUrl(g)}`) : `\n        ${gameWsUrl(g)}`;
      process.stdout.write(`${num} ${name}${certStr}${desc}${url}\n`);
    }
    process.stdout.write(
      c
        ? chalk.dim(`\n  [0] Enter a custom WebSocket URL\n\n`)
        : `\n  [0] Enter a custom WebSocket URL\n\n`,
    );

    const defaultLabel = c ? chalk.dim("[1]") : "[1]";
    const choiceRaw = await question(
      c
        ? chalk.green("Pick a game") + chalk.dim(` ${defaultLabel}: `)
        : `Pick a game ${defaultLabel}: `,
    );
    const choice = choiceRaw.trim();

    if (choice === "0") {
      const urlRaw = await question(
        c ? chalk.green("WebSocket URL") + chalk.dim(" [wss://muddown.com/ws]: ") : "WebSocket URL [wss://muddown.com/ws]: ",
      );
      opts.server = urlRaw.trim() || "wss://muddown.com/ws";
    } else {
      const idx = choice === "" ? 1 : parseInt(choice, 10);
      const selected = games[idx - 1];
      if (selected) {
        opts.server = gameWsUrl(selected);
        process.stdout.write(
          c
            ? chalk.dim(`\nSelected: ${chalk.white(selected.name)} → ${opts.server}\n`)
            : `\nSelected: ${selected.name} → ${opts.server}\n`,
        );
      } else {
        process.stdout.write(
          c ? chalk.yellow("Invalid choice, using muddown.com.\n") : "Invalid choice, using muddown.com.\n",
        );
      }
    }
  }

  // ── Auth: browser-based login ──────────────────────────────────────────
  if (!opts.token) {
    process.stdout.write("\n");
    process.stdout.write(c ? chalk.bold("Login:\n") : "Login:\n");
    process.stdout.write(
      c
        ? chalk.dim("  [1] Log in via browser (opens your default browser)\n")
        : "  [1] Log in via browser (opens your default browser)\n",
    );
    process.stdout.write(
      c
        ? chalk.dim("  [2] Play as guest\n\n")
        : "  [2] Play as guest\n\n",
    );

    const authChoice = await question(
      c
        ? chalk.green("Choice") + chalk.dim(" [1]: ")
        : "Choice [1]: ",
    );

    if (authChoice.trim() !== "2") {
      // Determine the HTTP base URL from the WS server URL
      const httpBase = wsToHttpBase(opts.server);

      // Fetch available providers
      const providers = await fetchProviders(httpBase);
      let provider = "github";

      if (providers === null) {
        process.stdout.write(
          c
            ? chalk.red(`Could not reach server at ${httpBase}. Check the server URL.\n`)
            : `Could not reach server at ${httpBase}. Check the server URL.\n`,
        );
      } else if (providers.length === 0) {
        process.stdout.write(
          c
            ? chalk.yellow("No login providers available on this server. Playing as guest.\n")
            : "No login providers available on this server. Playing as guest.\n",
        );
      } else if (providers.length === 1) {
        provider = providers[0];
      } else {
        process.stdout.write(
          c ? chalk.bold("\nLogin Provider:\n") : "\nLogin Provider:\n",
        );
        for (let i = 0; i < providers.length; i++) {
          const label = c ? chalk.cyan(`  [${i + 1}]`) : `  [${i + 1}]`;
          process.stdout.write(`${label} ${providers[i]}\n`);
        }
        const providerChoice = await question(
          c
            ? chalk.green("\nProvider") + chalk.dim(" [1]: ")
            : "\nProvider [1]: ",
        );
        const pidx = providerChoice.trim() === "" ? 1 : parseInt(providerChoice.trim(), 10);
        provider = providers[pidx - 1] ?? providers[0];
      }

      if (providers !== null && providers.length > 0) {
        const sessionToken = await browserLogin(httpBase, provider, opts);
        if (sessionToken) {
          opts.sessionToken = sessionToken;

          // Character selection / creation
          const ticket = await selectCharacter(httpBase, sessionToken, question, opts.ansi);
          if (ticket) {
            opts.token = ticket;
          } else {
            process.stdout.write(
              c
                ? chalk.yellow("Character selection failed. Playing as guest.\n")
                : "Character selection failed. Playing as guest.\n",
            );
          }
        } else {
          process.stdout.write(
            c
              ? chalk.yellow("Login timed out. Playing as guest.\n")
              : "Login timed out. Playing as guest.\n",
          );
        }
      }
    }
  }

  rl.close();
  process.stdout.write("\n");
}

// ─── Browser login helpers ───────────────────────────────────────────────────

function wsToHttpBase(wsUrl: string): string {
  if (wsUrl.startsWith("wss://")) return "https://" + wsUrl.slice(6).replace(/\/ws$/, "");
  if (wsUrl.startsWith("ws://")) return "http://" + wsUrl.slice(5).replace(/\/ws$/, "");
  return wsUrl;
}

async function fetchProviders(httpBase: string): Promise<string[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${httpBase}/auth/providers`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json() as { providers?: string[] };
    return data.providers ?? [];
  } catch {
    return null;
  }
}

function openBrowser(url: string, ansi: boolean): void {
  const onError = (err: Error | null): void => {
    if (!err) return;
    process.stdout.write(
      ansi
        ? chalk.yellow("Could not open browser automatically. Please visit:\n  ") + chalk.cyan(url) + "\n"
        : `Could not open browser automatically. Please visit:\n  ${url}\n`,
    );
  };
  if (platform === "darwin") {
    execFile("open", [url], (err) => onError(err));
  } else if (platform === "win32") {
    const proc = spawn("cmd.exe", ["/c", "start", "", url], { stdio: "ignore" });
    proc.on("error", onError);
  } else {
    execFile("xdg-open", [url], (err) => onError(err));
  }
}

async function browserLogin(httpBase: string, provider: string, opts: CliOptions): Promise<string | undefined> {
  const ansi = opts.ansi;
  const nonce = randomUUID();
  const loginUrl = `${httpBase}/auth/login?provider=${encodeURIComponent(provider)}&login_nonce=${encodeURIComponent(nonce)}`;

  const c = ansi;
  process.stdout.write(
    c
      ? chalk.dim("\nOpening browser for login…\n")
      : "\nOpening browser for login…\n",
  );
  process.stdout.write(
    c
      ? chalk.dim("If the browser doesn't open, visit:\n  ") + chalk.cyan(loginUrl) + "\n\n"
      : `If the browser doesn't open, visit:\n  ${loginUrl}\n\n`,
  );

  openBrowser(loginUrl, opts.ansi);

  process.stdout.write(
    c
      ? chalk.dim("Waiting for login (up to 2 minutes)…")
      : "Waiting for login (up to 2 minutes)…",
  );

  // Poll for the session token (max ~2 minutes, every 2 seconds)
  const sessionToken = await pollForToken(httpBase, nonce, 60, 2000);
  if (!sessionToken) {
    process.stdout.write("\n");
    return undefined;
  }

  process.stdout.write(
    c ? chalk.green(" logged in!\n") : " logged in!\n",
  );

  // Return the session token — character selection + ws-ticket exchange happen later
  return sessionToken;
}

async function pollForToken(httpBase: string, nonce: string, maxAttempts: number, intervalMs: number): Promise<string | undefined> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${httpBase}/auth/token-poll?nonce=${encodeURIComponent(nonce)}`, {
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 200) {
        const data = await res.json() as { token?: string };
        return data.token;
      }
      // 202 = still pending, keep polling
      // anything else = stop
      if (res.status !== 202) return undefined;
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : "";
      if (
        (err instanceof TypeError && String(err.message).toLowerCase().includes("fetch")) ||
        name === "AbortError"
      ) {
        // Genuine network error or request timeout — keep polling
        continue;
      }
      // Unexpected error — abort and surface it
      console.error("pollForToken: unexpected error:", err);
      return undefined;
    }
  }
  return undefined;
}

async function fetchWsTicket(httpBase: string, sessionToken: string): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${httpBase}/auth/ws-ticket`, {
      headers: { Authorization: `Bearer ${sessionToken}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const data = await res.json() as { ticket?: string };
    return data.ticket;
  } catch (err: unknown) {
    console.error("fetchWsTicket failed:", err);
    return undefined;
  }
}

// ─── Character selection / creation ──────────────────────────────────────────

interface CharacterEntry {
  id: string;
  name: string;
  characterClass: string;
}

async function fetchCharacters(httpBase: string, token: string): Promise<CharacterEntry[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${httpBase}/auth/characters`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = await res.json() as { characters?: CharacterEntry[] };
    return data.characters ?? [];
  } catch (err: unknown) {
    console.error("fetchCharacters failed:", err);
    return [];
  }
}

async function postSelectCharacter(httpBase: string, token: string, characterId: string): Promise<boolean | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${httpBase}/auth/select-character`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ characterId }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch (err: unknown) {
    console.error("postSelectCharacter failed:", err);
    return null;
  }
}

async function postCreateCharacter(
  httpBase: string,
  token: string,
  name: string,
  characterClass: string,
): Promise<boolean | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${httpBase}/auth/create-character`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, characterClass }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch (err: unknown) {
    console.error("postCreateCharacter failed:", err);
    return null;
  }
}

/**
 * Prompt the user to select an existing character or create a new one,
 * then exchange the session token for a ws-ticket. Returns the ticket
 * or undefined on failure.
 */
async function selectCharacter(
  httpBase: string,
  sessionToken: string,
  question: (prompt: string) => Promise<string>,
  ansi: boolean,
): Promise<string | undefined> {
  const c = ansi;
  const characters = await fetchCharacters(httpBase, sessionToken);

  if (characters.length > 0) {
    process.stdout.write(c ? chalk.bold("\nCharacters:\n") : "\nCharacters:\n");
    for (let i = 0; i < characters.length; i++) {
      const ch = characters[i];
      const num = c ? chalk.cyan(`  [${i + 1}]`) : `  [${i + 1}]`;
      const cls = c ? chalk.dim(` (${ch.characterClass})`) : ` (${ch.characterClass})`;
      process.stdout.write(`${num} ${ch.name}${cls}\n`);
    }
    process.stdout.write(
      c
        ? chalk.dim(`  [0] Create a new character\n\n`)
        : `  [0] Create a new character\n\n`,
    );

    const defaultLabel = c ? chalk.dim("[1]") : "[1]";
    const pick = await question(
      c
        ? chalk.green("Character") + ` ${defaultLabel}: `
        : `Character ${defaultLabel}: `,
    );
    const idx = pick.trim() === "" ? 1 : parseInt(pick.trim(), 10);

    if (idx > 0 && idx <= characters.length) {
      const selected = characters[idx - 1];
      const ok = await postSelectCharacter(httpBase, sessionToken, selected.id);
      if (ok === null) {
        process.stdout.write(
          c
            ? chalk.red("Network error selecting character. Playing as guest.\n")
            : "Network error selecting character. Playing as guest.\n",
        );
        return undefined;
      }
      if (ok) {
        process.stdout.write(
          c
            ? chalk.dim(`Playing as `) + chalk.bold.white(selected.name) + "\n"
            : `Playing as ${selected.name}\n`,
        );
      } else {
        return undefined;
      }
    } else {
      // Create new character
      const created = await createCharacterPrompt(httpBase, sessionToken, question, ansi);
      if (!created) return undefined;
    }
  } else {
    // No characters — must create one
    process.stdout.write(
      c
        ? chalk.dim("\nNo characters found. Let's create one!\n")
        : "\nNo characters found. Let's create one!\n",
    );
    const created = await createCharacterPrompt(httpBase, sessionToken, question, ansi);
    if (!created) return undefined;
  }

  // Exchange for ws-ticket now that a character is selected
  return fetchWsTicket(httpBase, sessionToken);
}

async function createCharacterPrompt(
  httpBase: string,
  sessionToken: string,
  question: (prompt: string) => Promise<string>,
  ansi: boolean,
): Promise<boolean | null> {
  const c = ansi;

  const name = await question(
    c ? chalk.green("\nCharacter name") + ": " : "\nCharacter name: ",
  );
  if (!name.trim()) {
    process.stdout.write(
      c ? chalk.yellow("Name cannot be empty.\n") : "Name cannot be empty.\n",
    );
    return false;
  }

  process.stdout.write(c ? chalk.bold("\nClass:\n") : "\nClass:\n");
  for (let i = 0; i < CHARACTER_CLASSES.length; i++) {
    const cls = CHARACTER_CLASSES[i];
    const label = c ? chalk.cyan(`  [${i + 1}]`) : `  [${i + 1}]`;
    process.stdout.write(`${label} ${cls.charAt(0).toUpperCase() + cls.slice(1)}\n`);
  }

  const classChoice = await question(
    c
      ? chalk.green("\nClass") + chalk.dim(" [1]: ")
      : "\nClass [1]: ",
  );
  const cidx = classChoice.trim() === "" ? 1 : parseInt(classChoice.trim(), 10);
  const characterClass = CHARACTER_CLASSES[cidx - 1] ?? CHARACTER_CLASSES[0];

  process.stdout.write(
    c
      ? chalk.dim("Creating character…")
      : "Creating character…",
  );

  const ok = await postCreateCharacter(httpBase, sessionToken, name.trim(), characterClass);
  if (ok === null) {
    process.stdout.write(
      c
        ? chalk.red(" network error.\n")
        : " network error.\n",
    );
    return null;
  }
  if (ok) {
    process.stdout.write(
      c
        ? chalk.green(" done!\n")
        : " done!\n",
    );
    process.stdout.write(
      c
        ? chalk.dim(`Playing as `) + chalk.bold.white(name.trim()) + chalk.dim(` the ${characterClass}\n`)
        : `Playing as ${name.trim()} the ${characterClass}\n`,
    );
  } else {
    process.stdout.write(
      c
        ? chalk.red(" failed.\n")
        : " failed.\n",
    );
  }
  return ok;
}

// ─── Main ────────────────────────────────────────────────────────────────────

type ClientMode = "game" | "shell";

function runGame(opts: CliOptions): void {
  const history = new CommandHistory();
  let activeLinks: NumberedLink[] = [];
  let connected = false;
  let inventory: InvState | null = null;
  let mode: ClientMode = "game";
  let showLegend = true;
  let pendingHelpAppend = false;

  // Build WebSocket URL
  const wsUrl = opts.server.startsWith("ws://") || opts.server.startsWith("wss://")
    ? opts.server
    : buildWsUrl(opts.server);

  // ─── Readline setup ──────────────────────────────────────────────────────

  const rl = createInterface({
    input: stdin,
    output: stdout,
    terminal: true,
    prompt: promptString(connected),
    historySize: 0, // We use our own CommandHistory for up/down
  });

  // ─── Wire CommandHistory to up/down arrow keys ───────────────────────────
  // Node's readline has built-in history, but we use our own CommandHistory
  // so the same buffer is shared with MUDdownConnection and link shortcuts.

  let currentInput = "";

  emitKeypressEvents(stdin, rl);

  stdin.on("keypress", (_ch: string | undefined, key: { name: string; ctrl: boolean } | undefined) => {
    if (!key) return;
    if (key.name === "up") {
      // Save the in-progress input before starting history navigation
      if (history.cursor === -1) {
        currentInput = rl.line;
      }
      const entry = history.up();
      if (entry !== null) {
        // Replace the current readline buffer with the history entry
        rl.write(null, { ctrl: true, name: "u" }); // clear line
        rl.write(entry);
      }
    } else if (key.name === "down") {
      const entry = history.down();
      // Clear line and write the entry (or restore saved input)
      rl.write(null, { ctrl: true, name: "u" });
      rl.write(entry ?? currentInput);
    } else {
      // Reset history cursor when typing other keys
      // (captured on next line submit via history.push)
    }
  });

  function promptString(isConnected: boolean): string {
    if (mode === "shell") {
      return opts.ansi ? chalk.magenta("muddown") + chalk.dim("> ") : "muddown> ";
    }
    if (!opts.ansi) return isConnected ? "> " : "[disconnected] > ";
    return isConnected
      ? chalk.green("> ")
      : chalk.red("[disconnected] ") + chalk.green("> ");
  }

  function updatePrompt(): void {
    rl.setPrompt(promptString(connected));
  }

  function display(text: string): void {
    // Clear the current line, print, then re-prompt
    process.stdout.write("\r\x1b[K");
    console.log(text);
    rl.prompt(true);
  }

  // ─── Connection ──────────────────────────────────────────────────────────

  function createConnection(targetUrl: string): MUDdownConnection {
    const thisConn = new MUDdownConnection(
      { wsUrl: targetUrl, autoReconnect: true, reconnectDelay: 3000 },
      {
        onOpen: () => {
          connected = true;
          mode = "game";
          updatePrompt();
          display(
            opts.ansi
              ? chalk.green("Connected to ") + chalk.bold(targetUrl)
              : `Connected to ${targetUrl}`,
          );
        },

        onMessage: (muddown: string, _type: string) => {
          const { text, links } = renderTerminal(muddown, {
            cols: opts.cols,
            linkMode: opts.linkMode,
            ansi: opts.ansi,
          });
          // Only update active links when the new message contains links;
          // follow-up messages (e.g. LLM room descriptions) have none and
          // would otherwise wipe the link table before the user can use it.
          if (links.length > 0) {
            activeLinks = links;
          }
          display(text);

          // Append client-side commands after server help output
          if (pendingHelpAppend) {
            pendingHelpAppend = false;
            const c = opts.ansi;
            const clientHelp = [
              "",
              c ? chalk.bold("Client Commands:") : "Client Commands:",
              c ? `  ${chalk.cyan("legend")}      Toggle numbered link legend on/off` : "  legend      Toggle numbered link legend on/off",
              c ? `  ${chalk.cyan("/inventory")}  Show your inventory` : "  /inventory  Show your inventory",
            ];
            display(clientHelp.join("\n"));
          }

          // Show numbered link legend if applicable
          if (opts.linkMode === "numbered" && links.length > 0 && showLegend) {
            const heading = opts.ansi ? chalk.dim("Legend") : "Legend";
            const rows = links
              .map(l =>
                opts.ansi
                  ? `  ${chalk.dim(`[${l.index}]`)} ${l.command}`
                  : `  [${l.index}] ${l.command}`,
              )
              .join("\n");
            display(`\n${heading}\n${rows}`);
          }
        },

        onHint: (hint: ParsedHint) => {
          const hintText = opts.ansi
            ? chalk.yellow("💡 ") + chalk.yellow(hint.hint)
            : `Hint: ${hint.hint}`;
          display(hintText);
          if (hint.commands.length > 0) {
            const cmds = hint.commands
              .map(c => (opts.ansi ? `  ${chalk.dim("•")} ${chalk.cyan(c)}` : `  • ${c}`))
              .join("\n");
            display(cmds);
          }
        },

        onInventory: (state: InvState) => {
          inventory = state;
        },

        onClose: (willReconnect: boolean) => {
          connected = false;
          updatePrompt();
          if (willReconnect) {
            display(opts.ansi ? chalk.yellow("Reconnecting...") : "Reconnecting...");
          } else {
            thisConn.dispose();
            enterShellMode();
          }
        },

        onError: (event: Event) => {
          const msg =
            ("message" in event && typeof (event as ErrorEvent).message === "string"
              ? (event as ErrorEvent).message
              : undefined) ??
            (event as Record<string, unknown>).error instanceof Error
              ? ((event as Record<string, unknown>).error as Error).message
              : "WebSocket error";
          display(opts.ansi ? chalk.red(`Connection error: ${msg}`) : `Connection error: ${msg}`);
          // onClose fires next and handles reconnect
        },

        onParseError: (data: string, error: unknown) => {
          display(opts.ansi ? chalk.red(`Parse error: ${error}`) : `Parse error: ${error}`);
        },

        onReconnecting: async () => {
          if (opts.sessionToken) {
            const httpBase = wsToHttpBase(opts.server);
            const ticket = await fetchWsTicket(httpBase, opts.sessionToken);
            if (ticket) return ticket;
          }
          return undefined;
        },
      },
    );
    return thisConn;
  }

  let conn = createConnection(wsUrl);

  // ─── Shell mode ───────────────────────────────────────────────────────

  function enterShellMode(): void {
    mode = "shell";
    activeLinks = [];
    inventory = null;
    display(
      opts.ansi
        ? chalk.yellow("Disconnected.") + chalk.dim(" Type ") + chalk.cyan("help") + chalk.dim(" for shell commands.")
        : "Disconnected. Type help for shell commands.",
    );
    updatePrompt();
  }

  function printShellHelp(): void {
    const c = opts.ansi;
    const lines = [
      c ? chalk.bold("Shell Commands:") : "Shell Commands:",
      "",
      c ? `  ${chalk.cyan("games")}       Browse the games directory and connect` : "  games       Browse the games directory and connect",
      c ? `  ${chalk.cyan("connect")} ${chalk.dim("<url>")}  Connect to a WebSocket URL` : "  connect <url>  Connect to a WebSocket URL",
      c ? `  ${chalk.cyan("reconnect")}   Reconnect to the last server` : "  reconnect   Reconnect to the last server",
      c ? `  ${chalk.cyan("legend")}      Toggle numbered link legend on/off` : "  legend      Toggle numbered link legend on/off",
      c ? `  ${chalk.cyan("version")}     Show client version` : "  version     Show client version",
      c ? `  ${chalk.cyan("clear")}       Clear the screen` : "  clear       Clear the screen",
      c ? `  ${chalk.cyan("help")}        Show this help message` : "  help        Show this help message",
      c ? `  ${chalk.cyan("quit")}        Exit the client` : "  quit        Exit the client",
    ];
    display(lines.join("\n"));
  }

  async function shellConnect(targetUrl: string): Promise<void> {
    opts.server = targetUrl;

    display(
      opts.ansi
        ? chalk.dim(`Connecting to ${targetUrl}...`)
        : `Connecting to ${targetUrl}...`,
    );

    // If we have a session token, exchange for a fresh ws-ticket
    if (opts.sessionToken) {
      const httpBase = wsToHttpBase(targetUrl);
      const ticket = await fetchWsTicket(httpBase, opts.sessionToken);
      if (ticket) opts.token = ticket;
    }

    conn.dispose();
    conn = createConnection(targetUrl);
    conn.connect(opts.token);
  }

  async function shellGames(): Promise<void> {
    const c = opts.ansi;
    display(c ? chalk.dim("Fetching games directory…") : "Fetching games directory…");
    const games = await fetchGames(opts.ansi);

    if (games.length === 0) {
      display(
        c
          ? chalk.yellow("No WebSocket games found in directory.")
          : "No WebSocket games found in directory.",
      );
      rl.prompt();
      return;
    }

    const lines: string[] = [];
    lines.push(c ? chalk.bold("Available Games:") : "Available Games:");
    for (let i = 0; i < games.length; i++) {
      const g = games[i];
      const num = c ? chalk.cyan(`  [${i + 1}]`) : `  [${i + 1}]`;
      const name = c ? chalk.bold.white(g.name) : g.name;
      const cert = CERT_LABEL[g.certification] ?? g.certification;
      const certStr = c ? chalk.dim(` (${cert})`) : ` (${cert})`;
      const desc = g.description ? (c ? chalk.dim(`\n        ${g.description}`) : `\n        ${g.description}`) : "";
      lines.push(`${num} ${name}${certStr}${desc}`);
    }
    lines.push(
      c ? chalk.dim(`\n  [0] Enter a custom WebSocket URL`) : `\n  [0] Enter a custom WebSocket URL`,
    );
    display(lines.join("\n"));

    const question = (prompt: string): Promise<string> =>
      new Promise(resolve => rl.question(prompt, resolve));

    const defaultLabel = c ? chalk.dim("[1]") : "[1]";
    const choiceRaw = await question(
      c
        ? chalk.green("Pick a game") + chalk.dim(` ${defaultLabel}: `)
        : `Pick a game ${defaultLabel}: `,
    );
    const choice = choiceRaw.trim();

    let targetUrl: string | undefined;
    if (choice === "0") {
      const urlRaw = await question(
        c ? chalk.green("WebSocket URL") + chalk.dim(": ") : "WebSocket URL: ",
      );
      targetUrl = urlRaw.trim() || undefined;
    } else {
      const idx = choice === "" ? 1 : parseInt(choice, 10);
      const selected = games[idx - 1];
      if (selected) {
        targetUrl = gameWsUrl(selected);
        display(
          c
            ? chalk.dim(`Selected: `) + chalk.white(selected.name)
            : `Selected: ${selected.name}`,
        );
      } else {
        display(c ? chalk.yellow("Invalid choice.") : "Invalid choice.");
      }
    }

    if (targetUrl) {
      await shellConnect(targetUrl);
    } else {
      rl.prompt();
    }
  }

  function handleShellInput(input: string): void {
    const [cmd, ...rest] = input.split(/\s+/);
    const lc = cmd.toLowerCase();

    if (lc === "help" || lc === "?") {
      printShellHelp();
      rl.prompt();
      return;
    }

    if (lc === "version" || lc === "ver") {
      display(
        opts.ansi
          ? chalk.bold.green("MUDdown Terminal Client") + chalk.dim(" v0.1.0")
          : "MUDdown Terminal Client v0.1.0",
      );
      rl.prompt();
      return;
    }

    if (lc === "clear" || lc === "cls") {
      process.stdout.write("\x1b[2J\x1b[H");
      rl.prompt();
      return;
    }

    if (lc === "legend") {
      showLegend = !showLegend;
      display(
        opts.ansi
          ? chalk.yellow(`Legend ${showLegend ? "on" : "off"}.`)
          : `Legend ${showLegend ? "on" : "off"}.`,
      );
      rl.prompt();
      return;
    }

    if (lc === "games" || lc === "browse") {
      shellGames().catch(() => {
        display(opts.ansi ? chalk.red("Failed to fetch games.") : "Failed to fetch games.");
        rl.prompt();
      });
      return;
    }

    if (lc === "connect") {
      const url = rest.join(" ");
      if (!url) {
        display(
          opts.ansi
            ? chalk.yellow("Usage: ") + chalk.cyan("connect <ws://url>")
            : "Usage: connect <ws://url>",
        );
        rl.prompt();
        return;
      }
      shellConnect(url).catch(() => {
        display(opts.ansi ? chalk.red("Connection failed.") : "Connection failed.");
        rl.prompt();
      });
      return;
    }

    if (lc === "reconnect" || lc === "rc") {
      display(
        opts.ansi
          ? chalk.dim(`Reconnecting to ${opts.server}...`)
          : `Reconnecting to ${opts.server}...`,
      );
      shellConnect(opts.server).catch(() => {
        display(opts.ansi ? chalk.red("Reconnection failed.") : "Reconnection failed.");
        rl.prompt();
      });
      return;
    }

    if (lc === "quit" || lc === "exit") {
      display(opts.ansi ? chalk.yellow("Goodbye!") : "Goodbye!");
      rl.close();
      return;
    }

    display(
      opts.ansi
        ? chalk.yellow(`Unknown command: ${cmd}. `) + chalk.dim("Type ") + chalk.cyan("help") + chalk.dim(" for options.")
        : `Unknown command: ${cmd}. Type help for options.`,
    );
    rl.prompt();
  }

  // ─── Input handling ──────────────────────────────────────────────────────

  rl.on("line", (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Dispatch to shell handler when not in a game
    if (mode === "shell") {
      handleShellInput(input);
      return;
    }

    // Numbered link shortcut
    if (opts.linkMode === "numbered" && /^\d+$/.test(input)) {
      const idx = parseInt(input, 10);
      const link = activeLinks.find(l => l.index === idx);
      if (link) {
        history.push(link.command);
        conn.send(link.command);
        rl.prompt();
        return;
      }
    }

    // Built-in client commands
    if (input === "quit" || input === "exit" || input === "/quit" || input === "/exit") {
      display(opts.ansi ? chalk.yellow("Disconnecting from game...") : "Disconnecting from game...");
      conn.send("quit");
      return;
    }

    if (input === "/legend" || input === "legend") {
      showLegend = !showLegend;
      display(
        opts.ansi
          ? chalk.yellow(`Legend ${showLegend ? "on" : "off"}.`)
          : `Legend ${showLegend ? "on" : "off"}.`,
      );
      rl.prompt();
      return;
    }

    if (input === "help" || input === "/help") {
      pendingHelpAppend = true;
    }

    if (input === "/inventory" || input === "/inv") {
      if (inventory) {
        displayInventory(inventory, opts);
      } else {
        display(opts.ansi ? chalk.yellow("No inventory data yet.") : "No inventory data yet.");
      }
      rl.prompt();
      return;
    }

    // Send command to server
    history.push(input);
    if (!conn.send(input)) {
      display(
        opts.ansi
          ? chalk.red("Not connected. Command not sent.")
          : "Not connected. Command not sent.",
      );
    }
    rl.prompt();
  });

  rl.on("close", () => {
    conn.dispose();
    exit(0);
  });

  // Listen for terminal resize
  stdout.on("resize", () => {
    opts.cols = stdout.columns || 80;
  });

  // ─── Connect and start ──────────────────────────────────────────────────

  console.log(
    opts.ansi

      ? chalk.dim(`Connecting to ${wsUrl}...`)
      : `Connecting to ${wsUrl}...`,
  );

  conn.connect(opts.token);
  rl.prompt();
}

// ─── Inventory display ───────────────────────────────────────────────────────

function displayInventory(inv: InvState, opts: CliOptions): void {
  const lines: string[] = [];

  if (opts.ansi) {
    lines.push(chalk.bold.yellow("═══ Inventory ═══"));
  } else {
    lines.push("=== Inventory ===");
  }

  if (inv.items.length === 0) {
    lines.push(opts.ansi ? chalk.dim("  (empty)") : "  (empty)");
  } else {
    for (const item of inv.items) {
      const tags: string[] = [];
      if (item.equippable) tags.push("equippable");
      if (item.usable) tags.push("usable");
      const tagStr = tags.length > 0
        ? (opts.ansi ? chalk.dim(` [${tags.join(", ")}]`) : ` [${tags.join(", ")}]`)
        : "";
      lines.push(`  ${opts.ansi ? chalk.white(item.name) : item.name}${tagStr}`);
    }
  }

  // Equipped items
  const equippedEntries = Object.entries(inv.equipped).filter(([, v]) => v !== null);
  if (equippedEntries.length > 0) {
    lines.push("");
    lines.push(opts.ansi ? chalk.bold.yellow("═══ Equipped ═══") : "=== Equipped ===");
    for (const [slot, item] of equippedEntries) {
      if (item) {
        lines.push(
          opts.ansi
            ? `  ${chalk.dim(slot + ":")} ${chalk.white(item.name)}`
            : `  ${slot}: ${item.name}`,
        );
      }
    }
  }

  process.stdout.write("\r\x1b[K");
  console.log(lines.join("\n"));
}

// ─── Entry point ─────────────────────────────────────────────────────────────

(async () => {
  const opts = parseArgs(argv);
  if (!opts.serverFromFlag) {
    await runStartupWizard(opts);
  } else {
    // Banner when launched with --server directly
    console.log(
      opts.ansi
        ? chalk.bold.green("MUDdown Terminal Client") + chalk.dim(" v0.1.0")
        : "MUDdown Terminal Client v0.1.0",
    );
  }

  // If --token was provided, treat it as a session token:
  // store it for reconnect and exchange for a ws-ticket before connecting.
  if (opts.token && !opts.sessionToken) {
    opts.sessionToken = opts.token;
    const httpBase = wsToHttpBase(opts.server);
    const ticket = await fetchWsTicket(httpBase, opts.token);
    if (ticket) opts.token = ticket;
  }

  runGame(opts);
})().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`Fatal error: ${msg}`);
  process.exit(1);
});
