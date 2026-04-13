import {
  escapeHtml,
  renderMuddown,
  CommandHistory,
  resolveGameLink,
  MUDdownConnection,
  buildWsUrl,
} from "@muddown/client";
import type { InvState } from "@muddown/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check } from "@tauri-apps/plugin-updater";
import { ask } from "@tauri-apps/plugin-dialog";
import { onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { load as loadStore } from "@tauri-apps/plugin-store";

// ── DOM Elements ──────────────────────────────────────────────────

const output = document.getElementById("game-output")!;
const input = document.getElementById("game-input")! as HTMLInputElement;
const authGate = document.getElementById("auth-gate")!;
const characterPanel = document.getElementById("character-panel")!;
const gameArea = document.getElementById("game-area")!;
const invPanel = document.getElementById("inventory-panel")!;
const invItemsList = document.getElementById("inv-items")!;
const invStatus = document.getElementById("inv-status")!;
const hintPanel = document.getElementById("hint-panel")!;
const hintText = document.getElementById("hint-text")!;
const hintCommands = document.getElementById("hint-commands")!;
const hintStatus = document.getElementById("hint-status")!;
const serverUrlInput = document.getElementById("server-url")! as HTMLInputElement;

// ── Types ─────────────────────────────────────────────────────────

interface CharacterSummary {
  id: string;
  name: string;
  characterClass: string;
  hp: number;
  maxHp: number;
  xp: number;
}

// ── State ─────────────────────────────────────────────────────────

let apiBase = "http://localhost:3300";
let isGuest = false;
let conn: MUDdownConnection | null = null;
let lastInvState: InvState | null = null;
let currentInvMode: "off" | "persistent" = "persistent";
let currentHintMode: "off" | "persistent" = "off";
let authToken: string | null = null;

// ── Token persistence ─────────────────────────────────────────────

const AUTH_STORE_PATH = "auth.json";
const AUTH_TOKEN_KEY = "token";

/** @throws If the secure store cannot be opened or written to. */
async function saveToken(token: string): Promise<void> {
  authToken = token;
  const store = await loadStore(AUTH_STORE_PATH);
  await store.set(AUTH_TOKEN_KEY, token);
  await store.save();
}

async function loadToken(): Promise<string | null> {
  try {
    const store = await loadStore(AUTH_STORE_PATH);
    const token = await store.get<string>(AUTH_TOKEN_KEY);
    authToken = token ?? null;
    return authToken;
  } catch (err) {
    console.error("[loadToken] Could not read stored token:", err);
    return null;
  }
}

async function clearStoredToken(): Promise<void> {
  authToken = null;
  try {
    const store = await loadStore(AUTH_STORE_PATH);
    await store.delete(AUTH_TOKEN_KEY);
    await store.save();
  } catch (err) {
    console.warn("[clearStoredToken] Could not clear stored token:", err);
  }
}

/** Build fetch init with bearer auth token if available. */
function authInit(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }
  return { ...init, headers };
}

// ── Tauri bridge helpers ──────────────────────────────────────────

async function setWindowTitle(title: string): Promise<void> {
  await invoke("set_window_title", { title });
}

async function sendNotification(title: string, body: string): Promise<void> {
  await invoke("send_notification", { title, body });
}

async function setTrayTooltip(tooltip: string): Promise<void> {
  await invoke("set_tray_tooltip", { tooltip });
}

// ── View helpers ──────────────────────────────────────────────────

function showView(view: "auth" | "character" | "game"): void {
  authGate.style.display = view === "auth" ? "" : "none";
  characterPanel.style.display = view === "character" ? "" : "none";
  gameArea.style.display = view === "game" ? "" : "none";
  if (view === "game") {
    applyInvMode(currentInvMode);
    applyHintMode(currentHintMode);
    input.focus();
  }
}

// ── Auth flow ─────────────────────────────────────────────────────

async function checkAuthAndRoute(): Promise<void> {
  try {
    const res = await fetch(`${apiBase}/auth/me`, authInit());
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) await clearStoredToken();
      showView("auth");
      return;
    }
    const me = res.headers.get("content-type")?.includes("application/json") ? await res.json() : null;
    if (me?.activeCharacter) {
      startGame(me.activeCharacter.name);
    } else {
      await showCharacterPanel();
    }
  } catch (err) {
    console.error("[checkAuthAndRoute] Auth check failed:", err);
    showView("auth");
  }
}

