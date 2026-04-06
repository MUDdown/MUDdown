/**
 * Server connection defaults.
 *
 * In development, the game server runs on the same machine. iOS Simulator
 * can reach `localhost`, but Android Emulator uses `10.0.2.2`. In production,
 * the URL is read from `extra.serverUrl` in app.json (or app.config.ts).
 */
import { Platform } from "react-native";
import Constants from "expo-constants";

const DEV_HOST = Platform.OS === "android" ? "10.0.2.2" : "localhost";

/** Base HTTP URL for the game server API. */
export const SERVER_URL: string = __DEV__
  ? `http://${DEV_HOST}:3300`
  : (() => {
      const url = Constants.expoConfig?.extra?.serverUrl as string | undefined;
      if (!url) {
        throw new Error(
          "Production build requires 'serverUrl' in app.json extras.",
        );
      }
      return url;
    })();
