// src/index.ts
import { join as join2 } from "node:path";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

// src/config.ts
import z from "@deepseek-ai/schemastery";
var Config = z.object({
  password: z.string().required(),
  distIndex: z.string().default(""),
  dataDir: z.string().default(""),
  sessionTtl: z.natural().default(604800),
  enabled: z.boolean().default(true),
  takeOverWebRuntime: z.boolean().default(true),
  trustedHosts: z.array(String).default([]),
  autoTrustHosts: z.boolean().default(true),
  defaultWorkspace: z.boolean().default(true),
  workspaceRoot: z.string().default(""),
  remoteWebUiCompat: z.boolean().default(true),
  remoteWebUiPublicBaseUrl: z.string().default(""),
  quietDenials: z.boolean().default(true),
  apiBridgeAuth: z.boolean().default(true)
});

// src/session.ts
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
var SAVE_DEBOUNCE_MS = 200;
var SessionStore = class {
  constructor(ttlSeconds, filePath) {
    this.ttlSeconds = ttlSeconds;
    this.filePath = filePath;
    if (filePath !== void 0) this.load();
  }
  ttlSeconds;
  filePath;
  store = /* @__PURE__ */ new Map();
  saveTimer;
  saving = Promise.resolve();
  /** Generate a 32-byte random token for `user` with its admin flag. */
  create(user, isAdmin) {
    const token = randomBytes(32).toString("hex");
    const createdAt = Date.now();
    const session = { token, user, isAdmin, createdAt, expiresAt: createdAt + this.ttlSeconds * 1e3 };
    this.store.set(token, session);
    this.scheduleSave();
    return session;
  }
  /** Return the live session for a token, or undefined. */
  verify(token) {
    if (token.length === 0) return void 0;
    const session = this.store.get(token);
    if (session === void 0) return void 0;
    if (Date.now() > session.expiresAt) {
      this.store.delete(token);
      this.scheduleSave();
      return void 0;
    }
    return session;
  }
  /** Remove a session. Revoking an unknown token is a no-op. */
  revoke(token) {
    if (this.store.delete(token)) this.scheduleSave();
  }
  /**
   * Revoke every live session belonging to `user` (user removal or password
   * change). Returns the number of sessions removed.
   */
  revokeAllFor(user) {
    let removed = 0;
    for (const [token, session] of this.store) {
      if (session.user === user) {
        this.store.delete(token);
        removed++;
      }
    }
    if (removed > 0) this.scheduleSave();
    return removed;
  }
  /**
   * Count live (unexpired) sessions per username. Used by the admin user
   * list to report online status; expired entries are swept along the way.
   */
  onlineCounts() {
    const counts = /* @__PURE__ */ new Map();
    const now = Date.now();
    let swept = false;
    for (const [token, session] of this.store) {
      if (now > session.expiresAt) {
        this.store.delete(token);
        swept = true;
        continue;
      }
      counts.set(session.user, (counts.get(session.user) ?? 0) + 1);
    }
    if (swept) this.scheduleSave();
    return counts;
  }
  /** Remove all expired sessions. */
  cleanup() {
    const now = Date.now();
    let swept = false;
    for (const [token, session] of this.store) {
      if (now > session.expiresAt) {
        this.store.delete(token);
        swept = true;
      }
    }
    if (swept) this.scheduleSave();
  }
  /** Force the pending save; resolves when the queued write settled (teardown). */
  async flush() {
    if (this.saveTimer !== void 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    await this.saving;
    await this.writeNow();
  }
  load() {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [];
      const now = Date.now();
      for (const entry of list) {
        if (typeof entry !== "object" || entry === null) continue;
        const s = entry;
        if (typeof s.token !== "string" || typeof s.user !== "string" || typeof s.isAdmin !== "boolean") continue;
        if (typeof s.createdAt !== "number" || typeof s.expiresAt !== "number") continue;
        if (now > s.expiresAt) continue;
        this.store.set(s.token, { token: s.token, user: s.user, isAdmin: s.isAdmin, createdAt: s.createdAt, expiresAt: s.expiresAt });
      }
    } catch {
    }
  }
  scheduleSave() {
    if (this.filePath === void 0 || this.saveTimer !== void 0) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = void 0;
      this.saving = this.writeNow();
    }, SAVE_DEBOUNCE_MS);
  }
  async writeNow() {
    if (this.filePath === void 0) return;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, `${JSON.stringify([...this.store.values()])}
`, { encoding: "utf8", mode: 384 });
    } catch {
    }
  }
};

