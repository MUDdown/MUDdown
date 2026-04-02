import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Privacy compliance tests.
 *
 * These verify the codebase matches the claims in our privacy policy
 * (apps/website/src/pages/privacy.astro). If any of these fail, either
 * the code or the privacy policy needs updating.
 */

const ROOT = resolve(import.meta.dirname, "../../..");
const SERVER_SRC = join(ROOT, "packages/server/src");
const WEBSITE_SRC = join(ROOT, "apps/website/src");

// ── Helpers ──────────────────────────────────────────────────────────────────

function readSource(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf-8");
}

// ── Cookie Compliance ────────────────────────────────────────────────────────

describe("cookie compliance", () => {
  const authSource = readSource("packages/server/src/auth.ts");

  it("session cookie is named muddown_session", () => {
    expect(authSource).toContain("muddown_session=");
  });

  it("session cookie has HttpOnly flag", () => {
    expect(authSource).toMatch(/Set-Cookie.*HttpOnly/);
  });

  it("session cookie has SameSite=Lax flag", () => {
    expect(authSource).toMatch(/Set-Cookie.*SameSite=Lax/);
  });

  it("session cookie uses Secure flag when HTTPS is configured", () => {
    // The secureCookieSuffix function adds "; Secure" for HTTPS callbacks
    expect(authSource).toContain("; Secure");
  });

  it("session duration is 7 days (604800 seconds)", () => {
    // Privacy policy states: "It expires after 7 days"
    expect(authSource).toMatch(/SESSION_DURATION_MS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });
});

// ── No Password Storage ──────────────────────────────────────────────────────

describe("no password storage", () => {
  const sqliteSource = readSource("packages/server/src/db/sqlite.ts");
  const dbTypesSource = readSource("packages/server/src/db/types.ts");

  it("database schema has no password column", () => {
    // Privacy policy states: "We do not store passwords"
    expect(sqliteSource.toLowerCase()).not.toMatch(/\bpassword\b/);
  });

  it("database interface has no password field", () => {
    expect(dbTypesSource.toLowerCase()).not.toMatch(/\bpassword\b/);
  });
});

// ── OAuth-Only Authentication ────────────────────────────────────────────────

describe("OAuth-only authentication", () => {
  const authSource = readSource("packages/server/src/auth.ts");

  it("uses OAuth providers (github, microsoft, google)", () => {
    expect(authSource).toContain("github.com/login/oauth");
    expect(authSource).toContain("login.microsoftonline.com");
    expect(authSource).toContain("accounts.google.com");
  });

  it("does not implement local password authentication", () => {
    // No bcrypt/argon2/scrypt password hashing
    expect(authSource).not.toMatch(/bcrypt|argon2|scrypt|pbkdf2/i);
  });
});

// ── No Analytics or Tracking ─────────────────────────────────────────────────

describe("no analytics or tracking", () => {
  function collectWebFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && /\.(astro|html|ts|js)$/.test(entry.name)) {
        files.push(join(entry.parentPath, entry.name));
      }
    }
    return files;
  }

  const webFiles = collectWebFiles(WEBSITE_SRC);

  it("website has no Google Analytics or Tag Manager", () => {
    for (const file of webFiles) {
      const content = readFileSync(file, "utf-8");
      expect(content, file).not.toMatch(/google-analytics|googletagmanager|gtag\(|GA_TRACKING/i);
    }
  });

  it("website has no third-party tracking pixels or beacons", () => {
    for (const file of webFiles) {
      const content = readFileSync(file, "utf-8");
      expect(content, file).not.toMatch(/facebook\.net|fbevents|hotjar|mixpanel|segment\.io|amplitude|posthog/i);
    }
  });
});

// ── localStorage Usage Compliance ────────────────────────────────────────────

describe("localStorage usage matches privacy policy", () => {
  const playSource = readSource("apps/website/src/pages/play.astro");

  // Privacy policy documents: "inventory display mode and panel position"
  // Actual keys: muddown_inv_mode, muddown_inv_pos

  it("only uses documented localStorage keys", () => {
    const storageWrites = [...playSource.matchAll(/localStorage\.setItem\(\s*["'`]([^"'`]+)["'`]/g)];
    const keys = storageWrites.map(m => m[1]);
    const allowedKeys = ["muddown_inv_mode", "muddown_inv_pos"];
    for (const key of keys) {
      expect(allowedKeys, `Undocumented localStorage key: ${key}`).toContain(key);
    }
  });

  it("does not transmit localStorage data to the server", () => {
    // localStorage values should not appear in fetch/XMLHttpRequest calls
    const lines = playSource.split("\n");

    // Direct call check: no line calls both localStorage.getItem and a network API
    for (const line of lines) {
      if (line.includes("localStorage.getItem")) {
        expect(line).not.toMatch(/fetch\(|XMLHttpRequest/i);
      }
    }

    // Indirect check: collect variables assigned from localStorage.getItem,
    // then verify none of those identifiers appear in network-request lines
    const assignmentRe = /(?:const|let|var)\s+(\w+)\s*=\s*localStorage\.getItem\b/g;
    const storedVarNames = [...playSource.matchAll(assignmentRe)].map(m => m[1]);
    // Also catch bare assignments like `ident = localStorage.getItem(...)`
    const bareAssignRe = /(\w+)\s*=\s*localStorage\.getItem\b/g;
    for (const m of playSource.matchAll(bareAssignRe)) {
      if (!storedVarNames.includes(m[1])) storedVarNames.push(m[1]);
    }

    const networkLines = lines.filter(l => /fetch\(|XMLHttpRequest/i.test(l));
    for (const varName of storedVarNames) {
      for (const line of networkLines) {
        expect(line, `localStorage variable "${varName}" appears in a network call`).not.toContain(varName);
      }
    }
  });
});

// ── Only muddown_session Cookie ──────────────────────────────────────────────

describe("only documented cookies are set", () => {
  const authSource = readSource("packages/server/src/auth.ts");

  it("server only sets muddown_session cookie", () => {
    const cookieHeaders = [...authSource.matchAll(/Set-Cookie['":\s]+`?([^`\n]+)/g)];
    for (const match of cookieHeaders) {
      expect(match[1]).toMatch(/^muddown_session/);
    }
  });
});
