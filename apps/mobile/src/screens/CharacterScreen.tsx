import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { buildWsUrl } from "@muddown/client";
import { CHARACTER_CLASSES, CLASS_STATS } from "@muddown/shared";
import type { CharacterClass } from "@muddown/shared";

import type { CharacterScreenProps } from "../types.js";
import { colors, base } from "../theme.js";
import { SERVER_URL } from "../constants.js";
import { authFetch, clearToken } from "../auth.js";

interface CharacterSummary {
  id: string;
  name: string;
  characterClass: string;
  hp: number;
  maxHp: number;
  xp: number;
}

function formatClassStats(cls: CharacterClass): string {
  const s = CLASS_STATS[cls];
  return `HP ${s.hp} · AC ${s.ac} · ATK +${s.attackBonus} · DMG ${s.damage}`;
}

export function CharacterScreen({ navigation }: CharacterScreenProps) {
  const [characters, setCharacters] = useState<CharacterSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [charClass, setCharClass] = useState<CharacterClass>("warrior");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loadCharacters();
  }, []);

  async function handleAuthFailure(showAlert = true) {
    try { await clearToken(); } catch (e) { console.error("[CharacterScreen] clearToken failed:", e); }
    if (showAlert) {
      Alert.alert("Session Expired", "Please log in again.");
    }
    navigation.replace("Login");
  }

  async function loadCharacters() {
    setLoading(true);
    setError("");
    try {
      const res = await authFetch(`${SERVER_URL}/auth/characters`);

      if (res.status === 401 || res.status === 403) {
        await handleAuthFailure(false);
        return;
      }

      if (!res.ok) {
        setCharacters([]);
        setError(`Could not load characters (HTTP ${res.status}).`);
        setLoading(false);
        return;
      }

      const text = await res.text();
      let data: { characters?: CharacterSummary[] };
      try {
        data = JSON.parse(text);
      } catch {
        console.error("[CharacterScreen] loadCharacters: invalid JSON response");
        setCharacters([]);
        setError("Received an invalid response from the server.");
        setLoading(false);
        return;
      }
      setCharacters(data.characters ?? []);
    } catch (err) {
      console.error("[CharacterScreen] loadCharacters network error:", err);
      setCharacters([]);
      setError("Could not reach the server. Check your connection.");
    }
    setLoading(false);
  }

  async function selectCharacter(characterId: string) {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await authFetch(`${SERVER_URL}/auth/select-character`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ characterId }),
      });

      if (res.status === 401 || res.status === 403) {
        await handleAuthFailure();
        return;
      }

      if (res.ok) {
        await startGame();
      } else {
        const body = await res.json().catch(() => ({}));
        Alert.alert("Error", (body as { error?: string }).error ?? "Failed to select character.");
      }
    } catch (err) {
      console.error("[CharacterScreen] selectCharacter failed:", err);
      Alert.alert("Error", "Failed to contact server.");
    } finally {
      setSubmitting(false);
    }
  }

  async function createCharacter() {
    setError("");
    const trimmed = name.trim();
    if (!trimmed || !charClass) {
      setError("Please enter a name and select a class.");
      return;
    }
    if (trimmed.length < 2 || trimmed.length > 24) {
      setError("Name must be between 2 and 24 characters.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await authFetch(`${SERVER_URL}/auth/create-character`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, characterClass: charClass }),
      });

      if (res.status === 401 || res.status === 403) {
        await handleAuthFailure();
        return;
      }

      const text = await res.text();
      let data: { error?: string };
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text || `Server error (HTTP ${res.status})` };
      }

      if (!res.ok) {
        setError(data.error ?? "Failed to create character.");
        return;
      }
      await startGame();
    } catch (err) {
      console.error("[CharacterScreen] createCharacter failed:", err);
      setError("Failed to contact server.");
    } finally {
      setSubmitting(false);
    }
  }

  async function startGame() {
    try {
      const res = await authFetch(`${SERVER_URL}/auth/ws-ticket`);

      if (res.status === 401 || res.status === 403) {
        await handleAuthFailure();
        return;
      }

      if (res.ok) {
        const { ticket } = await res.json();
        navigation.replace("Game", {
          wsUrl: buildWsUrl(SERVER_URL),
          mode: "authenticated",
          ticket,
        });
        return;
      }

      Alert.alert("Error", `Could not start game session (HTTP ${res.status}). Please try again.`);
    } catch (err) {
      console.error("[CharacterScreen] startGame network error:", err);
      Alert.alert("Error", "Could not contact the server. Please try again.");
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={base.screen}>
      <KeyboardAvoidingView
        style={styles.flex1}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {error ? (
          <View style={styles.section}>
            <Text style={styles.errorBanner}>{error}</Text>
            <Pressable style={base.secondaryButton} onPress={loadCharacters}>
              <Text style={base.secondaryButtonText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Existing characters */}
        {characters.length > 0 && (
          <View style={styles.section}>
            <Text style={base.title}>Your Characters</Text>
            {characters.map((c) => (
              <Pressable
                key={c.id}
                style={styles.charRow}
                onPress={() => selectCharacter(c.id)}
                disabled={submitting}
              >
                <View style={styles.charInfo}>
                  <Text style={styles.charName}>{c.name}</Text>
                  <Text style={styles.charStats}>
                    {c.characterClass} · HP {c.hp}/{c.maxHp} · XP {c.xp}
                  </Text>
                </View>
                <Text style={styles.playLabel}>Play ▸</Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* Create new character */}
        <View style={styles.section}>
          <Text style={base.title}>Create New Character</Text>

          <Text style={styles.label}>Name</Text>
          <TextInput
            style={[styles.input, submitting && styles.disabled]}
            value={name}
            onChangeText={setName}
            placeholder="2–24 characters"
            placeholderTextColor={colors.textMuted}
            maxLength={24}
            autoCapitalize="words"
            autoCorrect={false}
            editable={!submitting}
          />

          <Text style={styles.label}>Class</Text>
          {CHARACTER_CLASSES.map((cls) => (
            <Pressable
              key={cls}
              style={[
                styles.classOption,
                charClass === cls && styles.classSelected,
                submitting && styles.disabled,
              ]}
              onPress={() => setCharClass(cls)}
              disabled={submitting}
            >
              <Text style={styles.className}>
                {cls.charAt(0).toUpperCase() + cls.slice(1)}
              </Text>
              <Text style={styles.classStats}>{formatClassStats(cls)}</Text>
            </Pressable>
          ))}

          <Pressable style={[base.button, styles.createBtn]} onPress={createCharacter} disabled={submitting}>
            <Text style={base.buttonText}>{submitting ? "Submitting…" : "Create & Play"}</Text>
          </Pressable>
        </View>
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex1: {
    flex: 1,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.bg,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  section: {
    marginBottom: 28,
  },
  errorBanner: {
    color: colors.error,
    fontSize: 14,
    marginBottom: 12,
  },
  charRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: 8,
    padding: 14,
    marginBottom: 8,
  },
  charInfo: {
    flex: 1,
  },
  charName: {
    color: colors.heading,
    fontSize: 16,
    fontWeight: "bold",
  },
  charStats: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  playLabel: {
    color: colors.accent,
    fontWeight: "bold",
    fontSize: 14,
  },
  label: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
    marginBottom: 6,
    marginTop: 12,
  },
  input: {
    backgroundColor: colors.inputBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  classOption: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    padding: 12,
    marginBottom: 6,
  },
  classSelected: {
    borderColor: colors.accent,
  },
  className: {
    color: colors.heading,
    fontSize: 15,
    fontWeight: "bold",
  },
  classStats: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  createBtn: {
    marginTop: 16,
  },
  disabled: {
    opacity: 0.5,
  },
});
