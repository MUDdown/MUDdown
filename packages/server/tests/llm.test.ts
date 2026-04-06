import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NpcDefinition } from "@muddown/shared";

// Mock the AI SDK before importing llm.ts
vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => vi.fn((model: string) => ({ modelId: model }))),
}));

import { generateObject } from "ai";
import {
  getLlmConfig,
  isLlmConfigured,
  generateNpcDialogue,
  generateHint,
  generateRoomDescription,
} from "../src/llm.js";
import type {
  ConversationMessage,
  PlayerContext,
  GeneratedDialogue,
  HintContext,
  GeneratedHint,
  RoomDescriptionContext,
  GeneratedRoomDescription,
} from "../src/llm.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeNpc(overrides: Partial<NpcDefinition> = {}): NpcDefinition {
  return {
    id: "crier",
    name: "Town Crier",
    description: "A stout man in a feathered cap.",
    location: "town-square",
    dialogue: {
      start: {
        text: "Hear ye!",
        mood: "enthusiastic",
        responses: [{ text: "Hi", next: null }],
      },
    },
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PlayerContext> = {}): PlayerContext {
  return {
    playerName: "Tester",
    playerClass: "warrior",
    currentRoom: "town-square",
    roomName: "Town Square",
    inventory: [],
    ...overrides,
  };
}

const GOOD_RESPONSE: GeneratedDialogue = {
  speech: "Hello there, traveller!",
  mood: "friendly",
  narrative: "The crier waves his bell.",
  responses: ["Tell me more.", "Goodbye."],
  endConversation: false,
};

// ─── getLlmConfig ────────────────────────────────────────────────────────────

describe("getLlmConfig", () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    envBackup.LLM_PROVIDER = process.env.LLM_PROVIDER;
    envBackup.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    envBackup.LLM_MODEL = process.env.LLM_MODEL;
  });

  afterEach(() => {
    process.env.LLM_PROVIDER = envBackup.LLM_PROVIDER;
    process.env.ANTHROPIC_API_KEY = envBackup.ANTHROPIC_API_KEY;
    process.env.LLM_MODEL = envBackup.LLM_MODEL;
  });

  it("returns 'none' when LLM_PROVIDER is not set and no API key", () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    const config = getLlmConfig();
    expect(config.provider).toBe("none");
    expect(config.model).toBe("");
  });

  it("auto-detects anthropic when ANTHROPIC_API_KEY is set without LLM_PROVIDER", () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_MODEL;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const config = getLlmConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-haiku-4-5-20251001");
  });

  it("returns 'none' when LLM_PROVIDER is explicitly 'none'", () => {
    process.env.LLM_PROVIDER = "none";
    const config = getLlmConfig();
    expect(config.provider).toBe("none");
  });

  it("configures anthropic with default model", () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    delete process.env.LLM_MODEL;
    const config = getLlmConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-haiku-4-5-20251001");
  });

  it("honours LLM_MODEL override", () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.LLM_MODEL = "claude-haiku-3";
    const config = getLlmConfig();
    expect(config.model).toBe("claude-haiku-3");
  });

  it("falls back to 'none' when API key is missing", () => {
    process.env.LLM_PROVIDER = "anthropic";
    delete process.env.ANTHROPIC_API_KEY;
    const config = getLlmConfig();
    expect(config.provider).toBe("none");
  });
});

// ─── isLlmConfigured ────────────────────────────────────────────────────────

describe("isLlmConfigured", () => {
  it("returns false for provider 'none'", () => {
    expect(isLlmConfigured({ provider: "none", model: "" })).toBe(false);
  });

  it("returns true for provider 'anthropic'", () => {
    expect(isLlmConfigured({ provider: "anthropic", model: "claude-sonnet-4-20250514" })).toBe(true);
  });
});

// ─── generateNpcDialogue ─────────────────────────────────────────────────────

