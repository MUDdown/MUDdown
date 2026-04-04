import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GameServerRecord, CertificationTier, ServerProtocol, UserSettableCertification } from "@muddown/shared";
import { resolveAccount, setCorsHeaders, handleCorsPreflightIfNeeded } from "./auth.js";
import type { GameDatabase, GameServerUpdate } from "./db/types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_BODY = 4096;
const MAX_SERVERS_PER_ACCOUNT = 10;
const VALID_PROTOCOLS: ReadonlySet<string> = new Set(["websocket", "telnet", "mcp", "other"]);
const VALID_CERTIFICATIONS: ReadonlySet<string> = new Set(["self-certified", "listed"]);
// "verified" is only set by the automated compliance checker, never by user registration
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?)*$/;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

type JsonBodyResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "oversized" | "invalid-json" | "error" };

function readJsonBody<T>(req: IncomingMessage, route: string): Promise<JsonBodyResult<T>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let resolved = false;

    function settle(result: JsonBodyResult<T>): void {
      if (resolved) return;
      resolved = true;
      resolve(result);
    }

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        settle({ ok: false, reason: "oversized" });
        return;
      }
      if (!resolved) chunks.push(chunk);
    });

    req.on("end", () => {
      if (resolved) return;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        settle({ ok: true, data: JSON.parse(text) as T });
      } catch (err) {
        console.warn(`readJsonBody(${route}): JSON parse failed:`, err);
        settle({ ok: false, reason: "invalid-json" });
      }
    });

    req.on("error", (err) => {
      console.error(`readJsonBody(${route}): request error:`, err);
      settle({ ok: false, reason: "error" });
    });
  });
}

// ─── Validation ──────────────────────────────────────────────────────────────

interface RegisterInput {
  name: string;
  description?: string;
  hostname: string;
  port?: number | null;
  protocol?: string;
  websiteUrl?: string | null;
  certification?: string;
}

interface UpdateInput {
  name?: string;
  description?: string;
  hostname?: string;
  port?: number | null;
  protocol?: string;
  websiteUrl?: string | null;
  certification?: string;
}

function validateRegisterInput(data: unknown): { ok: true; input: RegisterInput } | { ok: false; error: string } {
  if (typeof data !== "object" || data === null) return { ok: false, error: "Body must be a JSON object" };
  const obj = data as Record<string, unknown>;

  if (typeof obj.name !== "string" || obj.name.trim().length < 2 || obj.name.trim().length > 100) {
    return { ok: false, error: "name must be 2–100 characters" };
  }
  if (obj.description !== undefined && typeof obj.description !== "string") {
    return { ok: false, error: "description must be a string" };
  }
  if (obj.description !== undefined && (obj.description as string).length > 500) {
    return { ok: false, error: "description must be 500 characters or fewer" };
  }
  if (typeof obj.hostname !== "string" || !HOSTNAME_RE.test(obj.hostname)) {
    return { ok: false, error: "hostname must be a valid domain name" };
  }
  if (obj.port !== undefined && obj.port !== null) {
    if (typeof obj.port !== "number" || !Number.isInteger(obj.port) || obj.port < 1 || obj.port > 65535) {
      return { ok: false, error: "port must be 1–65535 or null" };
    }
  }
  if (obj.protocol !== undefined) {
    if (typeof obj.protocol !== "string") {
      return { ok: false, error: "protocol must be a string" };
    }
    if (!VALID_PROTOCOLS.has(obj.protocol)) {
      return { ok: false, error: `protocol must be one of: ${[...VALID_PROTOCOLS].join(", ")}` };
    }
  }
  if (obj.websiteUrl !== undefined && obj.websiteUrl !== null) {
    if (typeof obj.websiteUrl !== "string") {
      return { ok: false, error: "websiteUrl must be a string or null" };
    }
    try {
      const parsed = new URL(obj.websiteUrl as string);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { ok: false, error: "websiteUrl must use http or https" };
      }
    } catch {
      return { ok: false, error: "websiteUrl must be a valid URL" };
    }
  }
  if (obj.certification !== undefined) {
    if (typeof obj.certification !== "string") {
      return { ok: false, error: "certification must be a string" };
    }
    if (!VALID_CERTIFICATIONS.has(obj.certification)) {
      return { ok: false, error: `certification must be one of: ${[...VALID_CERTIFICATIONS].join(", ")}` };
    }
  }

  return { ok: true, input: obj as unknown as RegisterInput };
}

