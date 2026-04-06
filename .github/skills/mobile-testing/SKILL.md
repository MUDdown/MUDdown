---
name: mobile-testing
description: Test the MUDdown Expo React Native app on physical iOS and Android devices using Expo Go, or via the iOS Simulator. Covers LAN configuration, SDK version alignment, monorepo entry point, simulator setup, and OAuth considerations.
---

# Mobile Testing Skill

You are helping test the MUDdown mobile app (`apps/mobile`) on a physical device using Expo Go, or in the iOS Simulator.

## Prerequisites

- Expo Go installed on the target device (iOS App Store or Google Play Store)
- Device and dev machine on the **same Wi-Fi network**
- Game server running on port 3300 (`cd packages/server && npm start`)

## Key Files

| File | Purpose |
|------|---------|
| `apps/mobile/package.json` | Dependencies, entry point (`"main": "index.ts"`) |
| `apps/mobile/index.ts` | Custom entry (registers `App` via `registerRootComponent`) |
| `apps/mobile/app.json` | Expo config (scheme, SDK policy, bundle IDs) |
| `apps/mobile/src/constants.ts` | `DEV_HOST` — server address for dev builds |
| `apps/mobile/metro.config.js` | Monorepo resolver (watchFolders, nodeModulesPaths, .js→.ts) |

## Step-by-Step

### 1. Find your LAN IP

```bash
ipconfig getifaddr en0   # macOS Wi-Fi
```

### 2. Set DEV_HOST to the LAN IP

Edit `apps/mobile/src/constants.ts` and set `DEV_HOST` to your LAN IP:

```ts
const DEV_HOST = "192.168.x.x"; // your LAN IP
```

> **Do not commit this change.** Revert to the platform-conditional default before committing:
> ```ts
> const DEV_HOST = Platform.OS === "android" ? "10.0.2.2" : "localhost";
> ```

### 3. Start the game server

```bash
cd packages/server && npm start
```

### 4. Start the Expo dev server

```bash
cd apps/mobile && npx expo start --clear
```

This displays a QR code and a URL like `exp://192.168.x.x:8081`.

### 5. Connect from the device

- **iOS**: Scan the QR code with the Camera app — it opens Expo Go.
- **Android**: Open Expo Go and scan the QR code, or enter the `exp://` URL manually.

## SDK Version Alignment

The Expo Go app on the device must match the SDK major version in `apps/mobile/package.json`. If Expo Go updates itself (e.g. to SDK 54), the project must be upgraded to match:

```bash
cd apps/mobile
npx expo install expo@~54.0.0 --fix   # target the SDK version Expo Go expects
npx expo install --check               # verify all deps are compatible
```

After upgrading, do a **full** clean install from the monorepo root — delete the lockfile too, since stale resolutions cause `ERESOLVE` conflicts:

```bash
cd /path/to/MUDdown
rm -rf package-lock.json node_modules apps/mobile/node_modules
npm install
```

> **Warning:** `npx expo install --fix` sometimes adds dependencies to the **root** `package.json` instead of the mobile workspace. Check `package.json` at the repo root after running it and remove any unexpected entries (e.g. `@types/react`).

Run `npx turbo run build && npx turbo run test` to verify nothing broke.

## Monorepo Entry Point

The standard `expo/AppEntry.js` does `import App from '../../App'` relative to its location in `node_modules/expo/`. In a hoisted monorepo, `expo` lives at the repo root's `node_modules/`, so that relative path lands in the wrong directory.

The fix is the custom `apps/mobile/index.ts` entry point:

```ts
import { registerRootComponent } from "expo";
import App from "./App";
registerRootComponent(App);
```

And `"main": "index.ts"` in `package.json`. **Do not change this back to `"main": "expo/AppEntry"`.**

## OAuth on Physical Devices

OAuth login (GitHub, Discord, etc.) from a physical device requires extra configuration because the OAuth callback URL (`/auth/callback`) defaults to `http://localhost:3300/auth/callback`, which is unreachable from the phone's Safari/Chrome.

To test authenticated login on a physical device:

1. Set `GITHUB_CALLBACK_URL=http://<LAN_IP>:3300/auth/callback` in `packages/server/.env`
2. Update the OAuth app's callback URL at the provider (e.g. GitHub Developer Settings) to match
3. Restart the game server

> **Revert both changes** after testing — the provider's callback URL must match production for deployed use, and the `.env` override should not persist.

Guest login works without any OAuth configuration.

## iOS Simulator

The iOS Simulator runs on your Mac and can reach `localhost` directly — no LAN IP changes needed.

### Setup

1. Xcode must be installed (check with `xcode-select -p`)
2. Download an iOS Simulator runtime: **Xcode → Settings → Platforms → iOS** (or `xcodebuild -downloadPlatform iOS`). This is several GB.
3. Verify: `xcrun simctl list devices available` should list devices.

### Running

With the Expo dev server running (`npx expo start`), press **`i`** to launch in the iOS Simulator. OAuth login works because the simulator's browser reaches `localhost:3300` directly.

### OAuth in the Simulator

OAuth works out of the box in the iOS Simulator since both the game server and the OAuth callback URL use `localhost`. However:

> **Do not restart the game server** between tapping "Login with GitHub" and completing the OAuth flow. The server stores `pendingOAuth` state in memory. A restart clears it, causing the callback to fall through to the **web client** redirect (`localhost:4321/play`) instead of returning to the native app via the `exp://` scheme.

If this happens, dismiss the in-app browser (tap X) and try login again.

## Android Emulator

Requires Android Studio (not installed by default on macOS):

1. Download from https://developer.android.com/studio
2. Open Android Studio → **More Actions → Virtual Device Manager** → create an emulator
3. With the Expo dev server running, press **`a`** to launch in the emulator

The Android Emulator uses `10.0.2.2` to reach the host machine's `localhost`, which is the default `DEV_HOST` for Android in `constants.ts`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Project is incompatible with this version of Expo Go" | SDK version mismatch | Upgrade project SDK to match Expo Go (see above) |
| "Unable to resolve ../../App" | Hoisted `expo/AppEntry.js` | Use custom `index.ts` entry point (see above) |
| "Could not connect to the server" (Safari) | OAuth callback uses `localhost` | Set `GITHUB_CALLBACK_URL` to LAN IP |
| App can't reach game server | `DEV_HOST` is `localhost` | Set `DEV_HOST` to LAN IP in `constants.ts` |
| `ERESOLVE` during `npm install` | Stale lockfile after SDK upgrade | Delete `package-lock.json`, all `node_modules`, and reinstall |
| `@types/react` added to root `package.json` | Expo auto-fix wrote to wrong workspace | Remove from root `package.json`, reinstall |
| OAuth lands on web client instead of native app | Server restarted mid-OAuth (lost `pendingOAuth` state) | Dismiss browser, log in again without restarting server |
| Metro can't resolve `.js` imports | Missing custom resolver | Verify `metro.config.js` has the `.js→.ts/.tsx` fallback |