async function showCharacterPanel(): Promise<void> {
  showView("character");
  await loadCharacterList();
}

async function loadCharacterList(): Promise<void> {
  const listEl = document.getElementById("character-list")!;
  try {
    const res = await fetch(`${apiBase}/auth/characters`, authInit());
    if (res.status === 401) { showView("auth"); return; }
    if (!res.ok) {
      listEl.innerHTML = `<p>Could not load characters (HTTP ${res.status}).</p>`;
      return;
    }
    const data = await res.json();
    if (!data.characters?.length) {
      listEl.innerHTML = '<p class="text-dim">No characters yet — create one below.</p>';
      return;
    }
    listEl.innerHTML = ((data.characters ?? []) as CharacterSummary[])
      .map(
        (c) => `
      <div class="char-row">
        <div class="char-info">
          <strong>${escapeHtml(c.name)}</strong>
          <span class="text-dim">${escapeHtml(c.characterClass)} · HP ${c.hp}/${c.maxHp} · XP ${c.xp}</span>
        </div>
        <button class="panel-btn panel-btn-sm" data-char-id="${escapeHtml(c.id)}">Play</button>
      </div>
    `,
      )
      .join("");

    listEl.querySelectorAll("button[data-char-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const charId = btn.getAttribute("data-char-id")!;
        const charName =
          btn.closest(".char-row")?.querySelector("strong")?.textContent ??
          undefined;
        selectCharacter(charId, charName);
      });
    });
  } catch (err) {
    console.error("[loadCharacterList] Failed to load characters:", err);
    listEl.innerHTML = "<p>Could not load characters.</p>";
  }
}

async function selectCharacter(
  characterId: string,
  charName?: string,
): Promise<void> {
  try {
    const res = await fetch(`${apiBase}/auth/select-character`, {
      method: "POST",
      ...authInit({
        headers: { "Content-Type": "application/json" },
      }),
      body: JSON.stringify({ characterId }),
    });
    if (res.ok) {
      if (!charName) {
        try {
          const data = await res.json();
          charName = data.name;
        } catch (err) {
          console.warn("[selectCharacter] Could not parse success body:", err);
        }
      }
      await startGame(charName);
    } else {
      let errMsg = `HTTP ${res.status}`;
      try {
        const errBody = await res.json();
        if (typeof errBody === "object" && errBody !== null && "error" in errBody) {
          errMsg = String((errBody as Record<string, unknown>).error);
        }
      } catch (err) {
        console.warn("[selectCharacter] Could not parse error body:", err);
      }
      appendMessage(`**Error:** ${errMsg}`, "system");
    }
  } catch (err) {
    console.error("[selectCharacter] Failed to select character:", err);
    appendMessage("**Could not contact server.**", "system");
  }
}

// ── Character creation ────────────────────────────────────────────

const createForm = document.getElementById(
  "create-character-form",
)! as HTMLFormElement;
const createError = document.getElementById("create-error")!;

createForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  createError.textContent = "";

  const name = (
    document.getElementById("char-name")! as HTMLInputElement
  ).value.trim();
  const charClass = (
    createForm.querySelector(
      'input[name="charClass"]:checked',
    ) as HTMLInputElement
  )?.value;

  if (!name || !charClass) {
    createError.textContent = "Please enter a name and select a class.";
    return;
  }

  try {
    const res = await fetch(`${apiBase}/auth/create-character`, {
      method: "POST",
      ...authInit({
        headers: { "Content-Type": "application/json" },
      }),
      body: JSON.stringify({ name, characterClass: charClass }),
    });

    const responseText = await res.text();
    let data: { error?: string };
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { error: responseText.trim() || `Server error (HTTP ${res.status})` };
    }

    if (!res.ok) {
      createError.textContent = data.error || "Failed to create character.";
      return;
    }
    startGame(name);
  } catch (err) {
    console.error("[createCharacter] Failed to create character:", err);
    createError.textContent = "Failed to contact server.";
  }
});

// ── Start game ────────────────────────────────────────────────────

