/**
 * MUDdown Discord Bridge runtime entry.
 *
 * Owns Discord bot lifecycle, account-linked `/play` flow, character
 * selection, and per-user gameplay transport over WebSocket.
 */

import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import type { DiscordBridgeConfig } from "./config.js";
import { SessionRegistry } from "./sessions.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  MessageFlags,
  Partials,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ClientOptions,
  type ClientUser,
  type Message,
  type StringSelectMenuInteraction,
  type User,
} from "discord.js";
import WebSocket from "ws";
import { MUDdownConnection } from "@muddown/client";
import type { ServerMessage } from "@muddown/shared";
import {
  DISCORD_COMMANDS,
  isSupportedDiscordCommand,
  noSessionMessage,
  unsupportedInteractionMessage,
} from "./commands.js";
import type { DiscordSession } from "./sessions.js";
import { LINK_SELECT_CUSTOM_ID, renderEnvelope } from "./render.js";
import { FeedSubscriber } from "./feed-subscriber.js";
import type { FeedChannel } from "./feed-subscriber.js";
import {
  dispatchGameplayCommand,
  formatWhoStatus,
  handleReconnectError,
  handleSocketClose,
  recordActivityIfDispatched,
  recordUserInteraction,
  refreshReconnectTicket,
  resolveGameplayInteractionCommand,
} from "./bridge-policy.js";
import {
  gameplayDeliveryBackoffMs,
  nextDeliveryFailure,
} from "./delivery-policy.js";
import { runIdleSweep } from "./idle-policy.js";
import { ReconnectNotifier } from "./reconnect-notifier.js";

// @ts-expect-error - @muddown/client uses bare new WebSocket() with no import;
// Node runtimes without a global WebSocket need a ws polyfill.
globalThis.WebSocket = WebSocket;

const CHARACTER_SELECT_CUSTOM_ID = "muddown-character-select";
const TOKEN_POLL_ATTEMPTS = 60;
const TOKEN_POLL_INTERVAL_MS = 2000;
const REQUEST_TIMEOUT_MS = 5000;
const PICKER_TIMEOUT_MS = 5 * 60 * 1000;

interface AuthMeResponse {
  id: string;
  displayName: string;
}

interface CharacterEntry {
  id: string;
  name: string;
  characterClass: string;
  hp?: number;
  maxHp?: number;
  xp?: number;
  currentRoom?: string;
}

interface PendingCharacterSelection {
  sessionToken: string;
  accountId: string;
  characters: CharacterEntry[];
  timeout: ReturnType<typeof setTimeout>;
}

function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled ${context}: ${String(value)}`);
}

export function wsToHttpBase(wsUrl: `ws://${string}` | `wss://${string}`): string {
  if (wsUrl.startsWith("wss://")) return `https://${wsUrl.slice(6)}`.replace(/\/ws\/?$/, "");
  return `http://${wsUrl.slice(5)}`.replace(/\/ws\/?$/, "");
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

class BridgeLifecycle {
  private isShuttingDown = false;
  private client: Client | undefined;
  private config: DiscordBridgeConfig | undefined;
  private readonly sessions = new SessionRegistry();
  private readonly connections = new Map<string, MUDdownConnection>();
  private readonly pendingSelections = new Map<string, PendingCharacterSelection>();
  private readonly deliveryFailureStreak = new Map<string, number>();
  private readonly reconnectNotifier = new ReconnectNotifier();
  private idleSweepTimer: ReturnType<typeof setInterval> | undefined;
  private feedSubscriber: FeedSubscriber | undefined;