describe("generateNpcDialogue", () => {
  const anthropicConfig = { provider: "anthropic" as const, model: "claude-sonnet-4-20250514" };
  const noneConfig = { provider: "none" as const, model: "" };
  const mockedGenerateObject = vi.mocked(generateObject);

  beforeEach(() => {
    mockedGenerateObject.mockReset();
  });

  it("returns null when provider is 'none'", async () => {
    const result = await generateNpcDialogue(
      noneConfig,
      makeNpc(),
      makeCtx(),
      [],
      null,
    );
    expect(result).toBeNull();
    expect(mockedGenerateObject).not.toHaveBeenCalled();
  });

  it("returns generated dialogue on success", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_RESPONSE,
      toJsonResponse: vi.fn(),
    } as any);

    const result = await generateNpcDialogue(
      anthropicConfig,
      makeNpc({ backstory: "A friendly town crier." }),
      makeCtx(),
      [],
      null,
    );

    expect(result).toEqual(GOOD_RESPONSE);
    expect(mockedGenerateObject).toHaveBeenCalledOnce();
  });

  it("passes endConversation: true through unmodified", async () => {
    const farewellResponse: GeneratedDialogue = {
      ...GOOD_RESPONSE,
      endConversation: true,
      speech: "Farewell, traveller. Safe roads to you.",
    };
    mockedGenerateObject.mockResolvedValueOnce({
      object: farewellResponse,
    } as any);

    const result = await generateNpcDialogue(
      anthropicConfig,
      makeNpc({ backstory: "A friendly town crier." }),
      makeCtx(),
      [],
      "Goodbye",
    );

    expect(result).not.toBeNull();
    expect(result!.endConversation).toBe(true);
    expect(result!.speech).toBe("Farewell, traveller. Safe roads to you.");
  });

  it("passes conversation history and player message to the model", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_RESPONSE,
    } as any);

    const history: ConversationMessage[] = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Greetings!" },
    ];

    await generateNpcDialogue(
      anthropicConfig,
      makeNpc({ backstory: "A crier." }),
      makeCtx(),
      history,
      "What news?",
    );

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.messages).toHaveLength(3);
    expect(call.messages[0]).toEqual({ role: "user", content: "Hello" });
    expect(call.messages[1]).toEqual({ role: "assistant", content: "Greetings!" });
    expect(call.messages[2]).toEqual({ role: "user", content: "What news?" });
  });

  it("generates an intro prompt when playerMessage is null", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_RESPONSE,
    } as any);

    await generateNpcDialogue(
      anthropicConfig,
      makeNpc({ backstory: "A crier." }),
      makeCtx({ playerName: "Ada", playerClass: "mage" }),
      [],
      null,
    );

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].content).toContain("Ada");
    expect(call.messages[0].content).toContain("mage");
  });

  it("uses 'traveller' in intro prompt when playerClass is null", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_RESPONSE,
    } as any);

    await generateNpcDialogue(
      anthropicConfig,
      makeNpc({ backstory: "A crier." }),
      makeCtx({ playerClass: null }),
      [],
      null,
    );

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.messages[0].content).toContain("traveller");
  });

  it("returns null on API error", async () => {
    mockedGenerateObject.mockRejectedValueOnce(new Error("API rate limit"));

    const result = await generateNpcDialogue(
      anthropicConfig,
      makeNpc({ backstory: "A crier." }),
      makeCtx(),
      [],
      "Hello",
    );

    expect(result).toBeNull();
  });

  it("returns null on timeout (TimeoutError)", async () => {
    const timeoutError = new DOMException("signal timed out", "TimeoutError");
    mockedGenerateObject.mockRejectedValueOnce(timeoutError);

    const result = await generateNpcDialogue(
      anthropicConfig,
      makeNpc({ backstory: "A crier." }),
      makeCtx(),
      [],
      "Hello",
    );

    expect(result).toBeNull();
  });

  it("returns null when response has empty speech", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { ...GOOD_RESPONSE, speech: "" },
    } as any);

    const result = await generateNpcDialogue(
      anthropicConfig,
      makeNpc({ backstory: "A crier." }),
      makeCtx(),
      [],
      "Hello",
    );

    expect(result).toBeNull();
  });

  it("returns null when response has fewer than 2 responses", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { ...GOOD_RESPONSE, responses: ["Goodbye."] },
    } as any);

    const result = await generateNpcDialogue(
      anthropicConfig,
      makeNpc({ backstory: "A crier." }),
      makeCtx(),
      [],
      "Hello",
    );

    expect(result).toBeNull();
  });

  it("includes inventory in system prompt when player has items", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_RESPONSE,
    } as any);

    await generateNpcDialogue(
      anthropicConfig,
      makeNpc({ backstory: "A crier." }),
      makeCtx({ inventory: ["rusty sword", "bread"] }),
      [],
      "Hello",
    );

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.system).toContain("rusty sword");
    expect(call.system).toContain("bread");
  });

  it("includes NPC name in system prompt", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_RESPONSE,
    } as any);

    await generateNpcDialogue(
      anthropicConfig,
      makeNpc({ name: "Gorath the Smith", backstory: "A blacksmith." }),
      makeCtx(),
      [],
      "Hello",
    );

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.system).toContain("Gorath the Smith");
  });

  it("uses description as fallback when backstory is absent", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_RESPONSE,
    } as any);

    await generateNpcDialogue(
      anthropicConfig,
      makeNpc({ description: "A weathered fisherman with salt-stiff clothes." }),
      makeCtx(),
      [],
      "Hello",
    );

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.system).toContain("A weathered fisherman with salt-stiff clothes.");
  });
});