async function startGame(characterName?: string): Promise<void> {
  showView("game");

  if (isGuest) {
    setWindowTitle("MUDdown — Guest").catch((err) => console.error("[startGame] setWindowTitle failed:", err));
    connectToServer();
    return;
  }

  try {
    const res = await fetch(`${apiBase}/auth/ws-ticket`, authInit());
    if (res.ok) {
      const data = res.headers.get("content-type")?.includes("application/json") ? await res.json() : null;
      const ticket = data?.ticket;
      if (characterName) {
        setWindowTitle(`MUDdown — ${characterName}`).catch((err) => console.error("[startGame] setWindowTitle failed:", err));
      }
      connectToServer(ticket);
    } else {
      appendMessage(
        "**Could not start session.** Please try again.",
        "system",
      );
      showView("auth");
    }
  } catch (err) {
    console.error("[startGame] Failed to start game:", err);
    appendMessage("**Could not contact server.** Please try again.", "system");
    showView("auth");
  }
}

// ── Guest / Login buttons ─────────────────────────────────────────

document.getElementById("guest-play-btn")!.addEventListener("click", () => {
  apiBase = serverUrlInput.value.trim() || "http://localhost:3300";
  isGuest = true;
  startGame();
});

const loginPlayBtn = document.getElementById("login-play-btn")!;
const providerBtns = document.getElementById("provider-buttons")!;

loginPlayBtn.addEventListener("click", async () => {
  apiBase = serverUrlInput.value.trim() || "http://localhost:3300";
  isGuest = false;

  // Check for existing token first
  await loadToken();
  if (authToken) {
    await checkAuthAndRoute();
    return;
  }

  // Fetch available providers and show buttons
  try {
    const res = await fetch(`${apiBase}/auth/providers`);
    if (!res.ok) {
      providerBtns.innerHTML = '<p class="form-error">Could not reach server.</p>';
      providerBtns.style.display = "";
      return;
    }
    const data = await res.json();
    const providers: string[] = data.providers ?? [];
    if (providers.length === 0) {
      providerBtns.innerHTML = '<p class="form-error">No login providers configured on this server.</p>';
      providerBtns.style.display = "";
      return;
    }

    const providerIcons: Record<string, string> = {
      discord: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.947 2.418-2.157 2.418z"/></svg>',
      github: '<svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>',
      microsoft: '<svg viewBox="0 0 21 21" width="20" height="20" aria-hidden="true"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>',
      google: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>',
    };

    const labels: Record<string, string> = {
      github: "GitHub",
      discord: "Discord",
      microsoft: "Microsoft",
      google: "Google",
    };

    providerBtns.innerHTML = providers
      .map(
        (p) =>
          `<button class="provider-btn" data-provider="${escapeHtml(p)}">${providerIcons[p] ?? ""}Login with ${escapeHtml(labels[p] ?? p)}</button>`,
      )
      .join("");
    providerBtns.style.display = "";

    providerBtns.querySelectorAll("button[data-provider]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const provider = btn.getAttribute("data-provider")!;
        startOAuthLogin(provider);
      });
    });
  } catch (err) {
    console.error("[login] Failed to fetch providers:", err);
    providerBtns.innerHTML = '<p class="form-error">Could not contact server.</p>';
    providerBtns.style.display = "";
  }
});

let loginPollTimer: ReturnType<typeof setInterval> | null = null;
let loginTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

function cancelLoginTimers(): void {
  if (loginPollTimer) { clearInterval(loginPollTimer); loginPollTimer = null; }
  if (loginTimeoutTimer) { clearTimeout(loginTimeoutTimer); loginTimeoutTimer = null; }
}

async function startOAuthLogin(provider: string): Promise<void> {
  const redirectUri = "muddown://auth/callback";
  const loginNonce = crypto.randomUUID();
  const loginUrl = `${apiBase}/auth/login?provider=${encodeURIComponent(provider)}&redirect_uri=${encodeURIComponent(redirectUri)}&login_nonce=${encodeURIComponent(loginNonce)}`;

  try {
    await openUrl(loginUrl);
  } catch (err) {
    console.error("[startOAuthLogin] Failed to open browser:", err);
    providerBtns.innerHTML = '<p class="form-error">Could not open browser for login.</p>';
    return;
  }

  // Poll the server for the completed login token (handles dev mode where
  // deep links don't work, and also acts as a reliable fallback in production).
  cancelLoginTimers();
  providerBtns.innerHTML = '<p class="text-dim">Waiting for authentication in browser…</p>';

  loginPollTimer = setInterval(async () => {
    let res: Response;
    try {
      res = await fetch(`${apiBase}/auth/token-poll?nonce=${encodeURIComponent(loginNonce)}`);
    } catch {
      // Network error — keep polling
      return;
    }
    try {
      if (res.status === 200) {
        const data = await res.json();
        if (data.token) {
          cancelLoginTimers();
          await saveToken(data.token);
          providerBtns.style.display = "none";
          await checkAuthAndRoute();
        }
      }
      // 202 = still pending, keep polling
    } catch (err) {
      console.error("[startOAuthLogin] Poll success handling failed:", err);
      cancelLoginTimers();
      providerBtns.innerHTML = '<p class="form-error">Login failed. Please try again.</p>';
    }
  }, 1500);

  // Stop polling after 5 minutes
  loginTimeoutTimer = setTimeout(() => {
    if (loginPollTimer) {
      cancelLoginTimers();
      providerBtns.innerHTML = '<p class="form-error">Login timed out. Please try again.</p>';
    }
  }, 5 * 60 * 1000);
}

