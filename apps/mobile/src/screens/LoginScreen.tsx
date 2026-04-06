import React, { useEffect, useState } from "react";
import { View, Text, Pressable, ActivityIndicator, Alert, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import { buildWsUrl } from "@muddown/client";

import type { LoginScreenProps } from "../types.js";
import { colors, base } from "../theme.js";
import { SERVER_URL } from "../constants.js";
import { authFetch, setToken, getToken, clearToken } from "../auth.js";

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

        if (me?.activeCharacter) {
          await goToGameAuthenticated();
        } else {
          navigation.replace("Character");
        }
        return;
      }
      // 4xx — not logged in, show login UI
    } catch (err) {
      console.error("[LoginScreen] checkAuth failed:", err);
      // Genuine network failure — show login options
    }
    setChecking(false);
  }

  async function goToGameAuthenticated(): Promise<void> {
    try {
      const res = await authFetch(`${SERVER_URL}/auth/ws-ticket`);

      if (res.status === 401 || res.status === 403) {
        try { await clearToken(); } catch (e) { console.error("[LoginScreen] clearToken failed:", e); }
        Alert.alert("Session Expired", "Your session has expired. Please log in again.");
        setChecking(false);
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

      // Non-auth server error — offer retry instead of silently downgrading
      Alert.alert(
        "Connection Issue",
        "Could not retrieve your game session.",
        [
          { text: "Retry", onPress: () => goToGameAuthenticated() },
          { text: "Cancel", onPress: () => setChecking(false), style: "cancel" },
        ],
      );
    } catch (err) {
      console.error(`[LoginScreen] goToGameAuthenticated: failed to fetch ${SERVER_URL}/auth/ws-ticket`, err);
      Alert.alert(
        "Connection Issue",
        "Could not retrieve your game session.",
        [
          { text: "Retry", onPress: () => goToGameAuthenticated() },
          { text: "Cancel", onPress: () => setChecking(false), style: "cancel" },
        ],
      );
    }
  }

  function handleGuest() {
    navigation.replace("Game", {
      wsUrl: buildWsUrl(SERVER_URL),
      mode: "guest",
    });
  }

  async function handleLogin() {
    try {
      // Build the redirect URI that the server will redirect back to after OAuth.
      // Expo's Linking.createURL produces the correct scheme-based URL
      // (e.g. muddown://auth in production, exp://... in Expo Go).
      const redirectUri = Linking.createURL("auth");
      const loginUrl = `${SERVER_URL}/auth/login?redirect_uri=${encodeURIComponent(redirectUri)}`;

      const result = await WebBrowser.openAuthSessionAsync(loginUrl, redirectUri);

      if (result.type === "success" && result.url) {
        // Extract the session token from the redirect URL
        const parsed = Linking.parse(result.url);
        const token = parsed.queryParams?.token as string | undefined;
        if (token) {
          await setToken(token);
          setChecking(true);
          await checkAuth();
          return;
        }
        // OAuth completed but no token was returned — server-side issue
        console.error("[LoginScreen] handleLogin: OAuth redirect succeeded but no token in URL");
        Alert.alert("Login Failed", "Authentication succeeded but no session was returned. Please try again.");
        return;
      }
      // User cancelled — stay on login screen
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
