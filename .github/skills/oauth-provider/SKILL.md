---
name: oauth-provider
description: Add a new OAuth/OIDC identity provider to MUDdown. Covers the shared type, auth switch statements, server config, login page button, env vars, tests, and local verification.
---

# OAuth Provider Skill

You are adding a new OAuth or OIDC identity provider to MUDdown. This is a multi-file change that touches shared types, server auth logic, server startup config, the login page, env files, and tests.

## Files to Modify (in order)

### 1. `packages/shared/src/index.ts` — Register the provider

Add the new provider string to the `OAUTH_PROVIDERS` tuple so it is included in the shared provider type and validation guard. This tuple does **not** control the login-button display order; update `apps/website/src/pages/login.astro` separately if you need to change the UI order.

```typescript
export const OAUTH_PROVIDERS = ["discord", "github", "microsoft", "google"] as const;
```

The `OAuthProvider` type and `isOAuthProvider()` guard derive from this array automatically — no other changes needed in shared.

### 2. `packages/server/src/auth.ts` — Implement the three protocol functions

Add a `case` for the new provider in **all three** switch statements. Each uses `assertNever(provider)` as the default, so the build will fail if any switch is missed.

| Function | Purpose | Key details |
|----------|---------|-------------|
| `buildAuthorizeUrl()` | Construct the OAuth authorize redirect URL | Set `scope`, `response_type`, `client_id`, `redirect_uri`, `state` |
| `exchangeCodeForToken()` | Exchange the authorization code for an access token | Know whether the provider expects JSON or `application/x-www-form-urlencoded` |
| `fetchProviderUser()` | Fetch the authenticated user's profile | Map provider fields to `{ providerId, username, displayName }` |

**Common pitfalls:**
- Discord's token endpoint requires `Content-Type: application/x-www-form-urlencoded` with a `URLSearchParams` body (not JSON).
- Some providers return the user ID as a number (GitHub), others as a string (Discord snowflake). Always convert to `String()`.
- The `displayName` field should use the provider's "friendly name" field (e.g., Discord `global_name`, GitHub `name`, Microsoft `displayName`).

### 3. `packages/server/src/index.ts` — Wire up provider config

Add a `buildProviderConfig()` call for the new provider's env vars, following the existing pattern:

```typescript
const exampleCfg = buildProviderConfig("EXAMPLE_CLIENT_ID", "EXAMPLE_CLIENT_SECRET", "EXAMPLE_CALLBACK_URL");
if (exampleCfg) oauthConfig.example = exampleCfg;
```

Also add a callback-URL warning in the `if (exampleCfg && !process.env.EXAMPLE_CALLBACK_URL)` block.

### 4. `apps/website/src/pages/login.astro` — Add the login button

Add a new `<button>` in the provider list with the provider's brand SVG icon. Register it in the `providerButtons` record in the `<script>` block. The `/auth/providers` endpoint controls provider availability; providers not returned are rendered disabled and dimmed unless you also update `login.astro` to remove them from the rendered list.

### 5. `packages/server/.env.example` — Document env vars

Add the three new env vars (this is the canonical env example file):

```
EXAMPLE_CLIENT_ID=
EXAMPLE_CLIENT_SECRET=
EXAMPLE_CALLBACK_URL=https://your-domain.com/auth/callback
```

### 6. Tests to update

| File | What to change |
|------|---------------|
| `packages/server/tests/auth-handlers.test.ts` | Add provider to `allProviders` config object; add a redirect URL assertion test |
| `packages/server/tests/shared-guards.test.ts` | Remove new provider from "rejects unknown provider strings" if it was listed there |

## OAuth Provider Registration

Each provider has a developer portal where you register the application:

- **Redirect URI**: Register both `http://localhost:3300/auth/callback` (dev) and `https://your-domain.com/auth/callback` (prod). The server sends `redirect_uri` in the authorize request and it must exactly match a registered URI.
- **Scopes**: Request the minimum scope needed for login (e.g., Discord `identify`, GitHub `read:user`, Google `openid profile email`).
- **Bot permissions**: Not needed — the app only uses OAuth for user identity, not API access.

## Local Verification Checklist

After implementation:

1. `npx turbo run build` — confirms `assertNever` exhaustiveness (build fails if a switch is missed)
2. `npx turbo run test` — confirms shared guards and auth handler tests pass
3. **Restart the dev server** — a running `node dist/index.js` serves the old build; kill and restart it
4. `curl -s http://localhost:3300/auth/providers` — confirm the new provider appears in the JSON array
5. Load `http://localhost:4321/login` — confirm the button renders and is clickable
6. Click the button — confirm it redirects to the provider's authorize page with the correct `redirect_uri`

> **Important**: The dev server (`node dist/index.js`) does not hot-reload. After `npx turbo run build`, you must kill and restart the server process for changes to take effect. The Astro dev server (`npm run dev`) *does* hot-reload.