// ── Deep link handler (OAuth callback) ────────────────────────────

onOpenUrl(async (urls: string[]) => {
  for (const raw of urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }

    // Only handle muddown://auth/callback
    if (url.protocol !== "muddown:" || url.hostname !== "auth" || url.pathname !== "/callback") continue;

    const token = url.searchParams.get("token");
    if (!token) {
      console.error("[deep-link] OAuth callback received but no token in URL");
      continue;
    }

    try {
      await saveToken(token);
    } catch (err) {
      console.error("[deep-link] Failed to persist token:", err);
    }
    cancelLoginTimers();
    providerBtns.style.display = "none";
    await checkAuthAndRoute();
    return;
  }
}).catch((err) => {
  console.error("[deep-link] Failed to register URL handler:", err);
});

// ── Rendering ─────────────────────────────────────────────────────

function appendMessage(muddown: string, className: string): void {
  const div = document.createElement("div");
  div.className = className;

  const blockMatch = muddown.match(/^:::(\w[\w-]*)/m);
  if (blockMatch) {
    const ariaLabels: Record<string, string> = {
      room: "Room description",
      system: "System message",
      combat: "Combat update",
      dialogue: "NPC dialogue",
    };
    const label = ariaLabels[blockMatch[1]];
    if (label) {
      div.setAttribute("role", "group");
      div.setAttribute("aria-label", label);
    }
  }

  div.innerHTML = renderMuddown(muddown);
  output.appendChild(div);
  requestAnimationFrame(() => {
    output.scrollTop = output.scrollHeight;
  });

  // Extract room title for window title
  if (className === "room") {
    const h1 = div.querySelector("h1");
    if (h1?.textContent) {
      setWindowTitle(`MUDdown — ${h1.textContent}`).catch((err) => console.error("[appendMessage] setWindowTitle failed:", err));
    }
  }

  // Notify on mentions & combat when window is not focused
  if (!document.hasFocus()) {
    if (className === "combat") {
      sendNotification("Combat!", "You are in combat.").catch((err) => console.warn("[appendMessage] notification failed:", err));
    }
    if (className === "dialogue") {
      sendNotification("NPC Contact", "An NPC is speaking to you.").catch((err) => console.warn("[appendMessage] notification failed:", err));
    }
    if (muddown.includes("@")) {
      const mentionMatch = muddown.match(/\[@([^\]]+)\]/);
      if (mentionMatch) {
        sendNotification("Mentioned", `${mentionMatch[1]} mentioned you.`).catch((err) => console.warn("[appendMessage] notification failed:", err));
      }
    }
  }
}

function appendRawHtml(html: string, className: string): void {
  const div = document.createElement("div");
  div.className = className;
  div.innerHTML = html;
  output.appendChild(div);
  requestAnimationFrame(() => {
    output.scrollTop = output.scrollHeight;
  });
}

// ── Game link handler ─────────────────────────────────────────────

output.addEventListener("click", (e) => {
  const link = (e.target as HTMLElement).closest<HTMLAnchorElement>(
    "a.game-link",
  );
  if (!link) return;
  e.preventDefault();
  const scheme = link.getAttribute("data-scheme") ?? "";
  const target = link.getAttribute("data-target") ?? "";
  const cmd = resolveGameLink(scheme, target);
  if (cmd) sendCommand(cmd);
  input.scrollIntoView({ block: "end" });
  input.focus();
});