// ─── generateHint ────────────────────────────────────────────────────────────

describe("generateHint", () => {
  const anthropicConfig = { provider: "anthropic" as const, model: "claude-haiku-4-5-20251001" };
  const noneConfig = { provider: "none" as const, model: "" };
  const mockedGenerateObject = vi.mocked(generateObject);

  function makeHintCtx(overrides: Partial<HintContext> = {}): HintContext {
    return {
      playerName: "Tester",
      playerClass: "warrior",
      roomName: "Town Square",
      roomDescription: "A bustling town square.",
      exits: ["north", "south"],
      npcs: ["Town Crier"],
      roomItems: ["Rusty Key"],
      inventoryItems: ["Bread"],
      inCombat: false,
      hp: 20,
      maxHp: 20,
      ...overrides,
    };
  }

  const GOOD_HINT: GeneratedHint = {
    hint: "The Town Crier might have news for you. Try talking to them!",
    suggestedCommands: ["talk crier", "examine rusty key"],
  };

  beforeEach(() => {
    mockedGenerateObject.mockReset();
  });

  it("returns null when provider is 'none'", async () => {
    const result = await generateHint(noneConfig, makeHintCtx());
    expect(result).toBeNull();
    expect(mockedGenerateObject).not.toHaveBeenCalled();
  });

  it("returns generated hint on success", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_HINT,
    } as any);

    const result = await generateHint(anthropicConfig, makeHintCtx());
    expect(result).toEqual(GOOD_HINT);
    expect(mockedGenerateObject).toHaveBeenCalledOnce();
  });

  it("includes room name and NPCs in system prompt", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_HINT,
    } as any);

    await generateHint(anthropicConfig, makeHintCtx());

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.system).toContain("Town Square");
    expect(call.system).toContain("Town Crier");
  });

  it("includes combat state in system prompt", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_HINT,
    } as any);

    await generateHint(anthropicConfig, makeHintCtx({ inCombat: true }));

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.system).toContain("combat");
  });

  it("includes inventory in system prompt", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_HINT,
    } as any);

    await generateHint(anthropicConfig, makeHintCtx({ inventoryItems: ["Rusty Sword", "Bread"] }));

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.system).toContain("Rusty Sword");
    expect(call.system).toContain("Bread");
  });

  it("returns null on API error", async () => {
    mockedGenerateObject.mockRejectedValueOnce(new Error("API rate limit"));

    const result = await generateHint(anthropicConfig, makeHintCtx());
    expect(result).toBeNull();
  });

  it("returns null on timeout", async () => {
    const timeoutError = new DOMException("signal timed out", "TimeoutError");
    mockedGenerateObject.mockRejectedValueOnce(timeoutError);

    const result = await generateHint(anthropicConfig, makeHintCtx());
    expect(result).toBeNull();
  });

  it("returns null when hint is empty", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { hint: "", suggestedCommands: ["look"] },
    } as any);

    const result = await generateHint(anthropicConfig, makeHintCtx());
    expect(result).toBeNull();
  });

  it("returns successfully when suggestedCommands is empty", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { hint: "Explore the area.", suggestedCommands: [] },
    } as any);

    const result = await generateHint(anthropicConfig, makeHintCtx());
    expect(result).not.toBeNull();
    expect(result!.suggestedCommands).toHaveLength(0);
  });

  it("omits class from system prompt when playerClass is null", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_HINT,
    } as any);

    await generateHint(anthropicConfig, makeHintCtx({ playerClass: null }));

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.system).not.toContain("null");
    expect(call.system).not.toContain("(null)");
  });

  it("caps suggestedCommands at 3 even if LLM returns more", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { hint: "Try everything.", suggestedCommands: ["a", "b", "c", "d", "e"] },
    } as any);

    const result = await generateHint(anthropicConfig, makeHintCtx());
    expect(result).not.toBeNull();
    expect(result!.suggestedCommands).toHaveLength(3);
    expect(result!.suggestedCommands).toEqual(["a", "b", "c"]);
  });

  it("returns null on AI_NoObjectGeneratedError (schema validation failure)", async () => {
    const schemaErr = Object.assign(new Error("No object generated: response did not match schema."), {
      name: "AI_NoObjectGeneratedError",
      cause: new Error("unexpected token"),
    });
    mockedGenerateObject.mockRejectedValueOnce(schemaErr);
    const result = await generateHint(anthropicConfig, makeHintCtx());
    expect(result).toBeNull();
  });

  it("omits exits, NPCs, and items sections when context arrays are empty", async () => {
    mockedGenerateObject.mockResolvedValueOnce({ object: GOOD_HINT } as any);
    await generateHint(anthropicConfig, makeHintCtx({ exits: [], npcs: [], roomItems: [] }));
    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.system).not.toContain("Exits:");
    expect(call.system).not.toContain("NPCs here:");
    expect(call.system).not.toContain("Items on ground:");
  });

  it("omits combat line when player is not in combat", async () => {
    mockedGenerateObject.mockResolvedValueOnce({ object: GOOD_HINT } as any);
    await generateHint(anthropicConfig, makeHintCtx({ inCombat: false }));
    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.system).not.toContain("in combat");
  });
});

