import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ActivityIndicator, Alert, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as WebBrowser from "expo-web-browser";
import { buildWsUrl } from "@muddown/client";

import type { LoginScreenProps } from "../types.js";
import type { GameScreenParams } from "../types.js";
import { colors, base } from "../theme.js";
import { SERVER_URL } from "../constants.js";
import { authFetch, setToken, getToken } from "../auth.js";

export function LoginScreen({ navigation }: LoginScreenProps) {
  const [checking, setChecking] = useState(true);
  const [serverError, setServerError] = useState(false);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    setServerError(false);
    try {
      const res = await authFetch(`${SERVER_URL}/auth/me`);

      if (res.status >= 500) {
        setServerError(true);
        setChecking(false);
        return;
      }

      if (res.ok) {
        const me = await res.json();

        // Capture token if the server returns one
        if (me?.token) {
          await setToken(me.token);
        }

        if (me?.activeCharacter) {
          await goToGameAuthenticated();
        } else {
          navigation.replace("Character");
        }
        return;
      }
      // 4xx — not logged in, show login UI
    } catch (err) {
      console.error("[LoginScreen] checkAuth network error:", err);
      // Genuine network failure — show login options
    }
    setChecking(false);
  }

  async function goToGameAuthenticated(): Promise<void> {
    try {
      const res = await authFetch(`${SERVER_URL}/auth/ws-ticket`);
      if (res.ok) {
        const { ticket } = await res.json();
        navigation.replace("Game", {
          wsUrl: buildWsUrl(SERVER_URL),
          mode: "authenticated",
          ticket,
        });
        return;
      }
    } catch (err) {
      console.error(`[LoginScreen] goToGameAuthenticated: failed to fetch ${SERVER_URL}/auth/ws-ticket`, err);
      Alert.alert(
        "Connection Issue",
        "Could not retrieve your game session. Continuing as guest.",
      );
      // Fall through — navigate as guest if ticket fetch fails
    }
    navigation.replace("Game", {
      wsUrl: buildWsUrl(SERVER_URL),
      mode: "guest",
    });
  }

  function handleGuest() {
    navigation.replace("Game", {
      wsUrl: buildWsUrl(SERVER_URL),
      mode: "guest",
    });
  }

  async function handleLogin() {
    try {
      const result = await WebBrowser.openBrowserAsync(`${SERVER_URL}/login`);
      // After the browser closes, check whether we now have an auth session
      if (result.type !== "cancel") {
        setChecking(true);
        await checkAuth();
      }
    } catch (err) {
      console.error("[LoginScreen] WebBrowser error:", err);
      Alert.alert("Error", "Could not open the login page.");
    }
  }

  if (checking) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </SafeAreaView>
    );
  }

  if (serverError) {
    return (
      <SafeAreaView style={base.screen}>
        <View style={styles.content}>
          <Text style={styles.title}>Server Unavailable</Text>
          <Text style={styles.subtitle}>
            The server is temporarily unavailable. Please try again later.
          </Text>
          <Pressable
            style={base.button}
            onPress={() => {
              setChecking(true);
              checkAuth();
            }}
          >
            <Text style={base.buttonText}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={base.screen}>
      <View style={styles.content}>
        <Text style={styles.title}>Welcome to MUDdown</Text>
        <Text style={styles.subtitle}>
          A modern MUD powered by Markdown
        </Text>

        <View style={styles.buttons}>
          <Pressable style={base.button} onPress={handleLogin}>
            <Text style={base.buttonText}>Login</Text>
          </Pressable>

          <Pressable style={base.secondaryButton} onPress={handleGuest}>
            <Text style={base.secondaryButtonText}>Play as Guest</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: colors.bg,
  },
  content: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    color: colors.heading,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: colors.textMuted,
    marginBottom: 40,
  },
  buttons: {
    width: "100%",
    maxWidth: 280,
    gap: 16,
  },
});