// ── WebSocket connection ──────────────────────────────────────────

function connectToServer(ticket?: string): void {
  // Dispose any existing connection to prevent WebSocket/timer leaks
  if (conn) {
    conn.dispose();
    conn = null;
  }

  appendMessage("*Connecting to server...*", "system");

  let wsUrl: string;
  try {
    wsUrl = buildWsUrl(apiBase);
  } catch (err) {
    appendMessage(`*Invalid server URL: "${escapeHtml(apiBase)}". Enter a valid http:// or https:// address.*`, "system");
    console.error("[connectToServer] Invalid server URL:", apiBase, err);
    return;
  }

  conn = new MUDdownConnection(
    { wsUrl },
    {
      onOpen: () => {
        appendMessage("*Connected!*", "system");
        setTrayTooltip("MUDdown — Connected").catch((err) => console.warn("[tray] tooltip update failed:", err));
      },
      onMessage: (muddown, type) => appendMessage(muddown, type),
      onHint: (hint) => {
        renderHintPanel(hint.hint, hint.commands);
        if (currentHintMode === "off") applyHintMode("persistent");
      },
      onInventory: (state) => renderInventoryState(state),
      onClose: (willReconnect) => {
        if (willReconnect) {
          appendMessage("*Disconnected. Reconnecting in 3s...*", "system");
          setTrayTooltip("MUDdown — Reconnecting…").catch((err) => console.warn("[tray] tooltip update failed:", err));
        } else {
          appendMessage("*Disconnected.*", "system");
          setTrayTooltip("MUDdown — Disconnected").catch((err) => console.warn("[tray] tooltip update failed:", err));
        }
      },
      onError: (event) => {
        console.error("WebSocket error:", event);
        appendMessage("*Connection error. Check the server URL and your network.*", "system");
      },
      onParseError: (data, err) => {
        console.error("Failed to parse server message:", err, data);
        appendMessage(
          "*Received an unreadable message from the server.*",
          "system",
        );
      },
    },
  );

  conn.connect(ticket);
}

function sendCommand(cmd: string): void {
  if (!conn?.send(cmd)) {
    appendMessage("*Not connected to server.*", "system");
  }
}

// ── Input handling ────────────────────────────────────────────────

const history = new CommandHistory();

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const cmd = input.value.trim();
    if (!cmd) return;
    history.push(cmd);
    appendRawHtml(
      `<span style="color:var(--green)">&gt; ${escapeHtml(cmd)}</span>`,
      "input-echo",
    );
    sendCommand(cmd);
    input.value = "";
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    const prev = history.up();
    if (prev !== null) input.value = prev;
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    input.value = history.down() ?? "";
  }
});

// ── Keyboard shortcuts ────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  // Ctrl/Cmd+L — clear output
  if ((e.ctrlKey || e.metaKey) && e.key === "l") {
    e.preventDefault();
    output.innerHTML = "";
    return;
  }

  // Ctrl/Cmd+K — focus input
  if ((e.ctrlKey || e.metaKey) && e.key === "k") {
    e.preventDefault();
    input.focus();
    return;
  }

  // Redirect printable keys to input when game is active
  if (gameArea.style.display === "none") return;
  if (e.defaultPrevented) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const active = document.activeElement;
  if (
    active &&
    (active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.tagName === "SELECT" ||
      active.tagName === "BUTTON" ||
      active.tagName === "A")
  )
    return;
  if (active && (active as HTMLElement).isContentEditable) return;
  if (active && (invPanel.contains(active) || hintPanel.contains(active)))
    return;
  if (e.isComposing) return;
  if (e.key.length !== 1) return;
  input.focus();
});

// Refocus input on window focus
window.addEventListener("focus", () => {
  if (gameArea.style.display !== "none") input.focus();
});

// Click on terminal refocuses input
document.getElementById("game-terminal")!.addEventListener("mouseup", (e) => {
  if (
    (e.target as HTMLElement).closest("a, button, input, select, textarea")
  )
    return;
  const sel = window.getSelection();
  if (sel && sel.toString().length > 0) return;
  if (gameArea.style.display !== "none") input.focus();
});

// ── Inventory panel ───────────────────────────────────────────────