// ─── generateRoomDescription ─────────────────────────────────────────────────

describe("generateRoomDescription", () => {
  const anthropicConfig = { provider: "anthropic" as const, model: "claude-haiku-4-5-20251001" };
  const noneConfig = { provider: "none" as const, model: "" };
  const mockedGenerateObject = vi.mocked(generateObject);

  function makeRoomCtx(overrides: Partial<RoomDescriptionContext> = {}): RoomDescriptionContext {
    return {
      roomId: "town-square",
      roomName: "Town Square",
      staticDescription: "A bustling cobblestone square at the heart of Northkeep.",
      lighting: "bright",
      region: "northkeep",
      exits: ["north", "south", "east", "west"],
      playerName: "Tester",
      playerClass: "warrior",
      hp: 20,
      maxHp: 20,
      inventoryItems: [],
      equippedItems: [],
      inCombat: false,
      ...overrides,
    };
  }

  const GOOD_DESC: GeneratedRoomDescription = {
    description: "Tester steps into the bustling cobblestone square. The warrior's eyes sweep across the colorful merchant stalls as the scent of fresh bread fills the air.",
  };

  beforeEach(() => {
    mockedGenerateObject.mockReset();
  });

  it("returns null when provider is 'none'", async () => {
    const result = await generateRoomDescription(noneConfig, makeRoomCtx());
    expect(result).toBeNull();
    expect(mockedGenerateObject).not.toHaveBeenCalled();
  });

  it("returns generated description on success", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_DESC,
    } as any);

    const result = await generateRoomDescription(anthropicConfig, makeRoomCtx());
    expect(result).toEqual(GOOD_DESC);
    expect(mockedGenerateObject).toHaveBeenCalledOnce();
  });

  it("includes static description and player context in system prompt", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_DESC,
    } as any);

    await generateRoomDescription(anthropicConfig, makeRoomCtx({
      playerName: "Ada",
      playerClass: "mage",
    }));

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.system).toContain("A bustling cobblestone square");
    expect(call.system).toContain("Ada");
    expect(call.system).toContain("mage");
  });

  it("includes combat state in system prompt", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_DESC,
    } as any);

    await generateRoomDescription(anthropicConfig, makeRoomCtx({ inCombat: true }));

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.system).toContain("combat");
  });

  it("includes low-health warning in system prompt when HP is below 30%", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_DESC,
    } as any);

    await generateRoomDescription(anthropicConfig, makeRoomCtx({ hp: 4, maxHp: 20 }));

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.system).toContain("badly wounded");
  });

  it("includes equipped items in system prompt", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_DESC,
    } as any);

    await generateRoomDescription(anthropicConfig, makeRoomCtx({
      equippedItems: ["Iron Sword (weapon)", "Leather Armor (armor)"],
    }));

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.system).toContain("Iron Sword (weapon)");
    expect(call.system).toContain("Leather Armor (armor)");
  });

  it("includes inventory items in system prompt", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_DESC,
    } as any);

    await generateRoomDescription(anthropicConfig, makeRoomCtx({
      inventoryItems: ["Health Potion", "Torch"],
    }));

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.system).toContain("Health Potion");
    expect(call.system).toContain("Torch");
  });

  it("returns null on API error", async () => {
    mockedGenerateObject.mockRejectedValueOnce(new Error("API rate limit"));

    const result = await generateRoomDescription(anthropicConfig, makeRoomCtx());
    expect(result).toBeNull();
  });

  it("returns null on timeout", async () => {
    const timeoutError = new DOMException("signal timed out", "TimeoutError");
    mockedGenerateObject.mockRejectedValueOnce(timeoutError);

    const result = await generateRoomDescription(anthropicConfig, makeRoomCtx());
    expect(result).toBeNull();
  });

  it("returns null when description is too short", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { description: "Short." },
    } as any);

    const result = await generateRoomDescription(anthropicConfig, makeRoomCtx());
    expect(result).toBeNull();
  });

  it("returns null when description is exactly 19 chars (boundary below minimum)", async () => {
    const desc = "A".repeat(19); // 19 chars, just under the 20-char threshold
    mockedGenerateObject.mockResolvedValueOnce({
      object: { description: desc },
    } as any);

    const result = await generateRoomDescription(anthropicConfig, makeRoomCtx());
    expect(result).toBeNull();
  });

  it("returns valid result when description is exactly 20 chars (boundary at minimum)", async () => {
    const desc = "A".repeat(20); // 20 chars, exactly at the threshold
    mockedGenerateObject.mockResolvedValueOnce({
      object: { description: desc },
    } as any);

    const result = await generateRoomDescription(anthropicConfig, makeRoomCtx());
    expect(result).not.toBeNull();
    expect(result!.description).toBe(desc);
  });

  it("returns null when description is empty", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: { description: "" },
    } as any);

    const result = await generateRoomDescription(anthropicConfig, makeRoomCtx());
    expect(result).toBeNull();
  });

  it("omits class from system prompt when playerClass is null", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_DESC,
    } as any);

    await generateRoomDescription(anthropicConfig, makeRoomCtx({ playerClass: null }));

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.system).not.toContain("null");
    expect(call.system).not.toContain("(null)");
  });

  it("includes room name in the user message", async () => {
    mockedGenerateObject.mockResolvedValueOnce({
      object: GOOD_DESC,
    } as any);

    await generateRoomDescription(anthropicConfig, makeRoomCtx({ roomName: "Iron Gate" }));

    const call = mockedGenerateObject.mock.calls[0][0] as any;
    expect(call.messages[0].content).toContain("Iron Gate");
  });

  it("returns null on AI_NoObjectGeneratedError (schema validation failure)", async () => {
    const schemaErr = Object.assign(new Error("No object generated: response did not match schema."), {
      name: "AI_NoObjectGeneratedError",
      cause: new Error("unexpected token"),
    });
    mockedGenerateObject.mockRejectedValueOnce(schemaErr);
    const result = await generateRoomDescription(anthropicConfig, makeRoomCtx());
    expect(result).toBeNull();
  });
});