// src/users.ts
import { randomBytes as randomBytes2, scryptSync, timingSafeEqual } from "node:crypto";
var USERNAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;
var KEY_LEN = 64;
function hashPassword(password, saltHex) {
  return scryptSync(password, Buffer.from(saltHex, "hex"), KEY_LEN).toString("hex");
}
function constantTimeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
var UserStore = class {
  constructor(credentials, ref) {
    this.credentials = credentials;
    this.ref = ref;
  }
  credentials;
  ref;
  async list() {
    const resolved = await this.credentials.resolve(this.ref);
    if (resolved === void 0) return [];
    try {
      const parsed = JSON.parse(resolved.value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  async isEmpty() {
    return (await this.list()).length === 0;
  }
  async create(username, password, isAdmin) {
    if (!USERNAME_PATTERN.test(username)) throw new Error("invalid username");
    if (password.length === 0) throw new Error("password must not be empty");
    const records = await this.list();
    if (records.some((u) => u.username === username)) throw new Error(`user "${username}" already exists`);
    const salt = randomBytes2(16).toString("hex");
    const record = {
      username,
      salt,
      hash: hashPassword(password, salt),
      isAdmin: records.length === 0 ? true : isAdmin,
      createdAt: Date.now()
    };
    await this.credentials.set(this.ref, JSON.stringify([...records, record]));
    return record;
  }
  async verify(username, password) {
    const record = (await this.list()).find((u) => u.username === username);
    if (record === void 0) return void 0;
    if (record.disabled === true) return void 0;
    return constantTimeEqualHex(hashPassword(password, record.salt), record.hash) ? record : void 0;
  }
  /**
   * Set or clear the disabled flag for `username`. The caller (admin API)
   * owns the last-enabled-admin guard and session revocation.
   */
  async setDisabled(username, disabled) {
    const records = await this.list();
    const record = records.find((u) => u.username === username);
    if (record === void 0) throw new Error(`unknown user "${username}"`);
    if (disabled) record.disabled = true;
    else delete record.disabled;
    await this.credentials.set(this.ref, JSON.stringify(records));
  }
  /**
   * Stamp `lastLoginAt` for a verified login. Best-effort audit field:
   * unknown users are a silent no-op so this can never fail a login.
   */
  async touchLastLogin(username) {
    const records = await this.list();
    const record = records.find((u) => u.username === username);
    if (record === void 0) return;
    record.lastLoginAt = Date.now();
    await this.credentials.set(this.ref, JSON.stringify(records));
  }
  async setPassword(username, password) {
    if (password.length === 0) throw new Error("password must not be empty");
    const records = await this.list();
    const record = records.find((u) => u.username === username);
    if (record === void 0) throw new Error(`unknown user "${username}"`);
    record.salt = randomBytes2(16).toString("hex");
    record.hash = hashPassword(password, record.salt);
    await this.credentials.set(this.ref, JSON.stringify(records));
  }
  async remove(username) {
    const records = await this.list();
    const next = records.filter((u) => u.username !== username);
    if (next.length === records.length) throw new Error(`unknown user "${username}"`);
    await this.credentials.set(this.ref, JSON.stringify(next));
  }
};

// src/ownership.ts
import { mkdir as mkdir2, writeFile as writeFile2 } from "node:fs/promises";
import { readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";
var SAVE_DEBOUNCE_MS2 = 200;
var OwnershipIndex = class {
  constructor(filePath) {
    this.filePath = filePath;
    try {
      const raw = readFileSync2(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") this.map.set(k, v);
        }
      }
    } catch {
    }
  }
  filePath;
  map = /* @__PURE__ */ new Map();
  saveTimer;
  saving = Promise.resolve();
  record(sessionId, username) {
    this.map.set(sessionId, username);
    this.scheduleSave();
  }
  lookup(sessionId) {
    return this.map.get(sessionId);
  }
  has(sessionId) {
    return this.map.has(sessionId);
  }
  knownUsernames() {
    return new Set(this.map.values());
  }
  /** All recorded [sessionId, username] pairs (snapshot). */
  entries() {
    return [...this.map.entries()];
  }
  /** Force the pending save; resolves when the file write settled. */
  async flush() {
    if (this.saveTimer !== void 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    await this.saving;
    await this.writeNow();
  }
  scheduleSave() {
    if (this.saveTimer !== void 0) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = void 0;
      this.saving = this.writeNow();
    }, SAVE_DEBOUNCE_MS2);
  }
  async writeNow() {
    try {
      await mkdir2(dirname2(this.filePath), { recursive: true });
      await writeFile2(this.filePath, `${JSON.stringify(Object.fromEntries(this.map))}
`, "utf8");
    } catch {
    }
  }
};

// src/hosts.ts
import { mkdir as mkdir3, writeFile as writeFile3 } from "node:fs/promises";
import { readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname3 } from "node:path";
var SAVE_DEBOUNCE_MS3 = 200;
var MAX_HOST_LENGTH = 255;
function canonicalAuthority(host) {
  let entryUrl;
  try {
    entryUrl = new URL(`http://${host}`);
  } catch {
    return void 0;
  }
  const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${host}`).port;
  return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
function isBareAuthority(host) {
  const c = canonicalAuthority(host);
  return c !== void 0 && c === host.toLowerCase() && host.length <= MAX_HOST_LENGTH;
}
function isLoopbackCanonical(authority) {
  const hostname = (authority.split(":")[0] ?? "").toLowerCase();
  if (hostname === "localhost") return true;
  if (hostname === "::1") return true;
  if (/^127\./.test(hostname)) return true;
  if (hostname === "0.0.0.0") return true;
  if (/^\[?::1\]?/.test(authority)) return true;
  return false;
}
var TrustedHosts = class {
  constructor(filePath) {
    this.filePath = filePath;
    try {
      const raw = readFileSync3(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed) ? parsed : parsed !== null && typeof parsed === "object" ? Object.keys(parsed) : [];
      for (const entry of entries) {
        if (typeof entry === "string") {
          const c = canonicalAuthority(entry);
          if (c !== void 0) this.set.add(c);
        }
      }
    } catch {
    }
  }
  filePath;
  set = /* @__PURE__ */ new Set();
  saveTimer;
  /** Tail of a single serialized write queue; writes never overlap. */
  saving = Promise.resolve();
  /** Canonicalize an authority; undefined when not a bare authority. */
  canonicalize(host) {
    return canonicalAuthority(host);
  }
  /** Whether this authority is currently trusted (canonical comparison). */
  has(authority) {
    const c = canonicalAuthority(authority);
    return c !== void 0 && this.set.has(c);
  }
  /**
   * Add one (auto-learned) Host authority, skipping loopback, invalid and
   * non-bare inputs. Returns true when newly recorded. Idempotent.
   */
  learn(host) {
    if (!isBareAuthority(host)) return false;
    const c = canonicalAuthority(host);
    if (isLoopbackCanonical(c)) return false;
    if (this.set.has(c)) return false;
    this.set.add(c);
    this.scheduleSave();
    return true;
  }
  /** Add a validated authority (admin manual add). Returns true when new. */
  add(authority) {
    if (!isBareAuthority(authority)) return false;
    const c = canonicalAuthority(authority);
    if (isLoopbackCanonical(c)) return false;
    if (this.set.has(c)) return false;
    this.set.add(c);
    this.scheduleSave();
    return true;
  }
  /** Remove an authority; returns true when it existed. Idempotent. */
  remove(authority) {
    const c = canonicalAuthority(authority);
    const key = c ?? authority;
    const existed = this.set.delete(key);
    if (existed) this.scheduleSave();
    return existed;
  }
  /** Snapshot of the currently trusted authorities. */
  list() {
    return [...this.set];
  }
  /** Force the pending save; resolves when the queued write settled. */
  async flush() {
    if (this.saveTimer !== void 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    this.saving = this.saving.then(() => this.writeNow());
    await this.saving;
  }
  scheduleSave() {
    if (this.saveTimer !== void 0) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = void 0;
      this.saving = this.saving.then(() => this.writeNow());
    }, SAVE_DEBOUNCE_MS3);
  }
  async writeNow() {
    try {
      await mkdir3(dirname3(this.filePath), { recursive: true });
      await writeFile3(this.filePath, `${JSON.stringify(this.list())}
`, "utf8");
    } catch {
    }
  }
};

// src/boolean-setting.ts
import { mkdir as mkdir4, writeFile as writeFile4 } from "node:fs/promises";
import { readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname4 } from "node:path";
var SAVE_DEBOUNCE_MS4 = 200;
var BooleanSetting = class {
  constructor(filePath, initial) {
    this.filePath = filePath;
    this.enabled = initial;
    try {
      const raw = readFileSync4(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && typeof parsed.enabled === "boolean") {
        this.enabled = parsed.enabled;
      }
    } catch {
    }
  }
  filePath;
  enabled;
  saveTimer;
  /** Tail of a single serialized write queue; writes never overlap. */
  saving = Promise.resolve();
  /** Whether the toggle is currently on. */
  get() {
    return this.enabled;
  }
  /** Set the flag and persist it (best-effort). Returns the new value. */
  set(enabled) {
    this.enabled = enabled;
    this.scheduleSave();
    return this.enabled;
  }
  /** Force the pending save; resolves when the queued write settled. */
  async flush() {
    if (this.saveTimer !== void 0) {
      clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    this.saving = this.saving.then(() => this.writeNow());
    await this.saving;
  }
  scheduleSave() {
    if (this.saveTimer !== void 0) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = void 0;
      this.saving = this.saving.then(() => this.writeNow());
    }, SAVE_DEBOUNCE_MS4);
  }
  async writeNow() {
    try {
      await mkdir4(dirname4(this.filePath), { recursive: true });
      await writeFile4(this.filePath, `${JSON.stringify({ enabled: this.enabled })}
`, "utf8");
    } catch {
    }
  }
};

// src/workspace-setting.ts
var DefaultWorkspaceSetting = class extends BooleanSetting {
};

// src/remote-web-ui-compat.ts
var REMOTE_WEB_UI_NAMESPACE = "remote-web-ui";
var RemoteWebUiCompat = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  /**
   * Apply the compat document to remote-web-ui's settings namespace.
   * @param compatEnabled - when true, mount the host routes and open the pairing
   * gate; when false, restore the pairing requirement only.
   * @param publicBaseUrl - optional public base URL (e.g. `http://host:port`) to
   * write so remote-web-ui's `/api/pair/*` fence trusts the public origin. Only
   * written when compat is on and the value is a non-empty http(s) URL.
   */
  async apply(compatEnabled, publicBaseUrl) {
    const settings = this.deps.getSettings();
    if (settings === void 0) return "skipped";
    let patch;
    if (compatEnabled) {
      patch = { enabled: true, requirePairingForLan: false };
      if (typeof publicBaseUrl === "string" && isHttpUrl(publicBaseUrl)) patch.publicBaseUrl = publicBaseUrl;
    } else {
      patch = { requirePairingForLan: true };
    }
    try {
      await settings.update(REMOTE_WEB_UI_NAMESPACE, patch);
      return "ok";
    } catch (error) {
      if (isUnregisteredNamespace(error)) return "unregistered";
      throw error;
    }
  }
};
function isUnregisteredNamespace(error) {
  const message = String(error instanceof Error ? error.message : error);
  return message.includes("not registered") || message.includes("No configurable plugin entry");
}
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}
async function applyWithRetry(compat, enabled, publicBaseUrl, attempts = 60, delayMs = 250) {
  let last = "unregistered";
  for (let i = 0; i < attempts; i++) {
    const result = await compat.apply(enabled, publicBaseUrl);
    if (result === "ok") return "ok";
    last = result;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return last;
}

// src/gateway.ts
import { readFile } from "node:fs/promises";
import { dirname as dirname5 } from "node:path";
import { serveStatic } from "@deepseek-ai/dsh-host-frontend-static";

// src/auth.ts
var COOKIE_NAME = "dsh_session";
function extractSessionToken(cookieHeader) {
  if (cookieHeader === void 0) return void 0;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${COOKIE_NAME}=`)) {
      return trimmed.slice(COOKIE_NAME.length + 1);
    }
  }
  return void 0;
}
function buildCookieHeader(token, ttlSeconds) {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${String(ttlSeconds)}`;
}
function buildClearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

// src/gateway.ts
function indexRenderer(ctx, distIndex) {
  return async () => {
    const body = await readFile(distIndex, "utf8");
    const webServer = ctx.webServer;
    const render = webServer.renderIndex ?? webServer.applyIndexTaps.bind(webServer);
    return render.call(webServer, body);
  };
}
function createAuthorizeIndex(ctx) {
  return (req, res) => {
    const connection = ctx.get("connection");
    if (connection === void 0) return true;
    return connection.authorizeIndex(req, res);
  };
}
function createGatewayHandler(ctx, config, store) {
  const distRoot = dirname5(config.distIndex);
  const renderIndex = indexRenderer(ctx, config.distIndex);
  const authorizeIndex = createAuthorizeIndex(ctx);
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    const token = extractSessionToken(req.headers.cookie);
    if (token === void 0 || store.verify(token) === void 0) {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }
    store.cleanup();
    const rawPath = new URL(req.url ?? "/", "http://x").pathname;
    await serveStatic(
      decodeURIComponent(rawPath),
      res,
      distRoot,
      config.distIndex,
      () => authorizeIndex(req, res),
      renderIndex
    );
  };
}

// src/api-bridge-auth.ts
function createApiBridgeAuth(store) {
  return async (request, response, next) => {
    const token = extractSessionToken(request.headers.cookie);
    const session = token === void 0 ? void 0 : store.verify(token);
    if (session !== void 0) {
      store.cleanup();
      return next();
    }
    response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
    response.end("unauthorized");
  };
}

// src/http-json.ts
import { homedir } from "node:os";
import { join } from "node:path";
var MAX_JSON_BODY_BYTES = 8192;
async function readBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > maxBytes) {
      throw new Error("body too large");
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function resolveDshHome() {
  const env = process.env.DSH_HOME;
  return env !== void 0 && env.length > 0 ? env : join(homedir(), ".dsh");
}

// src/login-api.ts
async function parseCredentials(req) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed.username !== "string" || typeof parsed.password !== "string") return null;
  return { username: parsed.username, password: parsed.password };
}
function learnRequestHost(req, hosts) {
  const host = req.headers.host;
  if (typeof host === "string" && host.length > 0) hosts.learn(host);
}
function createLoginHandler(deps) {
  return async (req, res) => {
    const creds = await parseCredentials(req);
    if (creds === null) {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    if (await deps.users.isEmpty()) {
      sendJson(res, 500, { error: "no users configured" });
      return;
    }
    const record = await deps.users.verify(creds.username, creds.password);
    if (record === void 0) {
      sendJson(res, 401, { error: "invalid credentials" });
      return;
    }
    await deps.users.touchLastLogin(record.username).catch(() => {
    });
    const session = deps.store.create(record.username, record.isAdmin);
    if (deps.autoTrust === true && deps.hosts !== void 0) learnRequestHost(req, deps.hosts);
    res.setHeader("Set-Cookie", buildCookieHeader(session.token, deps.sessionTtl));
    sendJson(res, 200, { ok: true });
  };
}
function createLogoutHandler(store) {
  return async (req, res) => {
    const token = extractSessionToken(req.headers.cookie);
    if (token !== void 0) store.revoke(token);
    res.setHeader("Set-Cookie", buildClearCookieHeader());
    res.writeHead(200);
    res.end();
  };
}
function createLogoutRedirectHandler(store) {
  return async (req, res) => {
    const token = extractSessionToken(req.headers.cookie);
    if (token !== void 0) store.revoke(token);
    res.setHeader("Set-Cookie", buildClearCookieHeader());
    res.writeHead(302, { Location: "/login" });
    res.end();
  };
}
function createSetupHandler(deps) {
  return async (req, res) => {
    if (!await deps.users.isEmpty()) {
      sendJson(res, 403, { error: "users already exist" });
      return;
    }
    const creds = await parseCredentials(req);
    if (creds === null || creds.password.length === 0) {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    let record;
    try {
      record = await deps.users.create(creds.username, creds.password, true);
    } catch {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    await deps.users.touchLastLogin(record.username).catch(() => {
    });
    const session = deps.store.create(record.username, record.isAdmin);
    if (deps.autoTrust === true && deps.hosts !== void 0) learnRequestHost(req, deps.hosts);
    res.setHeader("Set-Cookie", buildCookieHeader(session.token, deps.sessionTtl));
    sendJson(res, 200, { ok: true });
  };
}

// src/api-filter.ts
var USER_ALLOWED = /* @__PURE__ */ new Set([
  "session.list",
  "session.search",
  "session.create",
  "session.history",
  "session.models",
  "session.selectModel",
  "session.rename",
  "session.fork",
  "session.prompt",
  "session.attachment",
  "session.updateQueue",
  "session.cancel",
  "subagent.list",
  "subagent.history",
  "subagent.prompt",
  "subagent.interrupt",
  "host.describe",
  "workspace.list",
  "workspace.create",
  "workspace.rename",
  "workspace.delete",
  "workspace.insertBefore",
  "workspace.insertSessionBefore",
  "workspace.archiveSession",
  // DSH 0.1.6: restore one archived Session (pairs with archiveSession above).
  "workspace.unarchiveSession",
  // DSH 0.1.7: sidebar session pinning (pinned sessions ride the workspace
  // tree like rename/archive; both carry the workspace/session ids the guard's
  // GUARDED_ID_FIELDS already ownership-check).
  "workspace.pinSession",
  "workspace.unpinSession",
  // DSH 0.1.7: the job controller (`dsh-api-job-controller`, typert namespace
  // `job`; SessionJob moved here out of `session`). `list`/`follow` are
  // reconnect-safe streams and `kill` is the human stop button — the same
  // trust boundary as `session.prompt`. Every request carries `sessionId`
  // (JobFollowRequest omits it only for unowned jobs, which any caller may
  // observe), ownership-checked through the guard's GUARDED_ID_FIELDS. Note:
  // `jobId` must NOT be added to the guarded fields — job ids are not in the
  // ownership sidecar and every id collected must resolve owned, which would
  // deny legitimate kills.
  "job.list",
  "job.follow",
  "job.kill",
  // DSH 0.1.6: the sidebar terminal (`dsh-api-terminal-controller`, typert
  // namespace `terminal`). Every method is session-agent-scoped by the Gateway
  // (the `agent` argument is supplied by the Gateway itself, never by the
  // browser), so it stays inside the caller's own agent subtree — the same
  // trust boundary as `session.prompt` (an agent can already run shell for the
  // user). `terminal.list` addresses a session explicitly and is ownership-
  // checked through the guard's GUARDED_ID_FIELDS (`sessionId`).
  "terminal.environment",
  "terminal.shells",
  "terminal.list",
  "terminal.create",
  "terminal.follow",
  "terminal.write",
  "terminal.resize",
  "terminal.rename",
  "terminal.close",
  // DSH 0.1.6-alpha.2: terminal retention across reconnects. `terminal.retain`
  // addresses a session explicitly (`sessionId`) and is ownership-checked
  // through GUARDED_ID_FIELDS like terminal.list. NOTE: since alpha.2 user
  // terminals run with the execution environment's system-user permissions
  // (no Agent sandbox), a deployment wanting stricter posture subtracts the
  // terminal.* entries from this set before wrapping (see docs/adapt-dsh-0.1.6-alpha.2.md).
  "terminal.retain",
  // DSH 0.1.6-alpha.2: the right Sidebar's document preview. The read surface
  // of `workspaceFiles` + the Office→PDF converter (`officeToPdf`) are what
  // every user's document/Office preview tab calls; each method's first wire
  // argument is the scoped session identity (`workspaceFileScopeId`), resolved
  // by the Gateway's workspaceFileScope lookup and ownership-checked through
  // GUARDED_ID_FIELDS. Read-only: no write/convert-bytes method is exposed to
  // the wire surface listed here.
  "workspaceFiles.read",
  "workspaceFiles.readAll",
  "workspaceFiles.readBytes",
  "workspaceFiles.readRelated",
  "workspaceFiles.stat",
  "workspaceFiles.list",
  "workspaceFiles.changes",
  "officeToPdf.render",
  "officeToPdf.generation",
  "skill.list",
  "llm.providers",
  "llm.models",
  "goal.create",
  "goal.edit",
  "goal.pause",
  "goal.resume",
  "goal.complete",
  "goal.clear",
  "respond"
]);

// src/capabilities.ts
function userAllowedMethods() {
  return [...USER_ALLOWED];
}
var USER_DOMAINS = [
  "session",
  "workspace",
  "goals",
  "subagents",
  "llm",
  "host",
  "skill",
  "api",
  // DSH 0.1.6: the sidebar terminal (dsh-api-terminal-controller) — every
  // method is session-agent-scoped by the Gateway, so it rides the caller's
  // own agent subtree like `session` does.
  "terminal",
  // DSH 0.1.6-alpha.2: the right Sidebar's document preview — the read-only
  // workspaceFiles surface plus the Office→PDF converter, both scoped to the
  // viewed session identity (workspaceFileScopeId) the Gateway resolves.
  "workspaceFiles",
  "officeToPdf",
  // DSH 0.1.7: the job controller (SessionJob moved here out of `session`) —
  // list/follow/kill with the request's sessionId ownership-checked by the
  // guard (USER_ALLOWED carries job.list/job.follow/job.kill).
  "job"
];
var ADMIN_ONLY_UI_PLUGINS = [
  "@linxin666/dsh-client-ui-plugin-manager",
  "@linxin666/dsh-client-ui-skill-explorer",
  "@linxin666/dsh-client-ui-skin-center",
  "@linxin666/dsh-client-ui-market",
  "@linxin666/dsh-client-ui-git-graph",
  "@linxin666/dsh-client-ui-community-plugins",
  "@linxin666/dsh-client-ui-web-ui-settings",
  "@linxin666/dsh-client-ui-aionui-panel",
  "@linxin666/dsh-client-ui-task-board",
  "@linxin666/dsh-desktop-launcher",
  "@linxin666/dsh-doctor",
  "@linxin666/dsh-pet",
  "@linxin666/dsh-ssh",
  "@linxin666/dsh-perf",
  "@linxin666/dsh-liangshen"
];
var CORE_UI_PLUGINS = [
  "@islibaodong/dsh-login"
];
function deriveCapabilities(user) {
  if (user.isAdmin) {
    return {
      methods: userAllowedMethods().concat(adminOnlyMethods()),
      domains: allDomains(),
      uiPlugins: CORE_UI_PLUGINS.concat(allUiPlugins())
    };
  }
  return {
    methods: userAllowedMethods(),
    domains: [...USER_DOMAINS],
    uiPlugins: [...CORE_UI_PLUGINS]
  };
}
function adminOnlyMethods() {
  return [
    "credentials.list",
    "credentials.get",
    "credentials.set",
    "credentials.delete",
    // DSH 0.1.7: exact wire-method names of the settings controller
    // (describe/update/replace — `settings.list`/`settings.reset` never
    // existed on the wire; `canOpenAgentPresetDirectory` was removed in 0.1.7).
    "settings.describe",
    "settings.update",
    "settings.replace",
    "agentPreset.list",
    "agentPreset.read",
    "agentPreset.write",
    // DSH 0.1.7-rc.1: the preset registry's document viewer
    // (`agentPresets.readDocument` — view one declaration's child plugin
    // list). Same strictly-admin posture as the rest of the namespace.
    "agentPresets.readDocument",
    "host.path",
    "host.system",
    // DSH 0.1.6-alpha.2: the native plugin manager (packages/boot/
    // plugin-manager, typert namespace `pluginManager`) — installs, enables,
    // disables, and removes profile bundles. Strictly admin-only: never added
    // to USER_ALLOWED, and ADMIN_ONLY_NAMESPACES denies it for ordinary users.
    "pluginManager.listPlugins",
    "pluginManager.listBundles",
    "pluginManager.inspect",
    "pluginManager.setPluginEnabled",
    "pluginManager.setBundleEnabled",
    "pluginManager.installBundle",
    "pluginManager.cancelInstall",
    "pluginManager.removeBundle",
    // DSH 0.1.7: the account controller (typert namespace `account`) — the
    // process-wide upstream DeepSeek Platform grant: browser sign-in, cancel,
    // and revoke are whole-instance operations; even the read projections
    // (state/profile/recharge-wallet balance) are the operator's data.
    // Ordinary users are denied by default; advertised here for admins.
    "account.getState",
    "account.getProfile",
    "account.getBalance",
    "account.startSignIn",
    "account.cancelSignIn",
    "account.signOut",
    "account.watch",
    // DSH 0.1.7: the plugin-registry probe the new bundled plugin-manager UI
    // uses (client/ui-plugin-manager, service id `pluginRegistryProbe`) —
    // same strictly-admin posture as pluginManager.
    "pluginRegistryProbe.list"
  ];
}
function allDomains() {
  return [
    ...USER_DOMAINS,
    "credentials",
    "settings",
    "agentPresets",
    "pluginManager",
    // DSH 0.1.7: the account controller's namespace (admin-only; see
    // remote-guard's ADMIN_ONLY_NAMESPACES and the two-segment deny list).
    "account"
  ];
}
function allUiPlugins() {
  return [...CORE_UI_PLUGINS, ...ADMIN_ONLY_UI_PLUGINS];
}

// src/admin-api.ts
function requireSession(deps, req) {
  const token = extractSessionToken(req.headers.cookie);
  return token === void 0 ? void 0 : deps.store.verify(token);
}
async function readJsonObject(req) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
function requireAdmin(deps, req, res) {
  const session = requireSession(deps, req);
  if (session === void 0) {
    sendJson(res, 401, { error: "authentication required" });
    return void 0;
  }
  if (!session.isAdmin) {
    sendJson(res, 403, { error: "admin required" });
    return void 0;
  }
  return session;
}
function createAdminRoutes(deps) {
  const me = { kind: "exact", path: "/api/auth/me", handler: async (req, res) => {
    const session = requireSession(deps, req);
    if (session === void 0) return sendJson(res, 401, { error: "authentication required" });
    return sendJson(res, 200, { username: session.user, isAdmin: session.isAdmin });
  } };
  const capabilitiesRoute = { kind: "exact", path: "/api/auth/capabilities", handler: async (req, res) => {
    const session = requireSession(deps, req);
    if (session === void 0) return sendJson(res, 401, { error: "authentication required" });
    return sendJson(res, 200, {
      username: session.user,
      isAdmin: session.isAdmin,
      capabilities: deriveCapabilities({ username: session.user, isAdmin: session.isAdmin })
    });
  } };
  const usersRoute = { kind: "exact", path: "/api/auth/admin/users", handler: async (req, res) => {
    if (req.method === "GET") {
      if (requireAdmin(deps, req, res) === void 0) return;
      const records = await deps.users.list();
      const online = deps.store.onlineCounts();
      return sendJson(res, 200, {
        users: records.map((record) => ({
          username: record.username,
          isAdmin: record.isAdmin,
          lastLoginAt: record.lastLoginAt ?? null,
          disabled: record.disabled === true,
          onlineSessions: online.get(record.username) ?? 0
        }))
      });
    }
    if (requireAdmin(deps, req, res) === void 0) return;
    const body = await readJsonObject(req);
    if (body === null) return sendJson(res, 400, { error: "bad request" });
    const { username, password, isAdmin } = body;
    if (typeof username !== "string" || typeof password !== "string" || password.length === 0) {
      return sendJson(res, 400, { error: "bad request" });
    }
    if (isAdmin !== void 0 && typeof isAdmin !== "boolean") return sendJson(res, 400, { error: "bad request" });
    if ((await deps.users.list()).some((u) => u.username === username)) {
      return sendJson(res, 409, { error: "user exists" });
    }
    try {
      await deps.users.create(username, password, isAdmin === true);
    } catch {
      return sendJson(res, 400, { error: "bad request" });
    }
    return sendJson(res, 201, { ok: true });
  } };
  const userPassword = { kind: "exact", path: "/api/auth/admin/users/password", handler: async (req, res) => {
    if (requireAdmin(deps, req, res) === void 0) return;
    const body = await readJsonObject(req);
    if (body === null) return sendJson(res, 400, { error: "bad request" });
    const { username, password } = body;
    if (typeof username !== "string" || typeof password !== "string" || password.length === 0) {
      return sendJson(res, 400, { error: "bad request" });
    }
    try {
      await deps.users.setPassword(username, password);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("unknown user")) return sendJson(res, 404, { error: "unknown user" });
      return sendJson(res, 400, { error: "bad request" });
    }
    deps.store.revokeAllFor(username);
    return sendJson(res, 200, { ok: true });
  } };
  const userRemove = { kind: "exact", path: "/api/auth/admin/users/remove", handler: async (req, res) => {
    if (requireAdmin(deps, req, res) === void 0) return;
    const body = await readJsonObject(req);
    if (body === null || typeof body.username !== "string") return sendJson(res, 400, { error: "bad request" });
    const target = body.username;
    const records = await deps.users.list();
    const record = records.find((u) => u.username === target);
    if (record === void 0) return sendJson(res, 404, { error: "unknown user" });
    if (record.isAdmin && records.filter((u) => u.isAdmin).length === 1) {
      return sendJson(res, 409, { error: "cannot remove the last admin" });
    }
    await deps.users.remove(target);
    deps.store.revokeAllFor(target);
    return sendJson(res, 200, { ok: true });
  } };
  const hosts = deps.hosts;
  const hostsRoute = hosts === void 0 ? void 0 : { kind: "exact", path: "/api/auth/admin/hosts", handler: async (req, res) => {
    if (req.method === "GET") {
      if (requireAdmin(deps, req, res) === void 0) return;
      return sendJson(res, 200, { hosts: hosts.list() });
    }
    if (req.method !== "POST" && req.method !== "DELETE") {
      if (requireAdmin(deps, req, res) === void 0) return;
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if (requireAdmin(deps, req, res) === void 0) return;
    const body = await readJsonObject(req);
    if (body === null || typeof body.host !== "string" || body.host.length === 0) {
      return sendJson(res, 400, { error: "bad request" });
    }
    const raw = body.host;
    if (raw.length > MAX_HOST_LENGTH || !isBareAuthority(raw)) {
      return sendJson(res, 400, { error: "invalid host" });
    }
    const canonical = hosts.canonicalize(raw);
    if (req.method === "POST") {
      const added = hosts.add(raw);
      return sendJson(res, added ? 201 : 200, { ok: true, host: canonical });
    }
    hosts.remove(canonical);
    return sendJson(res, 200, { ok: true, host: canonical });
  } };
  const userDisable = { kind: "exact", path: "/api/auth/admin/users/disable", handler: async (req, res) => {
    if (requireAdmin(deps, req, res) === void 0) return;
    const body = await readJsonObject(req);
    if (body === null || typeof body.username !== "string" || typeof body.disabled !== "boolean") {
      return sendJson(res, 400, { error: "bad request" });
    }
    const target = body.username;
    const records = await deps.users.list();
    const record = records.find((u) => u.username === target);
    if (record === void 0) return sendJson(res, 404, { error: "unknown user" });
    if (body.disabled && record.isAdmin && records.filter((u) => u.isAdmin && u.disabled !== true).length === 1) {
      return sendJson(res, 409, { error: "cannot disable the last enabled admin" });
    }
    await deps.users.setDisabled(target, body.disabled);
    if (body.disabled) deps.store.revokeAllFor(target);
    return sendJson(res, 200, { ok: true });
  } };
  const setting = deps.defaultWorkspaceSetting;
  const settingRoute = setting === void 0 ? void 0 : { kind: "exact", path: "/api/auth/admin/settings/default-workspace", handler: async (req, res) => {
    if (requireAdmin(deps, req, res) === void 0) return;
    if (req.method === "GET") return sendJson(res, 200, { enabled: setting.get() });
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    const body = await readJsonObject(req);
    if (body === null || typeof body.enabled !== "boolean") return sendJson(res, 400, { error: "bad request" });
    setting.set(body.enabled);
    return sendJson(res, 200, { ok: true, enabled: setting.get() });
  } };
  const remoteSetting = deps.remoteWebUiSetting;
  const remoteSettingRoute = remoteSetting === void 0 ? void 0 : { kind: "exact", path: "/api/auth/admin/settings/remote-web-ui-compat", handler: async (req, res) => {
    if (requireAdmin(deps, req, res) === void 0) return;
    if (req.method === "GET") return sendJson(res, 200, { enabled: remoteSetting.get() });
    if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
    const body = await readJsonObject(req);
    if (body === null || typeof body.enabled !== "boolean") return sendJson(res, 400, { error: "bad request" });
    remoteSetting.set(body.enabled);
    let applied = "skipped";
    if (deps.onRemoteWebUiApply !== void 0) applied = await deps.onRemoteWebUiApply(body.enabled);
    return sendJson(res, 200, { ok: true, enabled: remoteSetting.get(), applied });
  } };
  const routes = [me, capabilitiesRoute, usersRoute, userPassword, userRemove, userDisable];
  if (hostsRoute !== void 0) routes.push(hostsRoute);
  if (settingRoute !== void 0) routes.push(settingRoute);
  if (remoteSettingRoute !== void 0) routes.push(remoteSettingRoute);
  return routes;
}

// src/login-page.ts
var BOARD_JS = `
    (function () {
      var reduce = window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var board = document.getElementById('board');
      var pane = document.getElementById('paneDark');
      var CELL = 72, SIZE = 56;

      function layout() {
        board.innerHTML = '';
        var W = pane.clientWidth, H = pane.clientHeight;
        var cols = Math.ceil(W / CELL);
        var rows = Math.ceil(H / CELL);
        var count = Math.min(18, Math.max(8, Math.round(cols * rows * 0.04)));
        var picks = {};
        var placed = 0, guard = 0;
        while (placed < count && guard++ < cols * rows * 4) {
          var c = Math.floor(Math.random() * cols);
          var r = Math.floor(Math.random() * rows);
          var x = c * CELL + (CELL - SIZE) / 2;
          var y = r * CELL + (CELL - SIZE) / 2;
          // keep the space behind the text block clean
          if (x < 520 && y > H * 0.18 && y < H * 0.82) continue;
          var key = c + ':' + r;
          if (picks[key]) continue;
          picks[key] = true;
          var t = document.createElement('div');
          t.className = 'tile' + (Math.random() < 0.35 ? ' tile--lit' : '');
          t.style.left = x + 'px';
          t.style.top = y + 'px';
          t.style.setProperty('--d', (placed * 45) + 'ms');
          if (!reduce && Math.random() < 0.4) {
            t.style.setProperty('--breath-delay', (6 + Math.random() * 16) + 's');
          }
          board.appendChild(t);
          placed++;
        }
      }

      var tm;
      window.addEventListener('resize', function () {
        clearTimeout(tm);
        tm = setTimeout(layout, 200);
      });
      layout();
    })();
`;
var BASE_CSS = `
    :root {
      --bg: #0f1420;
      --panel: #151b2c;
      --inset: #0d1220;
      --line: #262f47;
      --line-soft: #1c2438;
      --text: #e8ebf4;
      --muted: #97a0b6;
      --accent: #6f9bff;
      --accent-soft: rgba(111, 155, 255, 0.14);
      --ok: #46d19a;
      --lt-bg: #f3f5fa;
      --lt-card: #ffffff;
      --lt-line: #e1e6f1;
      --lt-inset: #f6f8fc;
      --lt-text: #1d2536;
      --lt-muted: #67718c;
      --danger: #d64545;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
        "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      min-height: 100vh;
    }

    .split {
      display: flex;
      min-height: 100vh;
    }
    .pane { flex: 1 1 50%; position: relative; }

    /* ---- left: the dark DSH side ---- */
    .pane--dark {
      flex-basis: 53%;
      background: var(--bg);
      overflow: hidden;
    }
    .board-bg {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(var(--line-soft) 1px, transparent 1px),
        linear-gradient(90deg, var(--line-soft) 1px, transparent 1px);
      background-size: 72px 72px;
      opacity: 0.35;
    }
    .board-bg::after {
      content: '';
      position: absolute;
      inset: 0;
      background: radial-gradient(
        ellipse 90% 80% at 30% 50%,
        transparent 30%, var(--bg) 100%
      );
    }
    #board { position: absolute; inset: 0; pointer-events: none; }
    .tile {
      position: absolute;
      width: 56px;
      height: 56px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(21, 27, 44, 0.55);
      opacity: 0;
      animation: tileIn 0.6s ease both;
      animation-delay: var(--d, 0ms);
    }
    .tile--lit {
      border-color: rgba(111, 155, 255, 0.45);
      background: var(--accent-soft);
      animation: tileIn 0.6s ease both, breath 7s ease-in-out infinite;
      animation-delay: var(--d, 0ms), var(--breath-delay, 4s);
    }
    .tile--lit::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 6px;
      height: 6px;
      margin: -3px 0 0 -3px;
      border-radius: 50%;
      background: var(--accent);
      opacity: 0.8;
    }
    @keyframes tileIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 0.9; transform: none; }
    }
    @keyframes breath {
      0%, 100% { box-shadow: 0 0 0 0 rgba(111, 155, 255, 0); }
      50% { box-shadow: 0 0 22px 0 rgba(111, 155, 255, 0.16); }
    }

    .pane-content {
      position: relative;
      height: 100%;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      padding: 48px 60px;
      max-width: 560px;
      animation: rise 0.55s cubic-bezier(0.22, 0.8, 0.36, 1) both;
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: none; }
    }

    .brand-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-row svg { flex: none; }
    .brand-row .wordmark {
      font-size: 2.35rem;
      font-weight: 750;
      letter-spacing: 0.02em;
      line-height: 1;
    }
    .kicker {
      margin-top: 16px;
      font-size: 0.82rem;
      font-weight: 600;
      color: var(--accent);
      letter-spacing: 0.01em;
    }
    .lead {
      margin-top: 10px;
      font-size: 0.88rem;
      color: var(--muted);
      line-height: 1.75;
      max-width: 26em;
    }

    .features {
      list-style: none;
      margin-top: 44px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .features li {
      display: flex;
      align-items: flex-start;
      gap: 14px;
    }
    .features li i {
      flex: none;
      width: 9px;
      height: 9px;
      margin-top: 5px;
      border-radius: 2.5px;
      background: var(--accent-soft);
      border: 1px solid rgba(111, 155, 255, 0.5);
    }
    .features li b {
      display: block;
      font-size: 0.92rem;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 3px;
    }
    .features li span {
      display: block;
      font-size: 0.78rem;
      color: var(--muted);
      line-height: 1.6;
    }

    .footnote {
      position: absolute;
      left: 60px;
      bottom: 56px;
      font-size: 0.7rem;
      color: #6b7490;
      line-height: 1.6;
    }
    .loaded {
      position: absolute;
      left: 60px;
      bottom: 30px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.7rem;
      color: #6b7490;
    }
    .loaded i {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--ok);
      box-shadow: 0 0 6px rgba(70, 209, 154, 0.55);
    }

    /* ---- right: the light form side ---- */
    .pane--light {
      background: var(--lt-bg);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 40px 32px;
    }
    /* soft blue glow seating the card */
    .pane--light::after {
      content: '';
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: radial-gradient(
        ellipse 55% 48% at 50% 46%,
        rgba(111, 155, 255, 0.09), transparent 70%
      );
    }

    /* ghost plugin tiles: the board's quiet echoes on this side */
    .ghost {
      position: absolute;
      width: 46px;
      height: 46px;
      border: 1px solid #dfe5f0;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.7);
      pointer-events: none;
      animation: rise 0.7s cubic-bezier(0.22, 0.8, 0.36, 1) both;
    }
    .ghost--g1 { top: 11%; left: 13%; animation-delay: 320ms; }
    .ghost--g2 { bottom: 13%; right: 11%; animation-delay: 420ms; }
    .ghost--g3 {
      top: 15%;
      right: 15%;
      border-color: rgba(111, 155, 255, 0.4);
      background: #eef2fd;
      animation-delay: 520ms;
    }
    .ghost--g3::before {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 5px;
      height: 5px;
      margin: -2.5px 0 0 -2.5px;
      border-radius: 50%;
      background: var(--accent);
      opacity: 0.7;
    }

    /* free plugin slots, top-right: one is taken */
    .slots {
      position: absolute;
      top: 26px;
      right: 30px;
      display: flex;
      gap: 7px;
      pointer-events: none;
      animation: rise 0.7s cubic-bezier(0.22, 0.8, 0.36, 1) both;
      animation-delay: 600ms;
    }
    .slots span {
      width: 9px;
      height: 9px;
      border: 1px solid #cdd6e6;
      border-radius: 3px;
    }
    .slots span:first-child {
      background: var(--accent);
      border-color: var(--accent);
      opacity: 0.75;
    }

    .card {
      position: relative;
      z-index: 1;
      width: 372px;
      max-width: 100%;
      background: var(--lt-card);
      border: 1px solid var(--lt-line);
      border-radius: 16px;
      padding: 34px 34px 30px;
      box-shadow: 0 14px 36px rgba(23, 32, 55, 0.08);
      animation: rise 0.55s cubic-bezier(0.22, 0.8, 0.36, 1) both;
      animation-delay: 130ms;
    }
    .card h1 {
      font-size: 1.3rem;
      font-weight: 650;
      color: var(--lt-text);
      margin-bottom: 6px;
    }
    .card .subtitle {
      font-size: 0.82rem;
      color: var(--lt-muted);
      line-height: 1.6;
      margin-bottom: 20px;
    }
    .field { margin-bottom: 14px; }
    .card input[type="text"], .card input[type="password"] {
      width: 100%;
      padding: 11px 14px;
      background: var(--lt-inset);
      border: 1px solid var(--lt-line);
      border-radius: 9px;
      color: var(--lt-text);
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.15s;
    }
    .card input::placeholder { color: #9aa3b8; }
    .card input[type="text"]:focus,
    .card input[type="password"]:focus {
      border-color: var(--accent);
    }
    .card input:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .card button[type="submit"] {
      width: 100%;
      padding: 11px;
      margin-top: 4px;
      background: var(--accent);
      border: none;
      border-radius: 9px;
      color: #fff;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .card button[type="submit"]:hover { background: #5d8dfe; }
    .card button[type="submit"]:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .card button[type="submit"]:disabled {
      background: #b6c4e4;
      cursor: not-allowed;
    }
    .error {
      color: var(--danger);
      font-size: 0.82rem;
      min-height: 1.3em;
      margin-bottom: 10px;
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
      .tile { opacity: 0.9; }
    }

    /* ---- narrow screens: dark story stacks on top of the form ---- */
    @media (max-width: 880px) {
      .split { flex-direction: column; }
      .pane--dark { flex-basis: auto; overflow: visible; }
      .pane-content {
        min-height: 0;
        padding: 36px 28px 30px;
      }
      .features { margin-top: 28px; gap: 14px; }
      .footnote { position: static; margin-top: 24px; }
      .loaded { position: static; margin-top: 10px; }
      .tile { display: none; }
      .pane--light { padding: 36px 24px 44px; }
      .ghost, .slots { display: none; }
    }
`;
var PLUG_SVG = `
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
        stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round"
        stroke-linejoin="round" aria-hidden="true">
        <path d="M9 7V3" /><path d="M15 7V3" />
        <path d="M7 7h10v4a5 5 0 0 1-5 5 5 5 0 0 1-5-5V7z" />
        <path d="M12 16v5" />
      </svg>`;
function renderPage(opts) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${opts.title}</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <main class="split">
    <section class="pane pane--dark" id="paneDark">
      <div class="board-bg" aria-hidden="true"></div>
      <div id="board" aria-hidden="true"></div>
      <div class="pane-content">
        <header class="brand">
          <div class="brand-row">${PLUG_SVG}<div class="wordmark">DSH</div></div>
          <p class="kicker">\u591A\u7528\u6237\u767B\u5F55\u7F51\u5173\uFF0C\u800C\u8FD9\u9053\u95E8\u672C\u8EAB\u4E5F\u662F\u4E00\u4E2A\u63D2\u4EF6\u3002</p>
          <p class="lead">DSH \u7684 Web GUI \u6309\u300C\u5355\u7528\u6237\u3001localhost\u300D\u8BBE\u8BA1\u2014\u2014\u4E00\u65E6\u66B4\u9732\u5230\u7F51\u7EDC\uFF0C\u4EFB\u4F55\u4EBA\u90FD\u80FD\u6253\u5F00\u5B83\u3002dsh-login \u52A0\u4E00\u9053\u767B\u5F55\u5899\uFF0C\u628A\u5B83\u53D8\u6210\u5B89\u5168\u7684\u591A\u7528\u6237\u90E8\u7F72\u3002</p>
        </header>
        <ul class="features">
          <li><i></i><div><b>\u767B\u5F55\u5899</b><span>\u9875\u9762\u3001\u9759\u6001\u8D44\u6E90\u3001API \u4E0E WebSocket \u5168\u90E8\u8981\u6C42\u6709\u6548\u4F1A\u8BDD\uFF0C\u672A\u767B\u5F55\u4E00\u5F8B\u56DE\u5230\u8FD9\u9053\u95E8</span></div></li>
          <li><i></i><div><b>\u4F1A\u8BDD\u9694\u79BB</b><span>\u666E\u901A\u7528\u6237\u53EA\u770B\u5230\u81EA\u5DF1\u7684\u5BF9\u8BDD\u3001\u5B50\u4EE3\u7406\u4E0E\u5DE5\u4F5C\u533A\uFF1B\u51ED\u636E\u3001\u5BBF\u4E3B\u8BBE\u7F6E\u7B49\u7BA1\u7406\u57DF\u6574\u4F53\u7981\u7528</span></div></li>
          <li><i></i><div><b>\u7528\u6237\u7BA1\u7406</b><span>\u7BA1\u7406\u5458\u5728 \u8BBE\u7F6E \u2192 \u7528\u6237\u7BA1\u7406 \u65B0\u5EFA\u3001\u91CD\u7F6E\u5BC6\u7801\u3001\u7981\u7528\u3001\u5220\u9664\uFF0C\u64CD\u4F5C\u7ACB\u5373\u540A\u9500\u8BE5\u7528\u6237\u7684\u4F1A\u8BDD</span></div></li>
          <li><i></i><div><b>\u8FDC\u7A0B\u53CB\u597D</b><span>frp\u3001\u96A7\u9053\u6216\u5C40\u57DF\u7F51\u8BBF\u95EE\uFF0C\u767B\u5F55\u4E00\u6B21\u5373\u81EA\u52A8\u4FE1\u4EFB\u4E3B\u673A\uFF0C\u65E0\u9700\u624B\u52A8\u6539\u914D\u7F6E</span></div></li>
        </ul>
      </div>
      <div class="footnote">\u5BC6\u7801\u4EE5 scrypt \u54C8\u5E0C\u5B58\u50A8\uFF0C\u4F1A\u8BDD Cookie \u4E3A HttpOnly\uFF0C\u91CD\u542F\u540E\u767B\u5F55\u4F9D\u7136\u6709\u6548\u3002</div>
      <div class="loaded"><i></i>dsh-login \u5DF2\u52A0\u8F7D</div>
    </section>
    <section class="pane pane--light">
      <div class="ghost ghost--g1" aria-hidden="true"></div>
      <div class="ghost ghost--g2" aria-hidden="true"></div>
      <div class="ghost ghost--g3" aria-hidden="true"></div>
      <div class="slots" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
      <div class="card">
        <h1>${opts.heading}</h1>
        <div class="subtitle">${opts.subtitle}</div>
        <div class="error" id="error" role="alert"></div>
        <form id="authForm">${opts.fields}</form>
      </div>
    </section>
  </main>
  <script>${opts.script}</script>
  <script>${BOARD_JS}</script>
</body>
</html>`;
}
function renderLoginPage() {
  return renderPage({
    title: "DSH \u767B\u5F55",
    heading: "\u767B\u5F55 DSH",
    subtitle: "\u591A\u7528\u6237\u7F51\u5173\uFF1A\u6BCF\u4EBA\u72EC\u7ACB\u4F1A\u8BDD\uFF0C\u6743\u9650\u5404\u5F52\u5176\u4F4D\u3002",
    fields: `
        <div class="field">
          <input type="text" name="username" id="username" placeholder="\u7528\u6237\u540D"
            autocomplete="username" autofocus required>
        </div>
        <div class="field">
          <input type="password" name="password" id="password" placeholder="\u5BC6\u7801"
            autocomplete="current-password" required>
        </div>
        <button type="submit" id="submit">\u767B\u5F55</button>`,
    script: `
    var form = document.getElementById('authForm');
    var username = document.getElementById('username');
    var password = document.getElementById('password');
    var error = document.getElementById('error');
    var submit = document.getElementById('submit');

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      submit.textContent = '\u9A8C\u8BC1\u4E2D\u2026';
      try {
        var res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.value, password: password.value }),
        });
        if (res.ok) {
          window.location = '/';
        } else if (res.status === 401) {
          error.textContent = '\u7528\u6237\u540D\u6216\u5BC6\u7801\u9519\u8BEF';
          password.value = '';
          password.focus();
        } else if (res.status === 400) {
          error.textContent = '\u8BF7\u6C42\u65E0\u6548';
        } else if (res.status === 500) {
          error.textContent = '\u5C1A\u672A\u521B\u5EFA\u4EFB\u4F55\u7528\u6237\uFF0C\u8BF7\u5237\u65B0\u9875\u9762\u5B8C\u6210\u521D\u59CB\u5316';
        } else {
          error.textContent = '\u672A\u77E5\u9519\u8BEF';
        }
      } catch (err) {
        error.textContent = '\u7F51\u7EDC\u9519\u8BEF\uFF0C\u8BF7\u91CD\u8BD5';
      } finally {
        submit.disabled = false;
        submit.textContent = '\u767B\u5F55';
      }
    });`
  });
}
function renderSetupPage() {
  return renderPage({
    title: "DSH \u521D\u59CB\u5316",
    heading: "\u521D\u59CB\u5316 DSH",
    subtitle: "\u521B\u5EFA\u7B2C\u4E00\u4E2A\u8D26\u6237\uFF0C\u5B83\u5C06\u81EA\u52A8\u6210\u4E3A\u7BA1\u7406\u5458\u3002",
    fields: `
        <div class="field">
          <input type="text" name="username" id="username" placeholder="\u7528\u6237\u540D"
            autocomplete="username" autofocus required>
        </div>
        <div class="field">
          <input type="password" name="password" id="password" placeholder="\u8BBE\u7F6E\u5BC6\u7801"
            autocomplete="new-password" required>
        </div>
        <div class="field">
          <input type="password" id="confirm" placeholder="\u786E\u8BA4\u5BC6\u7801"
            autocomplete="new-password" required>
        </div>
        <button type="submit" id="submit">\u521B\u5EFA\u8D26\u6237</button>`,
    script: `
    var form = document.getElementById('authForm');
    var username = document.getElementById('username');
    var pw = document.getElementById('password');
    var cf = document.getElementById('confirm');
    var error = document.getElementById('error');
    var submit = document.getElementById('submit');

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      error.textContent = '';
      if (username.value.length < 1) {
        error.textContent = '\u7528\u6237\u540D\u4E0D\u80FD\u4E3A\u7A7A';
        return;
      }
      if (pw.value.length < 1) {
        error.textContent = '\u5BC6\u7801\u4E0D\u80FD\u4E3A\u7A7A';
        return;
      }
      if (pw.value !== cf.value) {
        error.textContent = '\u4E24\u6B21\u8F93\u5165\u7684\u5BC6\u7801\u4E0D\u4E00\u81F4';
        cf.value = '';
        cf.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = '\u521B\u5EFA\u4E2D\u2026';
      try {
        var res = await fetch('/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.value, password: pw.value }),
        });
        if (res.ok) {
          window.location = '/';
        } else if (res.status === 403) {
          error.textContent = '\u521D\u59CB\u5316\u5DF2\u5B8C\u6210\uFF0C\u8BF7\u76F4\u63A5\u767B\u5F55';
        } else if (res.status === 400) {
          error.textContent = '\u8BF7\u6C42\u65E0\u6548\uFF08\u7528\u6237\u540D\u9650\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u4E0B\u5212\u7EBF\u548C\u8FDE\u5B57\u7B26\uFF0C\u6700\u957F 32 \u4F4D\uFF09';
        } else {
          error.textContent = '\u672A\u77E5\u9519\u8BEF';
        }
      } catch (err) {
        error.textContent = '\u7F51\u7EDC\u9519\u8BEF\uFF0C\u8BF7\u91CD\u8BD5';
      } finally {
        submit.disabled = false;
        submit.textContent = '\u521B\u5EFA\u8D26\u6237';
      }
    });`
  });
}

// src/web-runtime.ts
import { networkInterfaces } from "node:os";
import { createRequire } from "node:module";
var ALL_INTERFACES_HOST = "0.0.0.0";
function resolveLanTrust(bindHost, extra) {
  const lanAddresses = bindHost === ALL_INTERFACES_HOST ? Object.values(networkInterfaces()).flat().filter((iface) => iface !== void 0 && iface.family === "IPv4" && !iface.internal).map((iface) => iface.address) : [];
  return { lanAddresses, trustedHosts: [...lanAddresses, ...extra] };
}
function resolveDistIndex() {
  const require2 = createRequire(import.meta.url);
  try {
    return require2.resolve("@deepseek-ai/dsh-web-frontend/dist/index.html");
  } catch {
    throw new Error("dsh-login: frontend dist not found; run pnpm run build from the deepseek-harness repository root first, or set config.distIndex explicitly");
  }
}
var DSH_WEB_URL = "DSH_WEB_URL";
var LOOPBACK_HOST = "127.0.0.1";
function printWebUrl(ctx, runtime) {
  const print = () => {
    const webServer = ctx.get("webServer");
    if (webServer === void 0) return;
    const lanCandidate = runtime.lanAddresses[0];
    const suffix = lanCandidate === void 0 ? "" : ` (LAN: http://${lanCandidate}:${String(webServer.port)})`;
    console.log(`dsh web: http://${LOOPBACK_HOST}:${String(webServer.port)}${suffix}`);
  };
  const settled = ctx.get("loader")?.await();
  if (settled === void 0) print();
  else void settled.then(() => print(), () => {
  });
}
function provideWebRuntime(ctx, trustedHosts) {
  const runtime = resolveLanTrust(ctx.webServer.host, trustedHosts);
  ctx.provide("webRuntime", runtime);
  printWebUrl(ctx, runtime);
  const shellEnv = ctx.get("shellEnv");
  if (shellEnv !== void 0) {
    ctx.effect(() => shellEnv.register({
      name: "web-runtime",
      variables: {
        [DSH_WEB_URL]: { description: "Canonical local URL of the DeepSeek Harness Web GUI serving this session." }
      },
      resolve: () => {
        const port = ctx.get("webServer")?.port;
        return { [DSH_WEB_URL]: port === void 0 ? "" : `http://127.0.0.1:${String(port)}` };
      }
    }), "dsh-login: DSH_WEB_URL shell variable");
  }
  return runtime;
}

