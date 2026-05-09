import { SlashCommandBuilder, type RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";

function createCommand<const TName extends string>(name: TName, description: string) {
  if (name.length < 1 || name.length > 32) {
    throw new Error(`Invalid slash command name length for "${name}": ${name.length} (must be 1-32)`);
  }
  if (!/^[\w-]{1,32}$/.test(name) || name !== name.toLowerCase()) {
    throw new Error(
      `Invalid slash command name "${name}" (must be lowercase and match /^[\\w-]{1,32}$/)`,
    );
  }
  if (description.length < 1 || description.length > 100) {
    throw new Error(
      `Invalid slash command description length for "${name}": ${description.length} (must be 1-100)`,
    );
  }

  return {
    name,
    builder: new SlashCommandBuilder().setName(name).setDescription(description),
  };
}

const commandBuilders = [
  createCommand("play", "Open or resume your MUDdown Discord DM session"),
  createCommand("who", "Show the current Discord bridge session status"),
  createCommand("switch", "Return to character selection for the current bridge session"),
  createCommand("quit", "Quit the current Discord bridge session"),
] as const;

export const DISCORD_COMMANDS: RESTPostAPIChatInputApplicationCommandsJSONBody[] =
  commandBuilders.map(({ builder }) => builder.toJSON());

export type SupportedDiscordCommand = (typeof commandBuilders)[number]["name"];

const supportedDiscordCommands = new Set<SupportedDiscordCommand>(
  commandBuilders.map(({ name }) => name),
);

export function isSupportedDiscordCommand(name: string): name is SupportedDiscordCommand {
  return supportedDiscordCommands.has(name as SupportedDiscordCommand);
}

export function noSessionMessage(): string {
  return [
    "No active Discord bridge session.",
    "Use `/play` to link your account and start gameplay in DMs.",
  ].join("\n");
}

export function unsupportedInteractionMessage(): string {
  return "Unsupported Discord interaction type.";
}