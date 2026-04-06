import React, { useState, useRef } from "react";
import {
  View,
  TextInput,
  Pressable,
  Text,
  StyleSheet,
  Platform,
} from "react-native";
import type { CommandHistory } from "@muddown/client";
import { colors } from "../theme.js";

interface CommandInputProps {
  onSend: (command: string) => void;
  history: CommandHistory;
}

export function CommandInput({ onSend, history }: CommandInputProps) {
  const [text, setText] = useState("");
  // TODO: use inputRef for programmatic focus (e.g. after send, reconnect)
  const inputRef = useRef<TextInput>(null);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    history.push(trimmed);
    onSend(trimmed);
    setText("");
  }

  function handleKeyPress(e: { nativeEvent: { key: string } }) {
    // Arrow-key history navigation (works on hardware keyboards / simulators)
    if (e.nativeEvent.key === "ArrowUp") {
      const prev = history.up();
      if (prev != null) setText(prev);
    } else if (e.nativeEvent.key === "ArrowDown") {
      const next = history.down();
      setText(next ?? "");
    }
  }

  return (
    <View style={styles.row}>
      <Text style={styles.prompt}>&gt;</Text>
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={text}
        onChangeText={setText}
        onSubmitEditing={submit}
        onKeyPress={handleKeyPress}
        placeholder="Enter command…"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="send"
        blurOnSubmit={false}
        accessibilityLabel="Command input"
      />
      <Pressable style={styles.sendBtn} onPress={submit} accessibilityLabel="Send command">
        <Text style={styles.sendText}>⏎</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.inputBg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 8,
    paddingVertical: Platform.OS === "ios" ? 10 : 6,
  },
  prompt: {
    color: colors.prompt,
    fontSize: 18,
    fontFamily: "monospace",
    marginRight: 6,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    fontFamily: "monospace",
    paddingVertical: 4,
  },
  sendBtn: {
    marginLeft: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.accent,
    borderRadius: 4,
  },
  sendText: {
    color: colors.bg,
    fontSize: 18,
    fontWeight: "bold",
  },
});