function applyInvMode(mode: "off" | "persistent"): void {
  currentInvMode = mode;
  invPanel.classList.remove("inv-persistent", "inv-off");
  if (mode === "off") {
    invPanel.classList.add("inv-off");
    invPanel.style.display = "none";
  } else {
    invPanel.classList.add("inv-persistent");
    invPanel.style.display = "";
  }
}

function renderInventoryState(state: InvState): void {
  lastInvState = state;

  for (const slot of ["weapon", "armor", "accessory"]) {
    const el = document.getElementById(`inv-slot-${slot}`);
    if (!el) continue;
    const eq = state.equipped[slot];
    if (eq) {
      el.innerHTML = `<button class="inv-item-btn" data-action="unequip" data-slot="${escapeHtml(slot)}" title="Unequip ${escapeHtml(eq.name)}">${escapeHtml(eq.name)}</button>`;
    } else {
      el.innerHTML = "<em>empty</em>";
    }
  }

  if (state.items.length === 0) {
    invItemsList.innerHTML =
      '<li class="inv-empty">Your inventory is empty.</li>';
  } else {
    const equippedIds = new Set(
      Object.values(state.equipped)
        .filter(Boolean)
        .map((e) => e!.id),
    );
    invItemsList.innerHTML = state.items
      .map((item) => {
        const isEquipped = equippedIds.has(item.id);
        const actions: string[] = [];
        actions.push(
          `<button class="inv-action" data-action="examine" data-item="${escapeHtml(item.id)}" title="Examine">🔍</button>`,
        );
        if (item.equippable && !isEquipped) {
          actions.push(
            `<button class="inv-action" data-action="equip" data-item="${escapeHtml(item.id)}" title="Equip">🛡</button>`,
          );
        }
        if (item.usable) {
          actions.push(
            `<button class="inv-action" data-action="use" data-item="${escapeHtml(item.id)}" title="Use">✨</button>`,
          );
        }
        if (!isEquipped) {
          actions.push(
            `<button class="inv-action" data-action="drop" data-item="${escapeHtml(item.id)}" title="Drop">⬇</button>`,
          );
        }
        const eqBadge = isEquipped
          ? ' <span class="inv-equipped-badge">(equipped)</span>'
          : "";
        return `<li class="inv-item${isEquipped ? " inv-item-equipped" : ""}"><span class="inv-item-name">${escapeHtml(item.name)}${eqBadge}</span><span class="inv-actions">${actions.join("")}</span></li>`;
      })
      .join("");
  }

  invStatus.textContent = `${state.items.length} item${state.items.length !== 1 ? "s" : ""}`;
}

function handleInvAction(btn: HTMLElement): void {
  const action = btn.getAttribute("data-action");
  const item = btn.getAttribute("data-item");
  const slot = btn.getAttribute("data-slot");

  switch (action) {
    case "examine":
      if (item) sendCommand(`examine ${item}`);
      break;
    case "equip":
      if (item) sendCommand(`equip ${item}`);
      break;
    case "unequip":
      if (slot) sendCommand(`unequip ${slot}`);
      break;
    case "use":
      if (item) sendCommand(`use ${item}`);
      break;
    case "drop":
      if (item) sendCommand(`drop ${item}`);
      break;
  }
  input.focus();
}

invPanel.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (btn) handleInvAction(btn);
});

document.getElementById("inv-close-btn")!.addEventListener("click", () => {
  applyInvMode("off");
  input.focus();
});

// ── Hint panel ────────────────────────────────────────────────────

function applyHintMode(mode: "off" | "persistent"): void {
  currentHintMode = mode;
  hintPanel.classList.remove("hint-persistent", "hint-off");
  if (mode === "off") {
    hintPanel.classList.add("hint-off");
    hintPanel.style.display = "none";
  } else {
    hintPanel.classList.add("hint-persistent");
    hintPanel.style.display = "";
  }
}

function renderHintPanel(hintContent: string, commands: string[]): void {
  hintText.innerHTML = hintContent
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => `<p>${escapeHtml(l)}</p>`)
    .join("");

  if (commands.length > 0) {
    hintCommands.innerHTML = commands
      .map(
        (c) =>
          `<button class="hint-cmd-btn" data-cmd="${escapeHtml(c)}" title="Run: ${escapeHtml(c)}">${escapeHtml(c)}</button>`,
      )
      .join("");
  } else {
    hintCommands.innerHTML = "";
  }

  const now = new Date();
  hintStatus.textContent = `Updated ${now.toLocaleTimeString()}`;
}