// src/remote-guard.ts
var ADMIN_ONLY_NAMESPACES = /* @__PURE__ */ new Set([
  "credentials",
  "settings",
  "agentPresets",
  // DSH 0.1.6-alpha.2: the native plugin manager installs, enables, disables,
  // and removes profile bundles — never reachable by an ordinary user.
  "pluginManager",
  // DSH 0.1.7-alpha.2: the account controller (`namespace: 'account'`) drives
  // the process-wide upstream DeepSeek Platform grant — startSignIn/signOut/
  // cancelSignIn rebind or revoke THE instance's account — and even the read
  // projections (getState/getProfile/getBalance) expose the operator's
  // profile and recharge-wallet balance. Entire namespace is admin-only;
  // ordinary users are denied by default (absent from USER_ALLOWED), this is
  // defense-in-depth, and capabilities.ts mirrors it in the two-segment deny
  // list and the quiet-deny set.
  "account"
]);
var GUARDED_ID_FIELDS = [
  "sessionId",
  "sessionIds",
  "parentSessionId",
  "parentSessionIds",
  "childSessionId",
  "childSessionIds",
  "agentId",
  "workspaceId",
  "beforeSessionId",
  // DSH 0.1.6-alpha.2: the scoped session identity the Gateway's
  // workspaceFileScope lookup resolves for the document-preview surface
  // (`workspaceFiles.*`, `officeToPdf.render`) — carries a SessionId on the
  // wire exactly like `sessionId`.
  "workspaceFileScopeId"
];
function collectIds(value) {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (Array.isArray(value)) return value.flatMap(collectIds);
  if (typeof value === "object" && value !== null) {
    const record = value;
    for (const key of ["id", "sessionId", "sessionIds", "agentId", "workspaceId"]) {
      const nested = record[key];
      if (nested !== void 0) return collectIds(nested);
    }
    for (const [k, v] of Object.entries(record)) {
      if (GUARDED_ID_FIELDS.includes(k)) {
        return collectIds(v);
      }
    }
  }
  return [];
}
function forbidden(namespace, method) {
  return Object.assign(new Error(`dsh-login: forbidden: ${namespace}.${method}`), { code: "forbidden" });
}
function wrapRemoteGateway(gateway, resolveUser, owns = () => false) {
  const allowed = (user, namespace, method) => {
    if (user.isAdmin) return true;
    if (ADMIN_ONLY_NAMESPACES.has(namespace)) return false;
    return USER_ALLOWED.has(`${namespace}.${method}`);
  };
  const ownershipGuarded = (user, request) => {
    if (user.isAdmin) return true;
    for (const field of GUARDED_ID_FIELDS) {
      for (const id of collectIds(request.args[field])) {
        if (id !== "" && !owns(id)) return false;
      }
    }
    return true;
  };
  const refuse = (user, request) => user === void 0 || !allowed(user, request.namespace, request.method) || !ownershipGuarded(user, request);
  return {
    async invoke(request) {
      if (refuse(resolveUser(), request)) throw forbidden(request.namespace, request.method);
      return gateway.invoke(request);
    },
    async stream(request) {
      if (refuse(resolveUser(), request)) throw forbidden(request.namespace, request.method);
      return gateway.stream(request);
    }
  };
}
function createRemoteIsolation(options) {
  const resolveUser = () => {
    const sid = options.currentSessionId();
    if (sid === void 0) return void 0;
    const adminUser = options.isAdminSession?.(sid);
    if (adminUser !== void 0 && adminUser !== "") {
      return { username: adminUser, isAdmin: true };
    }
    const username = options.ownership.lookup(sid);
    if (username === void 0 || username === "") return void 0;
    return { username, isAdmin: options.isAdmin?.(username) ?? false };
  };
  const owns = (id) => {
    const user = resolveUser();
    if (user === void 0) return false;
    if (user.isAdmin) return true;
    return options.ownership.lookup(id) === user.username;
  };
  return { resolveUser, owns };
}

