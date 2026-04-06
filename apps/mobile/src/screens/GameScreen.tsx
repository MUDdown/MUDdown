import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Text,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  MUDdownConnection,
  CommandHistory,
  resolveGameLink,
} from "@muddown/client";
import type { ConnectionEvents } from "@muddown/client";
import type { ServerMessage } from "@muddown/shared";

import type { GameScreenProps } from "../types.js";
import { colors } from "../theme.js";
import { MuddownView } from "../components/MuddownView.js";
import { CommandInput } from "../components/CommandInput.js";

type GameMessage = Pick<ServerMessage, "id" | "type" | "muddown">;

export function GameScreen({ route }: GameScreenProps) {
  const { wsUrl } = route.params;
  const ticket = route.params.mode === "authenticated" ? route.params.ticket : undefined;

  const [messages, setMessages] = useState<GameMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Connecting…");

  const connRef = useRef<MUDdownConnection | null>(null);
  const historyRef = useRef(new CommandHistory());
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    setMessages([]);

    const events: ConnectionEvents = {
      onOpen() {
        setConnected(true);
        setStatusMessage("Connected");
      },
      onMessage(muddown: string, type: string, raw: ServerMessage) {
        setMessages((prev) => [...prev, { id: raw.id, muddown, type: raw.type }]);
      },
      onClose(willReconnect: boolean) {
        setConnected(false);
        setStatusMessage(willReconnect ? "Reconnecting…" : "Disconnected");
      },
      onError() {
        console.error("[GameScreen] WebSocket error");
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            type: "system",
            muddown: ":::system{type=\"error\"}\nA connection error occurred.\n:::",
          },
        ]);
      },
      onParseError(data: string, err: unknown) {
        console.error("[GameScreen] Server message parse error", err, "raw:", data.slice(0, 200));
      },
    };

    const conn = new MUDdownConnection({ wsUrl }, events);
    conn.connect(ticket);
    connRef.current = conn;

    return () => conn.dispose();
  }, [wsUrl, ticket]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(timer);
  }, [messages.length]);

  const handleSend = useCallback((command: string): boolean => {
    const sent = connRef.current?.send(command) ?? false;
    if (!sent) {
      setMessages((prev) => [
        ...prev,
        {
          id: `unsent-${Date.now()}`,
          type: "system",
          muddown: ":::system{type=\"error\"}\nNot connected — command not sent.\n:::",
        },
      ]);
    }
    return sent;
  }, []);

  const handleGameLink = useCallback(
    (scheme: string, target: string) => {
      const command = resolveGameLink(scheme, target);
      if (command) {
        const sent = handleSend(command);
        if (sent) {
          historyRef.current.push(command);
        }
      }
    },
    [handleSend],
  );

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={0}
      >
        {/* Connection status */}
        <View
          style={[
            styles.statusBar,
            connected ? styles.statusConnected : styles.statusDisconnected,
          ]}
        >
          <Text style={styles.statusText}>{statusMessage}</Text>
        </View>

        {/* Game output */}
        <ScrollView
          ref={scrollRef}
          style={styles.output}
          contentContainerStyle={styles.outputContent}
          keyboardShouldPersistTaps="handled"
        >
          {messages.map((msg) => (
            <MuddownView
              key={msg.id}
              muddown={msg.muddown}
              onGameLink={handleGameLink}
            />
          ))}
        </ScrollView>

        {/* Command input */}
        <CommandInput onSend={handleSend} history={historyRef.current} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  flex: {
    flex: 1,
  },
  statusBar: {
    paddingVertical: 3,
    paddingHorizontal: 12,
    alignItems: "center",
  },
  statusConnected: {
    backgroundColor: colors.statusConnected,
  },
  statusDisconnected: {
    backgroundColor: colors.statusDisconnected,
  },
  statusText: {
    color: colors.textMuted,
    fontSize: 12,
  },
  output: {
    flex: 1,
  },
  outputContent: {
    paddingBottom: 8,
  },
});
