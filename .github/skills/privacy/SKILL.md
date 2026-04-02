---
name: privacy
description: Audit and maintain privacy compliance for MUDdown. Covers the privacy policy, data collection practices, cookie/storage usage, and compliance testing.
---

# Privacy Skill

You are auditing or modifying code that affects user data collection, storage, or disclosure for the MUDdown project. The privacy policy lives at `apps/website/src/pages/privacy.astro` and compliance tests at `packages/server/tests/privacy-compliance.test.ts`.

## What We Collect

| Data | Where Stored | When |
|------|-------------|------|
| OAuth provider profile (username, email) | SQLite `identity_links` table | On OAuth sign-in |
| Account display name | SQLite `accounts` table | On account creation |
| Character data (name, class, room, inventory, equipment, HP, XP) | SQLite `characters` table | During gameplay |
| Session token | SQLite `auth_sessions` + HTTP-only cookie | On OAuth sign-in |
| UI preferences (inventory mode, overlay position) | Browser `localStorage` | Client-side only |

## What We Do NOT Collect

- **Passwords** — OAuth-only authentication, no credential storage
- **IP addresses** — Not logged or stored
- **Analytics / telemetry** — No tracking scripts, pixels, or beacons
- **Email communications** — No marketing emails sent

## Cookies

One cookie, set only on OAuth login:

| Name | Flags | Max-Age | Purpose |
|------|-------|---------|---------|
| `muddown_session` | `HttpOnly; SameSite=Lax; Secure` (HTTPS) | 7 days (604800s) | Session authentication |

Source: `packages/server/src/auth.ts` — `SESSION_DURATION_MS` constant and `Set-Cookie` header.

## localStorage Keys

| Key | Value | Purpose |
|-----|-------|---------|
| `muddown_inv_mode` | `"off"` \| `"persistent"` \| `"overlay"` | Inventory panel display mode |
| `muddown_inv_pos` | `{x: number, y: number}` JSON | Overlay panel screen position |

These never leave the browser. Source: `apps/website/src/pages/play.astro`.

## Compliance Tests

`packages/server/tests/privacy-compliance.test.ts` automatically verifies:

- Session cookie has `HttpOnly`, `SameSite=Lax`, and `Secure` flags
- Session duration is 7 days
- No password columns in database schema
- No password hashing libraries in auth code
- OAuth providers match documented providers
- No analytics/tracking scripts in website source
- Only documented `localStorage` keys are used
- Only `muddown_session` cookie is set server-side

Run: `cd packages/server && npm test` or `npx turbo run test`

## Privacy Impact Checklist

When adding a feature that touches user data, verify:

1. **New data stored?** → Update the privacy policy ("Collection" and "Retention" sections) and the compliance test.
2. **New cookie?** → Update the "Cookies and Local Storage" section in the privacy policy and add to the compliance test's allowed cookies list.
3. **New localStorage key?** → Add to the allowed keys in the compliance test and mention in the privacy policy.
4. **New third-party service?** → Update the "Sharing" section and add no-tracking assertions.
5. **New API that sends user data externally?** → Document in the privacy policy's sharing section.
6. **Removing a data practice?** → Update the privacy policy to remove the claim and adjust tests.

## File Locations

| File | Purpose |
|------|---------|
| `apps/website/src/pages/privacy.astro` | Privacy policy page (public-facing) |
| `packages/server/tests/privacy-compliance.test.ts` | Automated compliance tests |
| `packages/server/src/auth.ts` | Cookie settings, OAuth flow, session management |
| `packages/server/src/db/sqlite.ts` | Database schema (what columns exist) |
| `packages/server/src/db/types.ts` | Database interface (what operations are supported) |
| `apps/website/src/pages/play.astro` | Client-side localStorage usage |
