import { StyleSheet } from "react-native";

/** Dark colour palette matching the web client. */
export const colors = {
  bg: "#181a20",
  surface: "#23262f",
  border: "#333642",
  text: "#e0e0e0",
  textMuted: "#888",
  accent: "#7ec8e3",
  link: "#7ec8e3",
  heading: "#fff",
  code: "#f5c76a",
  codeBg: "#23262f",
  bold: "#fff",
  italic: "#c0c0c0",
  error: "#ff4444",
  success: "#44ff44",
  prompt: "#888",
  inputBg: "#101218",
  blockquoteBorder: "#7ec8e3",
  statusConnected: "#1a3a1a",
  statusDisconnected: "#3a1a1a",
} as const;

/** Shared base styles used across multiple screens. */
export const base = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    flex: 1,
    padding: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: "bold",
    color: colors.heading,
    marginBottom: 12,
  },
  body: {
    fontSize: 15,
    color: colors.text,
    lineHeight: 22,
  },
  button: {
    backgroundColor: colors.accent,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 6,
    alignItems: "center",
  },
  buttonText: {
    color: colors.bg,
    fontWeight: "bold",
    fontSize: 16,
  },
  secondaryButton: {
    borderWidth: 1,
    borderColor: colors.accent,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 6,
    alignItems: "center",
  },
  secondaryButtonText: {
    color: colors.accent,
    fontWeight: "bold",
    fontSize: 16,
  },
});
