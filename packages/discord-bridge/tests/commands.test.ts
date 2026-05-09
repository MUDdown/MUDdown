import { describe, expect, it } from "vitest";
import {
  DISCORD_COMMANDS,
  isSupportedDiscordCommand,
  noSessionMessage,
  unsupportedInteractionMessage,
} from "../src/commands.js";

describe("DISCORD_COMMANDS", () => {
  it("registers the expected slash commands", () => {
    expect(DISCORD_COMMANDS.map((command) => command.name)).toEqual([
      "play",
      "who",
      "switch",
      "quit",
    ]);
  });

  it("registers non-empty descriptions within Discord limits", () => {
    for (const command of DISCORD_COMMANDS) {
      const length = command.description.length;
      const message = `Command ${command.name} has invalid description length: ${length} (must be 1-100)`;
      expect(length > 0 && length <= 100, message).toBe(true);
    }
  });

  it("recognizes registered command names", () => {
    for (const command of DISCORD_COMMANDS) {
      expect(isSupportedDiscordCommand(command.name), command.name).toBe(true);
    }
  });

  it("rejects unknown command names", () => {
    expect(isSupportedDiscordCommand("hack")).toBe(false);
  });
});

describe("bridge status messages", () => {
  it("returns a no-session message", () => {
    expect(noSessionMessage()).toContain("No active Discord bridge session");
    expect(noSessionMessage()).toContain("/play");
  });

  it("returns a placeholder for unsupported component interactions", () => {
    expect(unsupportedInteractionMessage()).toContain("Unsupported Discord interaction type");
  });
});