  async main(): Promise<void> {
    if (this.isShuttingDown || this.client) return;

    const config = loadConfig();
    this.config = config;
    this.isShuttingDown = false;

    const client = new Client(this.createClientOptions());
    this.client = client;
    this.registerEventHandlers(client);

    // eslint-disable-next-line no-console
    console.log(
      `[muddown-discord-bridge] starting (server=${config.serverUrl}, guild=${config.guildId ?? "<global>"})`,
    );

    this.startIdleSweep();

    try {
      await client.login(config.botToken);
    } catch (error) {
      this.stopIdleSweep();
      this.client = undefined;
      this.config = undefined;
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.stopIdleSweep();
    this.clearPendingSelections();
    this.disposeConnections();
    this.deliveryFailureStreak.clear();
    this.reconnectNotifier.clear();
    if (this.feedSubscriber) {
      this.feedSubscriber.stop();
      this.feedSubscriber = undefined;
    }
    const clearedSessions = this.sessions.clear();
    if (clearedSessions > 0) {
      // eslint-disable-next-line no-console
      console.log(`[muddown-discord-bridge] cleared ${clearedSessions} session(s) during shutdown`);
    }
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    client.removeAllListeners();
    await client.destroy();
  }

  reset(): void {
    this.isShuttingDown = false;
    this.stopIdleSweep();
    this.clearPendingSelections();
    this.disposeConnections();
    this.deliveryFailureStreak.clear();
    this.reconnectNotifier.clear();
    if (this.feedSubscriber) {
      this.feedSubscriber.stop();
      this.feedSubscriber = undefined;
    }
    this.client = undefined;
    this.config = undefined;
    const clearedSessions = this.sessions.clear();
    if (clearedSessions > 0) {
      // eslint-disable-next-line no-console
      console.log(`[muddown-discord-bridge] cleared ${clearedSessions} session(s) during reset`);
    }
  }

  private createClientOptions(): ClientOptions {
    return {
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    };
  }

  private registerEventHandlers(client: Client): void {
    client.once(Events.ClientReady, (readyClient) => {
      this.handleReady(readyClient).catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[muddown-discord-bridge] ready handler failed:", error);
        process.exit(1);
      });
    });
    client.on(Events.InteractionCreate, (interaction) => {
      this.handleInteraction(interaction).catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[muddown-discord-bridge] interaction handler failed:", error);
      });
    });
    client.on(Events.MessageCreate, (message) => {
      this.handleMessage(message).catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[muddown-discord-bridge] message handler failed:", error);
      });
    });
    client.on(Events.Error, (error) => {
      // eslint-disable-next-line no-console
      console.error("[muddown-discord-bridge] discord client error:", error);
    });
  }

  private async handleReady(client: Client<true>): Promise<void> {
    const scope = this.config?.guildId ?? "global";
    try {
      if (this.config?.guildId) {
        await client.application.commands.set(DISCORD_COMMANDS, this.config.guildId);
      } else {
        await client.application.commands.set(DISCORD_COMMANDS);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[muddown-discord-bridge] slash command registration failed (scope=${scope}):`,
        error,
        "\nCheck: bot has applications.commands scope; MUDDOWN_DISCORD_GUILD_ID is valid if set.",
      );
      throw error;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[muddown-discord-bridge] logged in as ${formatUserTag(client.user)}; registered ${DISCORD_COMMANDS.length} slash commands (${scope})`,
    );

    await this.startFeedSubscriber(client);
  }

  private async startFeedSubscriber(client: Client<true>): Promise<void> {
    const config = this.config;
    if (!config?.feedChannelId) return;
    let channel: Awaited<ReturnType<typeof client.channels.fetch>>;
    try {
      channel = await client.channels.fetch(config.feedChannelId);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[muddown-discord-bridge] feed channel fetch failed (id=${config.feedChannelId}) — feed channel is DISABLED until bot restart:`,
        error,
      );
      return;
    }
    if (channel === null) {
      // eslint-disable-next-line no-console
      console.error(
        `[muddown-discord-bridge] feed channel ${config.feedChannelId} not found or inaccessible (bot lacks View Channel?) — feed channel is DISABLED until bot restart`,
      );
      return;
    }
    if (!channel.isTextBased() || !channel.isSendable()) {
      // eslint-disable-next-line no-console
      console.error(
        `[muddown-discord-bridge] feed channel ${config.feedChannelId} is not a text-sendable channel (got type ${channel.type}) — feed channel is DISABLED until bot restart`,
      );
      return;
    }
    const sendable: FeedChannel = channel;
    this.feedSubscriber = new FeedSubscriber({
      serverUrl: config.serverUrl,
      channel: sendable,
    });
    this.feedSubscriber.start();
    // eslint-disable-next-line no-console
    console.log(`[muddown-discord-bridge] feed subscriber started (channel=${config.feedChannelId})`);
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (!interaction.isRepliable()) return;

    if (interaction.isChatInputCommand()) {
      await this.handleChatInputCommand(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      await this.handleSelectMenuInteraction(interaction);
      return;
    }

    if (interaction.isButton()) {
      await this.handleButtonInteraction(interaction);
      return;
    }

    await interaction.reply({
      content: unsupportedInteractionMessage(),
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleChatInputCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!isSupportedDiscordCommand(interaction.commandName)) {
      // eslint-disable-next-line no-console
      console.error(
        `[muddown-discord-bridge] unsupported slash command received: ${interaction.commandName}`,
      );
      await interaction.reply({
        content: "Unsupported Discord slash command.",
        flags: interaction.channel?.isDMBased() ? undefined : MessageFlags.Ephemeral,
      });
      return;
    }

    const command = interaction.commandName;
    switch (command) {
      case "play": {
        await this.handlePlayCommand(interaction);
        return;
      }
      case "who": {
        await this.handleWhoCommand(interaction);
        return;
      }
      case "switch": {
        await this.handleSwitchCommand(interaction);
        return;
      }
      case "quit": {
        await this.handleQuitCommand(interaction);
        return;
      }
      default:
        assertNever(command, "discord command");
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    try {
      if (message.author.bot || !message.channel.isDMBased()) return;
      const content = message.content.trim();
      if (!content) return;

      const session = this.sessions.get(message.author.id);
      const connection = this.connections.get(message.author.id);
      if (!session || !connection) {
        await message.reply(noSessionMessage());
        return;
      }

      const sent = connection.send(content);
      if (!sent) {
        await message.reply("Your bridge session is not connected. Use `/play` to start a new session.");
        this.closeSession(message.author.id, false);
        return;
      }
      recordActivityIfDispatched(message.author.id, sent, this.sessions, (id) => {
        // eslint-disable-next-line no-console
        console.error(
          `[muddown-discord-bridge] touch() returned false for ${id} after successful DM send`,
        );
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[muddown-discord-bridge] dm reply failed:", error);
    }
  }

  private async handlePlayCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const activeSession = this.sessions.get(interaction.user.id);
    const activeConnection = this.connections.get(interaction.user.id);
    if (activeSession && activeConnection) {
      await interaction.reply({
        content: "You already have an active Discord bridge session. Use `/who` for status or `/quit` to disconnect.",
        flags: interaction.channel?.isDMBased() ? undefined : MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply(
      interaction.channel?.isDMBased() ? undefined : { flags: MessageFlags.Ephemeral },
    );

    try {
      await interaction.user.createDM();
    } catch {
      await interaction.editReply("I couldn't DM you. Enable direct messages from this server and try again.");
      return;
    }

    await interaction.editReply(
      interaction.channel?.isDMBased()
        ? "Starting account-link flow in this DM."
        : "Check your DMs to continue account linking and character selection.",
    );
    void this.startPlayFlow(interaction.user).catch(async (error) => {
      // eslint-disable-next-line no-console
      console.error("[muddown-discord-bridge] play flow failed:", error);
      try {
        await this.sendDirectMessage(
          interaction.user.id,
          "Failed to start gameplay session. Run `/play` again.",
        );
      } catch (dmError) {
        // eslint-disable-next-line no-console
        console.error("[muddown-discord-bridge] play flow fallback DM failed:", dmError);
      }
    });
  }

  private async handleWhoCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const session = this.sessions.get(interaction.user.id);
    const connection = this.connections.get(interaction.user.id);
    if (!session || !connection) {
      await interaction.reply({
        content: noSessionMessage(),
        flags: interaction.channel?.isDMBased() ? undefined : MessageFlags.Ephemeral,
      });
      return;
    }

    const content = formatWhoStatus({
      characterId: session.characterId,
      startedAtMs: session.startedAt.getTime(),
      lastActivityAtMs: session.lastActivityAt.getTime(),
      connected: connection.connected,
      idleTimeoutMs: this.requireConfig().tunables.idleTimeoutMs,
    });
    // Refresh activity *after* snapshotting timestamps so /who reports the prior
    // last-activity age (touching first would always read 0s).
    recordUserInteraction(interaction.user.id, this.sessions);
    await interaction.reply({
      content,
      flags: interaction.channel?.isDMBased() ? undefined : MessageFlags.Ephemeral,
    });
  }

  private async handleSwitchCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const session = this.sessions.get(interaction.user.id);
    if (!session) {
      await interaction.reply({
        content: noSessionMessage(),
        flags: interaction.channel?.isDMBased() ? undefined : MessageFlags.Ephemeral,
      });
      return;
    }

    recordUserInteraction(interaction.user.id, this.sessions);
    await interaction.deferReply(
      interaction.channel?.isDMBased() ? undefined : { flags: MessageFlags.Ephemeral },
    );

    const characters = await this.fetchCharacters(session.sessionToken);
    if (characters === null) {
      await interaction.editReply("Failed to load characters. Try `/switch` again.");
      return;
    }

    if (characters.length === 0) {
      await interaction.editReply("No characters found for your linked account.");
      return;
    }

    try {
      await this.presentCharacterSelection(
        interaction.user.id,
        session.sessionToken,
        session.accountId,
        characters,
      );
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[muddown-discord-bridge] failed to present character picker:", error);
      await interaction.editReply("Failed to open character selection. Try `/switch` again.");
      return;
    }

    await interaction.editReply(
      interaction.channel?.isDMBased()
        ? "Choose a character from the select menu below."
        : "Check your DMs to choose a character.",
    );
  }

  private async handleQuitCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const session = this.sessions.get(interaction.user.id);
    if (!session) {
      await interaction.reply({
        content: noSessionMessage(),
        flags: interaction.channel?.isDMBased() ? undefined : MessageFlags.Ephemeral,
      });
      return;
    }

    this.closeSession(interaction.user.id, false);
    await interaction.reply({
      content: "Discord bridge session closed.",
      flags: interaction.channel?.isDMBased() ? undefined : MessageFlags.Ephemeral,
    });
  }

  private async handleSelectMenuInteraction(interaction: StringSelectMenuInteraction): Promise<void> {
    if (interaction.customId === LINK_SELECT_CUSTOM_ID) {
      await this.handleGameplaySelectInteraction(interaction);
      return;
    }

    if (interaction.customId !== CHARACTER_SELECT_CUSTOM_ID) {
      await interaction.reply({
        content: unsupportedInteractionMessage(),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const pending = this.pendingSelections.get(interaction.user.id);
    if (!pending) {
      await interaction.reply({
        content: "No pending character selection. Use `/play` or `/switch` first.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const selectedCharacterId = interaction.values[0];
    const selected = pending.characters.find((character) => character.id === selectedCharacterId);
    if (!selected) {
      await interaction.reply({
        content: "That character is no longer available. Run `/switch` again.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Touch the existing session (if any) so the user-initiated pick counts as activity
    // even if `activateCharacterAndConnect` takes a moment to replace it.
    recordUserInteraction(interaction.user.id, this.sessions);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    this.clearPendingSelection(interaction.user.id);
    try {
      await this.activateCharacterAndConnect(
        interaction.user.id,
        pending.accountId,
        pending.sessionToken,
        selected,
      );
      await interaction.editReply(`Connected as **${selected.name}** (${selected.characterClass}).`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[muddown-discord-bridge] character selection failed:", error);
      await interaction.editReply("Failed to start gameplay session. Use `/play` to try again.");
    }
  }

  private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const command = resolveGameplayInteractionCommand(interaction.customId, []);
    if (!command) {
      await interaction.reply({
        content: unsupportedInteractionMessage(),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      await interaction.deferUpdate();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[muddown-discord-bridge] button deferUpdate failed:", error);
      try {
        await interaction.reply({
          content: "Button action could not be acknowledged. Try again.",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // Ignore follow-up failure when the interaction is already expired or acknowledged.
      }
      return;
    }

    const sent = this.sendGameplayCommand(interaction.user.id, command);
    if (!sent) {
      await interaction.followUp({
        content: noSessionMessage(),
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private async handleGameplaySelectInteraction(interaction: StringSelectMenuInteraction): Promise<void> {
    const command = resolveGameplayInteractionCommand(interaction.customId, interaction.values);
    if (!command) {
      await interaction.reply({
        content: "Selected action is invalid or expired.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      await interaction.deferUpdate();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[muddown-discord-bridge] select deferUpdate failed:", error);
      try {
        await interaction.reply({
          content: "Selected action could not be acknowledged. Try again.",
          flags: MessageFlags.Ephemeral,
        });
      } catch {
        // Ignore follow-up failure when the interaction is already expired or acknowledged.
      }
      return;
    }

    const sent = this.sendGameplayCommand(interaction.user.id, command);
    if (!sent) {
      await interaction.followUp({
        content: noSessionMessage(),
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private async startPlayFlow(user: User): Promise<void> {
    const nonce = randomUUID();
    const loginUrl = this.buildDiscordLoginUrl(nonce);

    await this.sendDirectMessage(
      user.id,
      [
        "Start by linking your MUDdown account:",
        loginUrl,
        "",
        "After login completes in your browser, this DM will continue automatically.",
      ].join("\n"),
    );

    const sessionToken = await this.pollForToken(nonce);
    if (!sessionToken) {
      await this.sendDirectMessage(
        user.id,
        "Login did not complete in time. Run `/play` to start again.",
      );
      return;
    }

    const me = await this.fetchMe(sessionToken);
    if (!me) {
      await this.sendDirectMessage(user.id, "Failed to verify linked account. Run `/play` to try again.");
      return;
    }

    const characters = await this.fetchCharacters(sessionToken);
    if (characters === null) {
      await this.sendDirectMessage(
        user.id,
        "Failed to load characters for your linked account. Run `/play` again.",
      );
      return;
    }

    if (characters.length === 0) {
      await this.sendDirectMessage(
        user.id,
        "Your linked account has no characters yet. Create one in the web client, then run `/play` again.",
      );
      return;
    }

    if (characters.length === 1) {
      await this.activateCharacterAndConnect(user.id, me.id, sessionToken, characters[0]);
      await this.sendDirectMessage(
        user.id,
        `Connected as **${characters[0].name}** (${characters[0].characterClass}).`,
      );
      return;
    }

    try {
      await this.presentCharacterSelection(user.id, sessionToken, me.id, characters);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[muddown-discord-bridge] failed to send character picker:", error);
      await this.sendDirectMessage(
        user.id,
        "Failed to send character selection. Run `/play` again.",
      );
    }
  }

  private async presentCharacterSelection(
    discordUserId: string,
    sessionToken: string,
    accountId: string,
    characters: CharacterEntry[],
  ): Promise<void> {
    this.clearPendingSelection(discordUserId);

    const timeout = setTimeout(() => {
      this.clearPendingSelection(discordUserId);
      this.sendDirectMessage(
        discordUserId,
        "Character selection expired. Run `/play` or `/switch` again.",
      ).catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[muddown-discord-bridge] expiration DM failed:", error);
      });
    }, PICKER_TIMEOUT_MS);

    this.pendingSelections.set(discordUserId, {
      sessionToken,
      accountId,
      characters,
      timeout,
    });

    const menu = new StringSelectMenuBuilder()
      .setCustomId(CHARACTER_SELECT_CUSTOM_ID)
      .setPlaceholder("Choose a character")
      .addOptions(
        characters.slice(0, 25).map((character) => ({
          label: `${character.name} (${character.characterClass})`.slice(0, 100),
          value: character.id,
        })),
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

    let user;
    try {
      user = await this.client?.users.fetch(discordUserId);
    } catch (error) {
      throw new Error(`DM channel unavailable for character selection: ${String(error)}`);
    }
    if (!user) {
      throw new Error("DM channel unavailable for character selection: client returned no user");
    }

    await user.send({
      content: "Select the character to play:",
      components: [row],
    });
  }

  private async activateCharacterAndConnect(
    discordUserId: string,
    accountId: string,
    sessionToken: string,
    character: CharacterEntry,
  ): Promise<void> {
    const selected = await this.selectCharacter(sessionToken, character.id);
    if (!selected) {
      throw new Error("select-character failed");
    }

    const ticket = await this.fetchWsTicket(sessionToken);
    if (!ticket) {
      throw new Error("ws-ticket fetch failed");
    }

    const connection = new MUDdownConnection(
      {
        wsUrl: this.requireConfig().serverUrl,
        autoReconnect: true,
      },
      {
        onOpen: () => {
          if (this.reconnectNotifier.markConnected(discordUserId)) {
            this.sendDirectMessage(
              discordUserId,
              "Reconnected to MUDdown. Your session is live again.",
            ).catch((error) => {
              // eslint-disable-next-line no-console
              console.error(
                `[muddown-discord-bridge] failed to send reconnected DM to ${discordUserId}:`,
                error,
              );
            });
          }
        },
        onMessage: (_muddown, _type, raw) => {
          this.sendRenderedEnvelope(discordUserId, raw).catch((error) => {
            // eslint-disable-next-line no-console
            console.error("[muddown-discord-bridge] failed to deliver gameplay message:", error);
          });
        },
        onClose: (willReconnect) => {
          if (willReconnect && this.reconnectNotifier.markReconnecting(discordUserId)) {
            this.sendDirectMessage(
              discordUserId,
              "Connection to MUDdown lost — attempting to reconnect...",
            ).catch((error) => {
              // eslint-disable-next-line no-console
              console.error(
                `[muddown-discord-bridge] failed to send reconnecting DM to ${discordUserId}:`,
                error,
              );
            });
          }
          handleSocketClose(discordUserId, willReconnect, (id, notify) => this.closeSession(id, notify));
        },
        onError: (event) => {
          // eslint-disable-next-line no-console
          console.error("[muddown-discord-bridge] websocket error:", event);
        },
        onReconnecting: async () => {
          try {
            return await refreshReconnectTicket(discordUserId, this.sessions, (sessionToken) =>
              this.fetchWsTicket(sessionToken),
            );
          } catch (error) {
            // eslint-disable-next-line no-console
            console.error("[muddown-discord-bridge] failed to refresh reconnect ticket:", error);
            throw error;
          }
        },
        onReconnectError: (error) => {
          // eslint-disable-next-line no-console
          console.error("[muddown-discord-bridge] websocket reconnect failed:", error);
          handleReconnectError(discordUserId, (id, notify) => this.closeSession(id, notify));
        },
        onParseError: (data, error) => {
          // eslint-disable-next-line no-console
          console.error("[muddown-discord-bridge] parse error:", { data, error });
        },
      },
    );

    this.closeSession(discordUserId, false);

    this.connections.set(discordUserId, connection);
    const now = new Date();
    this.sessions.open({
      discordUserId,
      accountId,
      sessionToken,
      characterId: character.id,
      startedAt: now,
      lastActivityAt: now,
    });

    connection.connect(ticket);
  }

  private closeSession(discordUserId: string, notify: boolean): void {
    this.clearPendingSelection(discordUserId);
    this.deliveryFailureStreak.delete(discordUserId);
    this.reconnectNotifier.forget(discordUserId);

    const connection = this.connections.get(discordUserId);
    if (connection) {
      this.connections.delete(discordUserId);
      connection.dispose();
    }

    // SessionRegistry.close() is idempotent; only the first close returns true.
    if (this.sessions.close(discordUserId) && notify) {
      this.sendDirectMessage(
        discordUserId,
        "Your gameplay session ended. Use `/play` to reconnect.",
      ).catch((error) => {
        // eslint-disable-next-line no-console
        console.error(
          `[muddown-discord-bridge] failed to send disconnect notification to ${discordUserId}:`,
          error,
        );
      });
    }
  }

  private sendGameplayCommand(discordUserId: string, command: string): boolean {
    const sent = dispatchGameplayCommand(
      discordUserId,
      command,
      this.sessions,
      this.connections,
      (id) => this.closeSession(id, false),
    );
    return recordActivityIfDispatched(discordUserId, sent, this.sessions, (id) => {
      // eslint-disable-next-line no-console
      console.error(
        `[muddown-discord-bridge] touch() returned false for ${id} after successful gameplay dispatch`,
      );
    });
  }

  private startIdleSweep(): void {
    if (this.idleSweepTimer) return;
    const { idleTimeoutMs, idleCheckIntervalMs } = this.requireConfig().tunables;
    this.idleSweepTimer = setInterval(() => {
      runIdleSweep(
        Date.now(),
        this.sessions.values(),
        idleTimeoutMs,
        (discordUserId) => {
          // eslint-disable-next-line no-console
          console.log(
            `[muddown-discord-bridge] evicting idle session ${discordUserId} (>=${idleTimeoutMs}ms)`,
          );
          this.closeSession(discordUserId, true);
        },
        (discordUserId, error) => {
          // eslint-disable-next-line no-console
          console.error(
            `[muddown-discord-bridge] idle sweep: failed to close ${discordUserId}:`,
            error,
          );
        },
      );
    }, idleCheckIntervalMs);
    if (typeof this.idleSweepTimer.unref === "function") {
      this.idleSweepTimer.unref();
    }
  }

  private stopIdleSweep(): void {
    if (!this.idleSweepTimer) return;
    clearInterval(this.idleSweepTimer);
    this.idleSweepTimer = undefined;
  }

  private disposeConnections(): void {
    for (const connection of this.connections.values()) {
      connection.dispose();
    }
    this.connections.clear();
  }

  private clearPendingSelections(): void {
    for (const pending of this.pendingSelections.values()) {
      clearTimeout(pending.timeout);
    }
    this.pendingSelections.clear();
  }

  private clearPendingSelection(discordUserId: string): void {
    const pending = this.pendingSelections.get(discordUserId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingSelections.delete(discordUserId);
  }

  private toDiscordButtonStyle(style: number): ButtonStyle {
    switch (style) {
      case 1:
        return ButtonStyle.Primary;
      case 2:
        return ButtonStyle.Secondary;
      case 3:
        return ButtonStyle.Success;
      case 4:
        return ButtonStyle.Danger;
      case 5:
        // Link buttons require a URL instead of customId; keep interaction buttons non-link.
        // eslint-disable-next-line no-console
        console.warn("[muddown-discord-bridge] unsupported link-style interaction button; using secondary", { style });
        return ButtonStyle.Secondary;
      default:
        // eslint-disable-next-line no-console
        console.warn("[muddown-discord-bridge] unknown interaction button style; using secondary", { style });
        return ButtonStyle.Secondary;
    }
  }

  private async sendRenderedEnvelope(discordUserId: string, envelope: ServerMessage): Promise<void> {
    const rendered = renderEnvelope(envelope);
    if (rendered.embeds.length === 0) return;

    let user;
    try {
      user = await this.client?.users.fetch(discordUserId);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[muddown-discord-bridge] failed to fetch DM user for delivery:", error);
      return;
    }
    if (!user) return;

    const components = rendered.components.map((component) => {
      if (Array.isArray(component)) {
        const row = new ActionRowBuilder<ButtonBuilder>();
        row.addComponents(
          component.map((button) =>
            new ButtonBuilder()
              .setCustomId(button.customId)
              .setLabel(button.label)
              .setStyle(this.toDiscordButtonStyle(button.style)),
          ),
        );
        return row;
      }

      const menu = new StringSelectMenuBuilder()
        .setCustomId(component.customId)
        .setPlaceholder(component.placeholder)
        .addOptions(component.options);
      return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    });

    const { deliveryRetries, deliveryBackoffMs, maxDeliveryBackoffMs } = this.requireConfig().tunables;
    // Invariant: deliveryRetries is at least 1 (validated by loadConfig).
    for (let attempt = 1; attempt <= deliveryRetries; attempt++) {
      try {
        await user.send({
          embeds: rendered.embeds.map((embed) => ({
            title: embed.title,
            description: embed.description,
            color: embed.color,
          })),
          components,
        });
        this.deliveryFailureStreak.delete(discordUserId);
        return;
      } catch (error) {
        if (attempt >= deliveryRetries) {
          this.handleDeliveryFailure(discordUserId, error);
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, gameplayDeliveryBackoffMs(attempt, deliveryBackoffMs, maxDeliveryBackoffMs)),
        );
      }
    }
  }

  private handleDeliveryFailure(discordUserId: string, error: unknown): void {
    const { maxConsecutiveDeliveryFailures } = this.requireConfig().tunables;
    const { failures, shouldTerminate } = nextDeliveryFailure(
      this.deliveryFailureStreak.get(discordUserId),
      maxConsecutiveDeliveryFailures,
    );
    this.deliveryFailureStreak.set(discordUserId, failures);
    // eslint-disable-next-line no-console
    console.error(
      `[muddown-discord-bridge] gameplay delivery failed (${failures}/${maxConsecutiveDeliveryFailures}):`,
      error,
    );

    if (!shouldTerminate) return;

    this.closeSession(discordUserId, false);
    this.sendDirectMessage(
      discordUserId,
      "Your Discord delivery channel appears unavailable. The gameplay session was closed; use `/play` to reconnect.",
    ).catch((dmError) => {
      // eslint-disable-next-line no-console
      console.error("[muddown-discord-bridge] failed to send delivery-failure disconnect notice:", dmError);
    });
  }

  private async sendDirectMessage(discordUserId: string, content: string): Promise<void> {
    if (!this.client) {
      // eslint-disable-next-line no-console
      console.error("[muddown-discord-bridge] cannot send DM: discord client is unavailable");
      return;
    }
    let user;
    try {
      user = await this.client.users.fetch(discordUserId);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[muddown-discord-bridge] cannot send DM: user ${discordUserId} not found or inaccessible:`,
        error,
      );
      return;
    }
    await user.send(content);
  }

  private buildDiscordLoginUrl(nonce: string): string {
    const url = new URL(this.httpBase());
    url.pathname = `${url.pathname.replace(/\/$/, "")}/auth/login`;
    url.searchParams.set("provider", "discord");
    url.searchParams.set("login_nonce", nonce);
    return url.toString();
  }

  private async pollForToken(nonce: string): Promise<string | undefined> {
    const base = this.httpBase();
    for (let index = 0; index < TOKEN_POLL_ATTEMPTS; index++) {
      await new Promise((resolve) => setTimeout(resolve, TOKEN_POLL_INTERVAL_MS));
      try {
        const response = await fetchWithTimeout(
          `${base}/auth/token-poll?nonce=${encodeURIComponent(nonce)}`,
        );
        if (response.status === 200) {
          const json = (await response.json()) as { token?: string };
          if (json.token) return json.token;
          // eslint-disable-next-line no-console
          console.error("[muddown-discord-bridge] token poll returned 200 without token field");
          return undefined;
        }
        if (response.status === 202 || response.status === 429 || response.status >= 500) {
          continue;
        }
        return undefined;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("[muddown-discord-bridge] token polling failed:", error);
      }
    }
    return undefined;
  }

  private async fetchMe(sessionToken: string): Promise<AuthMeResponse | undefined> {
    try {
      const response = await fetchWithTimeout(`${this.httpBase()}/auth/me`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) return undefined;
      const json = (await response.json()) as AuthMeResponse;
      if (!json.id || !json.displayName) return undefined;
      return json;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[muddown-discord-bridge] /auth/me failed:", error);
      return undefined;
    }
  }

  private async fetchCharacters(sessionToken: string): Promise<CharacterEntry[] | null> {
    try {
      const response = await fetchWithTimeout(`${this.httpBase()}/auth/characters`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) return null;
      const json = (await response.json()) as { characters?: CharacterEntry[] };
      return json.characters ?? [];
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[muddown-discord-bridge] /auth/characters failed:", error);
      return null;
    }
  }

  private async selectCharacter(sessionToken: string, characterId: string): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(`${this.httpBase()}/auth/select-character`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ characterId }),
      });
      return response.ok;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[muddown-discord-bridge] /auth/select-character failed:", error);
      return false;
    }
  }

  private async fetchWsTicket(sessionToken: string): Promise<string | undefined> {
    try {
      const response = await fetchWithTimeout(`${this.httpBase()}/auth/ws-ticket`, {
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      if (!response.ok) return undefined;
      const json = (await response.json()) as { ticket?: string };
      return json.ticket;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[muddown-discord-bridge] /auth/ws-ticket failed:", error);
      return undefined;
    }
  }

  private httpBase(): string {
    return wsToHttpBase(this.requireConfig().serverUrl);
  }

  private requireConfig(): DiscordBridgeConfig {
    if (!this.config) {
      throw new Error("Discord bridge config not loaded");
    }
    return this.config;
  }
}

const bridgeLifecycle = new BridgeLifecycle();

export async function main(): Promise<void> {
  await bridgeLifecycle.main();
}

export async function shutdown(): Promise<void> {
  await bridgeLifecycle.shutdown();
}

export function resetBridgeForTests(): void {
  bridgeLifecycle.reset();
}

export function formatUserTag(user: Pick<ClientUser, "username" | "discriminator">): string {
  return user.discriminator === "0" ? user.username : `${user.username}#${user.discriminator}`;
}
