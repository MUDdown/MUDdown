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
    const res = await fetch(`${apiBase}/auth/me`, { credentials: "include" });
    if (!res.ok) { showView("auth"); return; }
    const me = await res.json();
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
    const res = await fetch(`${apiBase}/auth/characters`, { credentials: "include" });
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
      credentials: "include",
      headers: { "Content-Type": "application/json" },
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
      credentials: "include",
      headers: { "Content-Type": "application/json" },
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
    const res = await fetch(`${apiBase}/auth/ws-ticket`, {
      credentials: "include",
    });
    if (res.ok) {
      const { ticket } = await res.json();
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

document.getElementById("login-play-btn")!.addEventListener("click", () => {
  apiBase = serverUrlInput.value.trim() || "http://localhost:3300";
  isGuest = false;
  checkAuthAndRoute();
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

// ── Initial view ──────────────────────────────────────────────────

showView("auth");