document.getElementById("hint-close-btn")!.addEventListener("click", () => {
  applyHintMode("off");
  input.focus();
});

document.getElementById("hint-refresh-btn")!.addEventListener("click", () => {
  sendCommand("hint");
});

hintCommands.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-cmd]");
  if (btn) sendCommand(btn.getAttribute("data-cmd") ?? "");
});

// ── Menu actions from Tauri backend ───────────────────────────────

listen<string>("menu-action", (event) => {
  switch (event.payload) {
    case "clear":
      output.innerHTML = "";
      break;
    case "focus_input":
      input.focus();
      break;
    case "toggle_inventory":
      applyInvMode(currentInvMode === "off" ? "persistent" : "off");
      if (lastInvState && currentInvMode === "persistent") {
        renderInventoryState(lastInvState);
      }
      break;
    case "toggle_hints":
      applyHintMode(currentHintMode === "off" ? "persistent" : "off");
      break;
    case "connect":
      if (!conn?.connected) {
        apiBase = serverUrlInput.value.trim() || "http://localhost:3300";
        isGuest = true;
        startGame();
      }
      break;
    case "disconnect":
      conn?.dispose();
      appendMessage("*Disconnected by user.*", "system");
      break;
    case "logout":
      conn?.dispose();
      conn = null;
      cancelLoginTimers();
      clearStoredToken().catch((err) => console.error("[logout] Failed to clear token:", err));
      showView("auth");
      providerBtns.style.display = "";
      setWindowTitle("MUDdown").catch((err) => console.error("[logout] setWindowTitle failed:", err));
      setTrayTooltip("MUDdown — Disconnected").catch((err) => console.warn("[logout] tooltip failed:", err));
      break;
    case "help_commands":
      sendCommand("help");
      break;
    case "about":
      appendMessage(
        ":::system{type=\"info\"}\n**MUDdown Desktop** v0.1.0\n\nA modern MUD client built with Tauri.\nhttps://muddown.com\n:::",
        "system",
      );
      break;
  }
}).catch((err) => {
  console.error("[menu-action] Failed to register menu event listener:", err);
});

// ── Auto-updater ──────────────────────────────────────────────────

async function checkForUpdates(): Promise<void> {
  let update: Awaited<ReturnType<typeof check>>;
  try {
    update = await check();
  } catch (err) {
    console.error("[checkForUpdates] Update check failed:", err);
    return;
  }

  if (!update) return;

  let yes = false;
  try {
    yes = await ask(
      `MUDdown ${update.version} is available.\n\n${update.body ?? ""}`.trim(),
      { title: "Update Available", kind: "info", okLabel: "Install & Restart", cancelLabel: "Later" },
    );
  } catch (err) {
    console.error("[checkForUpdates] Update dialog failed:", err);
    return;
  }

  if (!yes) return;

  appendMessage(`*Downloading update v${update.version}…*`, "system");
  try {
    let total: number | undefined;
    let received = 0;
    let lastPct = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength;
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
        if (total) {
          const pct = Math.round((received / total) * 100);
          if (pct >= lastPct + 25) {
            lastPct = Math.floor(pct / 25) * 25;
            appendMessage(`*Downloading update… ${pct}%*`, "system");
          }
        }
      } else if (event.event === "Finished") {
        appendMessage(`*Download complete. Installing update…*`, "system");
      }
    });
    // Tauri attempts to relaunch automatically after a successful install
  } catch (err) {
    console.error("[checkForUpdates] Download/install failed:", err);
    appendMessage(
      `**Update failed.** Could not install v${update.version}. ` +
      `Check your internet connection and try restarting the app.\n\n` +
      `_(Error: ${err instanceof Error ? err.message : String(err)})_`,
      "system",
    );
  }
}

// ── Initial view ──────────────────────────────────────────────────

showView("auth");

// Try to resume a previous session from stored token
loadToken().then(async (token) => {
  if (token) {
    apiBase = serverUrlInput.value.trim() || "http://localhost:3300";
    isGuest = false;
    await checkAuthAndRoute();
  }
}).catch((err) => {
  console.error("[init] Failed to load stored token:", err);
});

// Check for updates on launch (non-blocking; failures are logged to console only)
checkForUpdates().catch((err) => {
  console.error("[checkForUpdates] Unhandled rejection:", err);
});