function validateUpdateInput(data: unknown): { ok: true; input: UpdateInput } | { ok: false; error: string } {
  if (typeof data !== "object" || data === null) return { ok: false, error: "Body must be a JSON object" };
  const obj = data as Record<string, unknown>;

  if (obj.name !== undefined) {
    if (typeof obj.name !== "string" || obj.name.trim().length < 2 || obj.name.trim().length > 100) {
      return { ok: false, error: "name must be 2–100 characters" };
    }
  }
  if (obj.description !== undefined) {
    if (typeof obj.description !== "string" || obj.description.length > 500) {
      return { ok: false, error: "description must be 500 characters or fewer" };
    }
  }
  if (obj.hostname !== undefined) {
    if (typeof obj.hostname !== "string" || !HOSTNAME_RE.test(obj.hostname)) {
      return { ok: false, error: "hostname must be a valid domain name" };
    }
  }
  if (obj.port !== undefined && obj.port !== null) {
    if (typeof obj.port !== "number" || !Number.isInteger(obj.port) || obj.port < 1 || obj.port > 65535) {
      return { ok: false, error: "port must be 1–65535 or null" };
    }
  }
  if (obj.protocol !== undefined) {
    if (typeof obj.protocol !== "string") {
      return { ok: false, error: "protocol must be a string" };
    }
    if (!VALID_PROTOCOLS.has(obj.protocol)) {
      return { ok: false, error: `protocol must be one of: ${[...VALID_PROTOCOLS].join(", ")}` };
    }
  }
  if (obj.websiteUrl !== undefined && obj.websiteUrl !== null) {
    if (typeof obj.websiteUrl !== "string") {
      return { ok: false, error: "websiteUrl must be a string or null" };
    }
    try {
      const parsed = new URL(obj.websiteUrl as string);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { ok: false, error: "websiteUrl must use http or https" };
      }
    } catch {
      return { ok: false, error: "websiteUrl must be a valid URL" };
    }
  }
  if (obj.certification !== undefined) {
    if (typeof obj.certification !== "string") {
      return { ok: false, error: "certification must be a string" };
    }
    if (!VALID_CERTIFICATIONS.has(obj.certification)) {
      return { ok: false, error: `certification must be one of: ${[...VALID_CERTIFICATIONS].join(", ")}` };
    }
  }

  return { ok: true, input: obj as unknown as UpdateInput };
}

// ─── Public Server Record (strip internal fields) ────────────────────────────

interface PublicGameServer {
  id: string;
  name: string;
  description: string;
  hostname: string;
  port: number | null;
  protocol: ServerProtocol;
  websiteUrl: string | null;
  certification: CertificationTier;
  lastCheckAt: string | null;
  createdAt: string;
}

function toPublic(server: GameServerRecord): PublicGameServer {
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    hostname: server.hostname,
    port: server.port,
    protocol: server.protocol,
    websiteUrl: server.websiteUrl,
    certification: server.certification,
    lastCheckAt: server.lastCheckAt,
    createdAt: server.createdAt,
  };
}

// ─── Route Handler ───────────────────────────────────────────────────────────

/**
 * Handles /api/games/* routes. Returns true if the request was handled.
 */
