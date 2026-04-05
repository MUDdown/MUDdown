import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import type { NpcDefinition } from "@muddown/shared";

// ─── Configuration ───────────────────────────────────────────────────────────

export type LlmProvider = "anthropic" | "none";

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
}

/** Read LLM configuration from environment variables. */
export function getLlmConfig(): LlmConfig {
  const raw = process.env.LLM_PROVIDER ?? "";
  // Auto-detect: if ANTHROPIC_API_KEY is set but LLM_PROVIDER isn't, infer anthropic
  const provider: LlmProvider =
    raw === "anthropic" || (!raw && process.env.ANTHROPIC_API_KEY) ? "anthropic" : "none";
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.warn("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set — falling back to static dialogue");
      return { provider: "none", model: "" };
    }
    const model = process.env.LLM_MODEL ?? "claude-haiku-4-5-20251001";
    return { provider, model };
  }
  return { provider: "none", model: "" };
}

/** Returns true if an LLM provider is configured and ready. */
export function isLlmConfigured(config: LlmConfig): boolean {
  return config.provider !== "none";
}

// ─── Conversation Types ──────────────────────────────────────────────────────

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PlayerContext {
  playerName: string;
  playerClass: string | null;
  currentRoom: string;
  roomName: string;
  inventory: string[];
}

export interface GeneratedDialogue {
  speech: string;
  mood: string;
  narrative: string;
  responses: string[];
  endConversation: boolean;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const dialogueSchema = z.object({
  speech: z.string().describe("What the NPC says, in character. 1-3 sentences."),
  mood: z.string().describe("Emotional tone of the NPC's speech (e.g., friendly, worried, conspiratorial, angry, amused)"),
  narrative: z.string().describe("A brief third-person action description of what the NPC does while speaking (e.g., 'He leans in and lowers his voice.')"),
  responses: z.array(z.string()).describe("2-4 suggested short player responses (3-10 words each). The last one should always be a way to end the conversation."),
  endConversation: z.boolean().describe("True if this is a natural farewell/ending to the conversation"),
});

// ─── System Prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(npc: NpcDefinition, ctx: PlayerContext): string {
  const lines: string[] = [
    `You are ${npc.name}, an NPC in a text-based fantasy MUD called Northkeep.`,
    "",
    "## Your Character",
    npc.backstory || npc.description,
    "",
    "## Rules",
    `- Stay in character as ${npc.name} at all times.`,
    "- Speak naturally in 1-3 sentences. Do not monologue.",
    "- The speech field is ONLY spoken words — no actions, gestures, or stage directions like *rings bell* or *leans in*. Those belong in the narrative field.",
    "- Your knowledge is limited to what your character would know. Do not reveal game mechanics, other rooms you haven't visited, or meta-game information.",
    "- If the player asks about something you don't know about, say so in character.",
    "- Do not repeat yourself across turns. Vary your phrasing.",
    "- The narrative field is a brief third-person action description (what you physically do while speaking). It must not repeat or paraphrase your speech.",
    "- Always include 2-4 response suggestions. The last response should be a polite way to end the conversation.",
    "- Set endConversation to true only if you are saying goodbye or the conversation has reached a natural end.",
    "",
    "## Current Context",
    `- You are in: ${ctx.roomName}`,
    `- Speaking to: ${ctx.playerName}${ctx.playerClass ? ` (a ${ctx.playerClass})` : ""}`,
  ];

  if (ctx.inventory.length > 0) {
    lines.push(`- The player is carrying: ${ctx.inventory.join(", ")}`);
  }

  if (npc.combat) {
    lines.push("- You are a combatant. If provoked or threatened, you may become hostile in your speech.");
  }

  return lines.join("\n");
}

// ─── Generation ──────────────────────────────────────────────────────────────

const LLM_TIMEOUT = 8_000; // 8 seconds max
export const MAX_HISTORY_MESSAGES = 20;

/**
 * Generate an NPC dialogue response using the configured LLM provider.
 * Returns null on any failure (timeout, API error, invalid response) so the
 * caller can fall back to the static dialogue tree.
 */
export async function generateNpcDialogue(
  config: LlmConfig,
  npc: NpcDefinition,
  ctx: PlayerContext,
  history: ConversationMessage[],
  playerMessage: string | null,
): Promise<GeneratedDialogue | null> {
  if (!isLlmConfigured(config)) return null;

  const system = buildSystemPrompt(npc, ctx);

  // Build message history for the LLM
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  const trimmedHistory = history.slice(-MAX_HISTORY_MESSAGES);
  for (const msg of trimmedHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  if (playerMessage !== null) {
    messages.push({ role: "user", content: playerMessage });
  } else {
    // Initial greeting — prompt the NPC to introduce themselves
    messages.push({ role: "user", content: `[A ${ctx.playerClass ?? "traveller"} named ${ctx.playerName} approaches and wants to talk to you.]` });
  }

  try {
    const provider = createProvider(config);
    const { object } = await generateObject({
      model: provider(config.model),
      schema: dialogueSchema,
      system,
      messages,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT),
    });

    // Validate minimum response quality
    if (!object.speech || object.responses.length < 2) {
      console.warn(`LLM returned low-quality dialogue for NPC "${npc.id}" — falling back to static`);
      return null;
    }

    return object;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.warn(`LLM timeout for NPC "${npc.id}" after ${LLM_TIMEOUT}ms — falling back to static dialogue`);
    } else {
      console.error(`LLM error for NPC "${npc.id}":`, err instanceof Error ? err.message : err);
    }
    return null;
  }
}

// ─── Provider Factory ────────────────────────────────────────────────────────

function createProvider(config: LlmConfig) {
  switch (config.provider) {
    case "anthropic":
      return createAnthropic();
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}