// src/index.ts
var name = "dsh-login";
var inject = ["webServer", "credentials"];
function apply(ctx, config) {
  if (!config.enabled) return;
  const dataDir = config.dataDir === "" ? join2(resolveDshHome(), ".dsh-login") : config.dataDir;
  const store = new SessionStore(config.sessionTtl, join2(dataDir, "sessions.json"));
  const users = new UserStore(ctx.credentials, credentialRef(`${config.password}_USERS`));
  const ownership = new OwnershipIndex(join2(dataDir, "ownership.json"));
  const hosts = new TrustedHosts(join2(dataDir, "trusted-hosts.json"));
  const defaultWorkspaceSetting = new DefaultWorkspaceSetting(join2(dataDir, "settings.json"), config.defaultWorkspace);
  const remoteWebUiSetting = new BooleanSetting(join2(dataDir, "settings-remote-web-ui.json"), config.remoteWebUiCompat);
  const remoteWebUiCompat = new RemoteWebUiCompat({
    getSettings: () => ctx.get("settings")
  });
  const distIndex = config.distIndex === "" ? resolveDistIndex() : config.distIndex;
  const gatewayConfig = { ...config, distIndex };
  const loginDeps = { users, store, sessionTtl: config.sessionTtl, hosts, autoTrust: config.autoTrustHosts };
  const runtime = config.takeOverWebRuntime ? provideWebRuntime(ctx, config.trustedHosts) : void 0;
  const loginPageRoute = {
    kind: "exact",
    path: "/login",
    handler: async (_req, res) => {
      const html = await users.isEmpty() ? renderSetupPage() : renderLoginPage();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    }
  };
  const gatewayHandler = createGatewayHandler(ctx, gatewayConfig, store);
  ctx.effect(() => ctx.webServer.register(loginPageRoute), "dsh-login: /login");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/auth/setup",
    handler: createSetupHandler(loginDeps)
  }), "dsh-login: /api/auth/setup");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/auth/login",
    handler: createLoginHandler(loginDeps)
  }), "dsh-login: /api/auth/login");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/auth/logout",
    handler: createLogoutHandler(store)
  }), "dsh-login: /api/auth/logout");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/logout",
    handler: createLogoutRedirectHandler(store)
  }), "dsh-login: /logout");
  for (const route of createAdminRoutes({ users, store, hosts, defaultWorkspaceSetting, remoteWebUiSetting, remoteWebUiCompat, onRemoteWebUiApply: (enabled) => applyWithRetry(remoteWebUiCompat, enabled, config.remoteWebUiPublicBaseUrl, 3, 50) })) {
    ctx.effect(() => ctx.webServer.register(route), `dsh-login: ${route.path}`);
  }
  const bootCompat = applyWithRetry(remoteWebUiCompat, remoteWebUiSetting.get(), config.remoteWebUiPublicBaseUrl);
  void bootCompat;
  ctx.effect(() => ctx.webServer.registerFallback(gatewayHandler), "dsh-login: gateway fallback");
  if (config.apiBridgeAuth) {
    ctx.effect(
      () => ctx.on("connection/request", createApiBridgeAuth(store), { global: true }),
      "dsh-login: /api bridge auth wall"
    );
  }
  const cap = deriveCapabilities({ username: "", isAdmin: false });
  const sessionBaselineScript = `window.__DSH_SESSION__={username:null,isAdmin:false,capabilities:${JSON.stringify(cap)}};`;
  ctx.effect(() => ctx.on("webserver/index-inject", (table) => {
    table.push({ kind: "script", placement: "head", text: sessionBaselineScript });
  }), "dsh-login: capability baseline injection");
  ctx.effect(() => () => Promise.all([store.flush(), ownership.flush(), hosts.flush(), defaultWorkspaceSetting.flush(), remoteWebUiSetting.flush()]), "dsh-login: sessions + ownership + hosts + settings flush");
}
export {
  Config,
  apply,
  createRemoteIsolation,
  inject,
  name,
  wrapRemoteGateway
};
//# sourceMappingURL=index.js.map