export async function handleGamesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  db: GameDatabase,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (!url.pathname.startsWith("/api/games")) return false;

  // CORS preflight
  if (handleCorsPreflightIfNeeded(req, res)) return true;
  setCorsHeaders(req, res);

  // GET /api/games — list all servers (public)
  if (url.pathname === "/api/games" && req.method === "GET") {
    const servers = db.getAllGameServers();
    sendJson(res, 200, { servers: servers.map(toPublic) });
    return true;
  }

  // POST /api/games — register a new server (authenticated)
  if (url.pathname === "/api/games" && req.method === "POST") {
    const account = resolveAccount(req, db);
    if (!account) { sendJson(res, 401, { error: "Not authenticated" }); return true; }

    const body = await readJsonBody<RegisterInput>(req, "POST /api/games");
    if (!body.ok) {
      sendJson(res, body.reason === "oversized" ? 413 : 400, { error: `Invalid request: ${body.reason}` });
      return true;
    }

    const validation = validateRegisterInput(body.data);
    if (!validation.ok) { sendJson(res, 400, { error: validation.error }); return true; }

    const existing = db.getGameServersByOwner(account.id);
    if (existing.length >= MAX_SERVERS_PER_ACCOUNT) {
      sendJson(res, 409, { error: `Maximum ${MAX_SERVERS_PER_ACCOUNT} servers per account` });
      return true;
    }

    const input = validation.input;
    const now = new Date().toISOString();
    const server: GameServerRecord = {
      id: randomUUID(),
      ownerId: account.id,
      name: input.name.trim(),
      description: (input.description ?? "").trim(),
      hostname: input.hostname.trim().toLowerCase(),
      port: input.port ?? null,
      protocol: (input.protocol ?? "websocket") as ServerProtocol,
      websiteUrl: input.websiteUrl ?? null,
      certification: (input.certification ?? "listed") as CertificationTier,
      lastCheckAt: null,
      lastCheckResult: null,
      createdAt: now,
      updatedAt: now,
    };

    db.createGameServer(server);
    sendJson(res, 201, toPublic(server));
    return true;
  }

  // If we matched /api/games exactly but method wasn't GET or POST, return 405
  if (url.pathname === "/api/games") {
    res.setHeader("Allow", "GET, POST");
    sendJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  // Routes with server ID: /api/games/:id
  const idMatch = url.pathname.match(/^\/api\/games\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (!idMatch) {
    sendJson(res, 400, { error: "Invalid server ID format" });
    return true;
  }
  const serverId = idMatch[1].toLowerCase();

  // GET /api/games/:id — get single server (public)
  if (req.method === "GET") {
    const server = db.getGameServer(serverId);
    if (!server) { sendJson(res, 404, { error: "Server not found" }); return true; }
    sendJson(res, 200, toPublic(server));
    return true;
  }

  // PUT /api/games/:id — update server (owner only)
  if (req.method === "PUT") {
    const account = resolveAccount(req, db);
    if (!account) { sendJson(res, 401, { error: "Not authenticated" }); return true; }

    const server = db.getGameServer(serverId);
    if (!server) { sendJson(res, 404, { error: "Server not found" }); return true; }
    if (server.ownerId !== account.id) { sendJson(res, 403, { error: "Not the server owner" }); return true; }

    const body = await readJsonBody<UpdateInput>(req, "PUT /api/games/:id");
    if (!body.ok) {
      sendJson(res, body.reason === "oversized" ? 413 : 400, { error: `Invalid request: ${body.reason}` });
      return true;
    }

    const validation = validateUpdateInput(body.data);
    if (!validation.ok) { sendJson(res, 400, { error: validation.error }); return true; }

    const input = validation.input;
    const update: GameServerUpdate = {};
    if (input.name !== undefined) update.name = input.name.trim();
    if (input.description !== undefined) update.description = input.description.trim();
    if (input.hostname !== undefined) update.hostname = input.hostname.trim().toLowerCase();
    if (input.port !== undefined) update.port = input.port;
    if (input.protocol !== undefined) update.protocol = input.protocol as ServerProtocol;
    if (input.websiteUrl !== undefined) update.websiteUrl = input.websiteUrl;
    if (input.certification !== undefined) update.certification = input.certification as UserSettableCertification;

    db.updateGameServer(serverId, update);
    const updated = db.getGameServer(serverId);
    if (!updated) {
      console.error(`PUT /api/games/:id: server disappeared after update — possible concurrent delete`, { serverId });
      sendJson(res, 500, { error: "Server record could not be retrieved after update. Please try again." });
      return true;
    }
    sendJson(res, 200, toPublic(updated));
    return true;
  }

  // DELETE /api/games/:id — remove server (owner only)
  if (req.method === "DELETE") {
    const account = resolveAccount(req, db);
    if (!account) { sendJson(res, 401, { error: "Not authenticated" }); return true; }

    const server = db.getGameServer(serverId);
    if (!server) { sendJson(res, 404, { error: "Server not found" }); return true; }
    if (server.ownerId !== account.id) { sendJson(res, 403, { error: "Not the server owner" }); return true; }

    db.deleteGameServer(serverId);
    sendJson(res, 200, { ok: true });
    return true;
  }

  res.setHeader("Allow", "GET, PUT, DELETE");
  sendJson(res, 405, { error: "Method not allowed" });
  return true;
}
