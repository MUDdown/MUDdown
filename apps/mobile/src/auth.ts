/**
 * Token-based auth helpers for the mobile app.
 *
 * Expo's in-app browser (`expo-web-browser`) opens a system browser with
 * its own cookie jar, so session cookies are never available to `fetch()`.
 * Instead we store a bearer token in `expo-secure-store` and attach it to
 * every API request via the `Authorization` header.
 */
import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "muddown_auth_token";

/** Persist the bearer token to secure storage. */
export async function setToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

/** Read the bearer token from secure storage, or `null` if absent. */
export async function getToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

/** Remove the stored bearer token (logout). */
export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

/**
 * Build a headers object that includes the bearer token when available.
 * Merges any additional headers passed in.
 */
export async function authHeaders(
  extra?: Record<string, string>,
): Promise<Record<string, string>> {
  const token = await getToken();
  const headers: Record<string, string> = { ...extra };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Convenience wrapper around `fetch` that automatically attaches the
 * bearer token. Accepts the same arguments as `fetch`.
 */
export async function authFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const token = await getToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return fetch(url, { ...init, headers });
}
