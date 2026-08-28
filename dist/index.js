// src/index.ts
import { join as join3 } from "node:path";
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
  quietDenials: z.boolean().default(true)
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
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
var REMOTE_WEB_UI_NAMESPACE = settingsNamespace("remote-web-ui");
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
      if (String(error instanceof Error ? error.message : error).includes("not registered")) return "unregistered";
      throw error;
    }
  }
};
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
    await new Promise((resolve2) => setTimeout(resolve2, delayMs));
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
function createGatewayHandler(ctx, config, store) {
  const distRoot = dirname5(config.distIndex);
  const renderIndex = indexRenderer(ctx, config.distIndex);
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
    await serveStatic(decodeURIComponent(rawPath), res, distRoot, config.distIndex, renderIndex);
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
import { isAbsolute, relative, resolve } from "node:path";
import { RpcId as makeRpcId } from "@deepseek-ai/dsh-host-apiproxy/api";

// src/provision.ts
import { mkdir as mkdir5 } from "node:fs/promises";
import { join as join2 } from "node:path";
function sandboxSegment(username) {
  return username.split(/[/\\]/).join("_").replace(/\.\.+/g, "_").replace(/^\.+/, "_").replace(/[^A-Za-z0-9._-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96) || "user";
}
var DefaultWorkspaceProvisioner = class {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  done = /* @__PURE__ */ new Set();
  /**
   * Ensure `user` has a default workspace+sandbox. A no-op for admins, for
   * users already provisioned this run, or when the registry is absent.
   * Best-effort: any error is swallowed so the triggering request survives.
   */
  async ensure(user) {
    if (user.isAdmin) return;
    if (this.deps.enabled !== void 0 && !this.deps.enabled()) {
      this.done.delete(user.username);
      return;
    }
    if (this.done.has(user.username)) return;
    const registry = this.deps.workspaceRegistry;
    if (registry === void 0) return;
    this.done.add(user.username);
    try {
      await this.provision(user.username, registry);
    } catch {
      this.done.delete(user.username);
    }
  }
  async provision(username, registry) {
    const dir = join2(this.deps.workspaceRoot, sandboxSegment(username));
    await mkdir5(dir, { recursive: true });
    const workspace = await registry.create(dir, this.deps.title ?? username);
    const api = this.deps.getApi();
    if (api === void 0) return;
    const create = api.sessions?.create;
    if (create === void 0) return;
    const request = {
      rpcId: "dsh-login-default-workspace",
      payload: { workspaceId: workspace.id }
    };
    const res = await create(request);
    if (res?.result?.ok === true && typeof res.result.value?.sessionId === "string") {
      this.deps.ownership.record(res.result.value.sessionId, username);
    }
  }
};

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
function isUserAllowed(method) {
  return USER_ALLOWED.has(method);
}
var OWNERSHIP_RPC = makeRpcId("dsh-login-ownership");
var WORKSPACE_RPC = makeRpcId("dsh-login-workspace-ownership");
function forbidden(request) {
  return {
    rpcId: request.rpcId,
    result: { ok: false, error: { code: "forbidden", message: "not permitted for this user", details: {} } }
  };
}
var ADMIN_ONLY_DOMAINS = ["credentials", "settings", "agentPresets"];
async function ownedSessionIds(api, user, ownership) {
  const owned = /* @__PURE__ */ new Set();
  for (const [sid, owner] of ownership.entries()) {
    if (owner === user.username) owned.add(sid);
  }
  const res = await api.sessions.list({ rpcId: OWNERSHIP_RPC, payload: {} });
  if (!res.result.ok) return owned;
  const byParent = /* @__PURE__ */ new Map();
  for (const item of res.result.value.items) {
    if (item.parentSessionId !== void 0) {
      const list = byParent.get(item.parentSessionId) ?? [];
      list.push(item.sessionId);
      byParent.set(item.parentSessionId, list);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const sid of [...owned]) {
      for (const child of byParent.get(sid) ?? []) {
        if (!owned.has(child)) {
          owned.add(child);
          ownership.record(child, user.username);
          grew = true;
        }
      }
    }
  }
  return owned;
}
function frameVisible(user, ownership, frame, owned) {
  if (user.isAdmin) return true;
  void ownership;
  const f = frame;
  if (f.type === "stream/error") return true;
  if (f.type === "host/remote-event") {
    const event = f.event ?? "";
    return !event.startsWith("cordis/");
  }
  if (f.sessionId !== void 0) return owned.has(f.sessionId);
  if (f.type === "host/workspace-changed") {
    const ids = f.workspace?.sessionIds ?? [];
    return ids.some((id) => owned.has(id));
  }
  if (f.type === "host/workspace-order-changed") {
    return (f.workspaceIds ?? []).some((id) => owned.has(id));
  }
  if (f.type === "host/archived-sessions-changed") {
    return (f.archivedSessionIds ?? []).some((id) => owned.has(id));
  }
  return false;
}
var SESSION_GUARDED = /* @__PURE__ */ new Set(["history", "models", "selectModel", "rename", "fork", "prompt", "attachment", "updateQueue", "cancel"]);
var SESSION_ID_FIELDS = ["sessionId", "childSessionId", "parentSessionId"];
function isWithinSandbox(path, workspaceRoot, username) {
  const sandbox = resolve(workspaceRoot, sandboxSegment(username));
  const target = resolve(path);
  const rel = relative(sandbox, target);
  return rel === "" || rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
function createUserProxy(api, user, ownership, options = {}) {
  const { workspaceRoot } = options;
  const guardSid = async (sid) => {
    const direct = ownership.lookup(sid);
    if (direct !== void 0) return direct === user.username;
    const owned = await ownedSessionIds(api, user, ownership);
    return owned.has(sid);
  };
  const guard = async (request, fields = SESSION_ID_FIELDS) => {
    if (user.isAdmin) return true;
    for (const field of fields) {
      const sid = request.payload?.[field];
      if (sid === void 0) continue;
      if (!await guardSid(sid)) return false;
    }
    return true;
  };
  const wrapSessionMethod = (name2, method, fields) => async (request) => {
    if ((fields !== void 0 || SESSION_GUARDED.has(name2)) && !await guard(request, fields)) return forbidden(request);
    return await method(request);
  };
  const ownedWorkspaceIds = async () => {
    const owned = await ownedSessionIds(api, user, ownership);
    const res = await api.workspace.list({ rpcId: WORKSPACE_RPC, payload: {} });
    if (!res.result.ok) return /* @__PURE__ */ new Set();
    const items = res.result.value.items;
    const ids = /* @__PURE__ */ new Set();
    for (const w of items) {
      if (w.sessionIds.some((sid) => owned.has(sid))) ids.add(w.workspaceId);
    }
    return ids;
  };
  const guardWid = async (wid) => (await ownedWorkspaceIds()).has(wid);
  const wrapWorkspaceId = (name2, method) => async (request) => {
    if (user.isAdmin) return await method(request);
    const wid = request.payload?.workspaceId;
    if (wid === void 0 || !await guardWid(wid)) return forbidden(request);
    return await method(request);
  };
  const createWorkspace = async (request) => {
    if (user.isAdmin) return await api.workspace.create(request);
    const path = request.payload?.path;
    if (typeof path !== "string" || workspaceRoot === void 0 || !isWithinSandbox(path, workspaceRoot, user.username)) {
      return forbidden(request);
    }
    return await api.workspace.create(request);
  };
  const proxy = {
    ...api,
    sessions: {
      ...api.sessions,
      list: async (request) => {
        const res = await api.sessions.list(request);
        if (user.isAdmin || !res.result.ok) return res;
        const owned = await ownedSessionIds(api, user, ownership);
        return { ...res, result: { ok: true, value: { items: res.result.value.items.filter((i) => owned.has(i.sessionId)) } } };
      },
      search: async (request, signal) => {
        const res = await api.sessions.search(request, signal);
        if (user.isAdmin || !res.result.ok) return res;
        const owned = await ownedSessionIds(api, user, ownership);
        return { ...res, result: { ok: true, value: { ...res.result.value, items: res.result.value.items.filter((i) => owned.has(i.sessionId)) } } };
      },
      create: async (request) => {
        const adopt = request.payload?.sessionId;
        if (!user.isAdmin && adopt !== void 0) {
          const owner = ownership.lookup(adopt);
          if (owner !== void 0 && owner !== user.username) return forbidden(request);
        }
        const res = await api.sessions.create(request);
        if (res.result.ok) {
          const sid = res.result.value.sessionId;
          const owner = ownership.lookup(sid);
          if (owner === void 0 || owner === user.username) ownership.record(sid, user.username);
        }
        return res;
      },
      // history/models/selectModel/rename/prompt/attachment/updateQueue/cancel + fork:
      ...Object.fromEntries([...SESSION_GUARDED].map((name2) => [
        name2,
        name2 === "fork" ? (async (request) => {
          if (!await guard(request)) return forbidden(request);
          const res = await api.sessions.fork(request);
          if (res.result.ok) {
            ownership.record(res.result.value.sessionId, user.username);
          }
          return res;
        }) : wrapSessionMethod(name2, api.sessions[name2])
      ]))
    },
    subagents: {
      ...api.subagents,
      list: async (request, signal) => {
        const res = await api.subagents.list(request, signal);
        if (user.isAdmin || !res.result.ok) return res;
        const owned = await ownedSessionIds(api, user, ownership);
        const value = res.result.value;
        const parent = request.payload.parentSessionId;
        const parentAvailable = parent === void 0 || owned.has(parent);
        return { ...res, result: { ok: true, value: { ...value, parentAvailable, entries: value.entries.filter((e) => owned.has(e.id)) } } };
      },
      ...Object.fromEntries(["history", "prompt", "interrupt"].map((name2) => [
        name2,
        wrapSessionMethod(name2, api.subagents[name2])
      ]))
    },
    workspace: {
      ...api.workspace,
      list: async (request) => {
        const res = await api.workspace.list(request);
        if (user.isAdmin || !res.result.ok) return res;
        const owned = await ownedSessionIds(api, user, ownership);
        const value = res.result.value;
        const items = value.items.map((w) => ({ ...w, sessionIds: w.sessionIds.filter((id) => owned.has(id)) })).filter((w) => w.sessionIds.length > 0);
        return { ...res, result: { ok: true, value: { ...value, items, archivedSessionIds: value.archivedSessionIds.filter((id) => owned.has(id)) } } };
      },
      // Workspace-scoped mutations are ownership-guarded by workspaceId: a
      // non-admin may only rename/delete/reorder a workspace that holds one of
      // their own sessions (the same owned-session criterion workspace.list
      // uses), and may only create a workspace inside their own sandbox.
      create: createWorkspace,
      rename: wrapWorkspaceId(
        "rename",
        api.workspace.rename
      ),
      delete: wrapWorkspaceId(
        "delete",
        api.workspace.delete
      ),
      insertBefore: wrapWorkspaceId(
        "insertBefore",
        api.workspace.insertBefore
      ),
      // Session-addressed mutations: every sessionId-bearing payload field is
      // guarded (insertSessionBefore's optional beforeSessionId anchor included).
      archiveSession: wrapSessionMethod(
        "archiveSession",
        api.workspace.archiveSession,
        ["sessionId"]
      ),
      insertSessionBefore: wrapSessionMethod(
        "insertSessionBefore",
        api.workspace.insertSessionBefore,
        ["sessionId", "beforeSessionId"]
      )
    },
    goals: {
      ...api.goals,
      // Every GoalsApi method carries sessionId in its payload; guard each
      // one on it (explicit fields, since goal verbs are not in
      // SESSION_GUARDED — that set is the session.* method-name space).
      ...Object.fromEntries(Object.getOwnPropertyNames(api.goals).map((name2) => [
        name2,
        wrapSessionMethod(name2, api.goals[name2], ["sessionId"])
      ]))
    },
    events: {
      ...api.events,
      mux: (request, signal) => filterWithOwnership(api.events.mux(request, signal), async (frame) => {
        if (user.isAdmin) return true;
        const f = frame.payload;
        if (f.type === "stream/error") return true;
        return (await ownedSessionIds(api, user, ownership)).has(f.sessionId);
      }),
      host: (request, signal) => filterWithOwnership(api.events.host(request, signal), async (frame) => {
        if (user.isAdmin) return true;
        return frameVisible(user, ownership, frame.payload, await ownedSessionIds(api, user, ownership));
      })
    },
    ...Object.fromEntries(ADMIN_ONLY_DOMAINS.map((domain) => [
      domain,
      domainGuard(api[domain])
    ])),
    llm: {
      ...api.llm,
      discoverModels: (request) => Promise.resolve(forbidden(request))
    },
    host: {
      ...api.host,
      pickDirectory: methodForbidden,
      listDirectory: methodForbidden,
      createDirectory: methodForbidden,
      openPath: methodForbidden
    }
  };
  return user.isAdmin ? { ...api } : proxy;
  function methodForbidden(request) {
    return Promise.resolve(forbidden(request));
  }
  function domainGuard(domain) {
    if (user.isAdmin) return domain;
    return new Proxy(domain, { get() {
      return methodForbidden;
    } });
  }
  async function* filterWithOwnership(stream, keep) {
    for await (const frame of stream) {
      if (await keep(frame)) yield frame;
    }
  }
}

// src/capabilities.ts
function userAllowedMethods() {
  return [...USER_ALLOWED];
}
var ADMIN_ONLY_TWO_SEGMENT_DOMAINS = /* @__PURE__ */ new Set([
  // config + secrets (admin)
  "credentials",
  "agentPresets",
  "agentPreset",
  // pairing / update / remote-channel (loopback-only)
  "pair",
  "update",
  "dsh-desktop-launcher",
  "dsh-web-ui-settings",
  "web-ui-settings",
  "dsh-ssh",
  // admin / decoration UI-plugin domains
  "pet",
  "task-board",
  "plugin-manager",
  "doctor",
  "perf",
  "liangshen",
  "aionui",
  "market",
  "git-graph",
  "skill-explorer",
  "skin-center",
  "community-plugins",
  // harness admin-agent domain
  "agents"
]);
function isUserDeniedTwoSegment(domain) {
  return ADMIN_ONLY_TWO_SEGMENT_DOMAINS.has(domain);
}
var USER_DOMAINS = [
  "session",
  "workspace",
  "goals",
  "subagents",
  "llm",
  "host",
  "skill",
  "api"
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
    "settings.list",
    "settings.update",
    "settings.reset",
    "agentPreset.list",
    "agentPreset.read",
    "agentPreset.write",
    "host.path",
    "host.system"
  ];
}
function allDomains() {
  return [...USER_DOMAINS, "credentials", "settings", "agentPresets"];
}
function allUiPlugins() {
  return [...CORE_UI_PLUGINS, ...ADMIN_ONLY_UI_PLUGINS];
}
var QUIET_DENY_METHODS = /* @__PURE__ */ new Set([
  "agentPreset.list",
  "agentPreset.get",
  "credentials.list",
  "settings.list",
  "settings.describe",
  "pluginManager.list",
  "plugin.list",
  "doctor.status",
  "doctor.run",
  "ui.plugins",
  "ui.list"
]);
function isReadProbe(method) {
  if (QUIET_DENY_METHODS.has(method)) return true;
  const verb = method.slice(method.lastIndexOf(".") + 1).toLowerCase();
  return READ_VERBS.has(verb);
}
var READ_VERBS = /* @__PURE__ */ new Set([
  "list",
  "get",
  "status",
  "describe",
  "fetch",
  "summary",
  "version",
  "info",
  "config",
  "state",
  "providers",
  "models",
  "ping"
]);

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
var BASE_CSS = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1a1a2e;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #16213e;
      border: 1px solid #2a2a4a;
      border-radius: 12px;
      padding: 40px;
      width: 360px;
      max-width: 90vw;
    }
    .card h1 {
      font-size: 1.5rem;
      margin-bottom: 24px;
      text-align: center;
      color: #e0e0e0;
    }
    .card .subtitle {
      font-size: 0.8rem;
      color: #888;
      text-align: center;
      margin-bottom: 24px;
    }
    .card input[type="text"], .card input[type="password"] {
      width: 100%;
      padding: 12px 16px;
      background: #0f0f23;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      color: #e0e0e0;
      font-size: 1rem;
      margin-bottom: 16px;
      outline: none;
    }
    .card input[type="text"]:focus, .card input[type="password"]:focus {
      border-color: #4a4a6a;
    }
    .card button[type="submit"] {
      width: 100%;
      padding: 12px;
      background: #4a6fa5;
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 1rem;
      cursor: pointer;
      transition: background 0.2s;
    }
    .card button[type="submit"]:hover {
      background: #5a7fb5;
    }
    .card button[type="submit"]:disabled {
      background: #3a3a5a;
      cursor: not-allowed;
    }
    .error {
      color: #ff6b6b;
      font-size: 0.875rem;
      text-align: center;
      margin-bottom: 16px;
      min-height: 1.25rem;
    }
`;
function renderLoginPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH Login</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="card">
    <h1>DSH</h1>
    <div class="error" id="error"></div>
    <form id="loginForm">
      <input type="text" name="username" id="username" placeholder="Username" autocomplete="username" autofocus required>
      <input type="password" name="password" id="password" placeholder="Password" autocomplete="current-password" required>
      <button type="submit" id="submit">Login</button>
    </form>
  </div>
  <script>
    const form = document.getElementById('loginForm');
    const username = document.getElementById('username');
    const password = document.getElementById('password');
    const error = document.getElementById('error');
    const submit = document.getElementById('submit');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      submit.textContent = '...';
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.value, password: password.value }),
        });
        if (res.ok) {
          window.location = '/';
        } else if (res.status === 401) {
          error.textContent = 'Invalid username or password';
          password.value = '';
          password.focus();
        } else if (res.status === 400) {
          error.textContent = 'Bad request';
        } else if (res.status === 500) {
          error.textContent = 'Server error - no users configured';
        } else {
          error.textContent = 'Unexpected error';
        }
      } catch (err) {
        error.textContent = 'Network error';
      } finally {
        submit.disabled = false;
        submit.textContent = 'Login';
      }
    });
  </script>
</body>
</html>`;
}
function renderSetupPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DSH Setup</title>
  <style>${BASE_CSS}</style>
</head>
<body>
  <div class="card">
    <h1>DSH</h1>
    <div class="subtitle">First-time setup: create the administrator account</div>
    <div class="error" id="error"></div>
    <form id="setupForm">
      <input type="text" name="username" id="username" placeholder="Username" autocomplete="username" autofocus required>
      <input type="password" name="password" id="password" placeholder="New password" autocomplete="new-password" required>
      <input type="password" id="confirm" placeholder="Confirm password" autocomplete="new-password" required>
      <button type="submit" id="submit">Create Account</button>
    </form>
  </div>
  <script>
    const form = document.getElementById('setupForm');
    const username = document.getElementById('username');
    const pw = document.getElementById('password');
    const cf = document.getElementById('confirm');
    const error = document.getElementById('error');
    const submit = document.getElementById('submit');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      if (username.value.length < 1) {
        error.textContent = 'Username cannot be empty';
        return;
      }
      if (pw.value.length < 1) {
        error.textContent = 'Password cannot be empty';
        return;
      }
      if (pw.value !== cf.value) {
        error.textContent = 'Passwords do not match';
        cf.value = '';
        cf.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = '...';
      try {
        const res = await fetch('/api/auth/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username.value, password: pw.value }),
        });
        if (res.ok) {
          window.location = '/';
        } else if (res.status === 403) {
          error.textContent = 'Setup already completed';
        } else if (res.status === 400) {
          error.textContent = 'Bad request';
        } else {
          error.textContent = 'Unexpected error';
        }
      } catch (err) {
        error.textContent = 'Network error';
      } finally {
        submit.disabled = false;
        submit.textContent = 'Create Account';
      }
    });
  </script>
</body>
</html>`;
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

// src/connection.ts
import { toFetchHandler } from "@deepseek-ai/dsh-host-apiproxy";

// vendor/dsh-client-connection-aa6c361a97/packages/client/connection/src/api-path.ts
var API_PATH = "/api";
var MUX_EVENTS_PATH = `${API_PATH}/events.mux`;
var HOST_EVENTS_PATH = `${API_PATH}/events.host`;

// vendor/dsh-client-connection-aa6c361a97/packages/client/connection/src/http-bridge.ts
var DEFAULT_MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024;
async function bridge(req, res, apiHandler, maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES) {
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  const declaredLength = req.headers["content-length"];
  if (declaredLength !== void 0 && Number(declaredLength) > maxRequestBodyBytes) {
    res.writeHead(413, { connection: "close" });
    res.end();
    req.destroy();
    return;
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    received += buffer.byteLength;
    if (received > maxRequestBodyBytes) {
      res.writeHead(413, { connection: "close" });
      res.end();
      req.destroy();
      return;
    }
    chunks.push(buffer);
  }
  const request = new Request(new URL(req.url ?? "/", "http://dsh.internal"), {
    method: req.method ?? "GET",
    headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string")),
    ...chunks.length > 0 ? { body: Buffer.concat(chunks) } : {},
    signal: abort.signal
  });
  const response = await apiHandler.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body === null) {
    res.end();
    return;
  }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise((resolve2) => {
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          resolve2();
        };
        res.once("drain", done);
        res.once("close", done);
      });
    }
  }
  res.end();
}

// vendor/dsh-client-connection-aa6c361a97/packages/client/connection/src/loopback-hostname.ts
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

// vendor/dsh-client-connection-aa6c361a97/packages/client/connection/src/api-request-trust.ts
function header(headers, name2) {
  if (headers instanceof Headers) return headers.get(name2) ?? void 0;
  const value = headers[name2];
  return typeof value === "string" ? value : void 0;
}
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return void 0;
  }
}
function assertTrustedAuthority(entry) {
  const entryUrl = parseAuthority(entry);
  if (entryUrl !== void 0 && canonicalAuthority2(entry, entryUrl) === entry.toLowerCase()) return;
  throw new Error(`client-connection: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`);
}
function canonicalAuthority2(entry, entryUrl) {
  const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === void 0) return false;
    return canonicalAuthority2(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
  });
}
function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, "host");
  if (host === void 0) return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === void 0) return false;
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = header(request.headers, "origin");
  if (origin === void 0) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

// vendor/dsh-client-connection-aa6c361a97/packages/client/connection/src/websocket-downlink.ts
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { RpcId } from "@deepseek-ai/dsh-host-apiproxy/api";
function serverRequest(frame) {
  return {
    type: "server-request",
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload
  };
}
function send(socket, frame) {
  return new Promise((resolve2, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error("websocket downlink closed before frame delivery"));
      return;
    }
    socket.send(JSON.stringify(serverRequest(frame)), (error) => {
      if (error) reject(error);
      else resolve2();
    });
  });
}
function failureFrame(error) {
  return {
    rpcId: RpcId(randomUUID()),
    payload: {
      type: "stream/error",
      error: { code: "internal", message: String(error), details: {} }
    }
  };
}
var WebSocketDownlinks = class {
  /** @param api - host API supplying the typed event streams. */
  constructor(api) {
    this.api = api;
  }
  api;
  server = new WebSocketServer({ noServer: true });
  pumps = /* @__PURE__ */ new Set();
  /**
   * Upgrade one socket and pump the mux stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   */
  handleMux(req, socket, head) {
    this.upgrade(req, socket, head, (signal) => this.api.events.mux({
      rpcId: RpcId(randomUUID()),
      payload: {}
    }, signal));
  }
  /**
   * Upgrade one socket and pump the host stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   */
  handleHost(req, socket, head) {
    this.upgrade(req, socket, head, (signal) => this.api.events.host({
      rpcId: RpcId(randomUUID()),
      payload: {}
    }, signal));
  }
  /**
   * Terminate owned sockets and await the no-server acceptor plus frame pumps.
   * @returns A promise resolving after every socket and source iterator stops.
   */
  async close() {
    for (const socket of this.server.clients) socket.terminate();
    await new Promise((resolve2, reject) => {
      this.server.close((error) => {
        if (error === void 0) resolve2();
        else reject(error);
      });
    });
    await Promise.all(this.pumps);
  }
  upgrade(req, socket, head, open) {
    this.server.handleUpgrade(req, socket, head, (websocket) => {
      const abort = new AbortController();
      websocket.once("close", () => {
        abort.abort();
      });
      websocket.once("error", () => {
        abort.abort();
      });
      websocket.once("message", () => {
        websocket.close(1008, "downlink only");
      });
      const pump = this.pump(websocket, open(abort.signal), abort);
      this.pumps.add(pump);
      void pump.then(() => {
        this.pumps.delete(pump);
      });
    });
  }
  async pump(socket, frames, abort) {
    try {
      for await (const frame of frames) await send(socket, frame);
    } catch (error) {
      if (!abort.signal.aborted) {
        try {
          await send(socket, failureFrame(error));
        } catch {
        }
      }
    } finally {
      abort.abort();
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
  }
};
function rejectWebSocketUpgrade(socket) {
  socket.end([
    "HTTP/1.1 403 Forbidden",
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Length: 9",
    "",
    "forbidden"
  ].join("\r\n"));
}

// vendor/dsh-client-connection-aa6c361a97/packages/client/connection/src/rpc-host.ts
import { Service } from "@deepseek-ai/cordis";
import {
  clientRequestSchema,
  RpcId as RpcId2
} from "@deepseek-ai/dsh-host-apiproxy/api";
var INVALID_REQUEST_RPC_ID = RpcId2("invalid-request");
var CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/;
var ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
var HostConnectionService = class extends Service {
  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by trusted-host channels.
   */
  constructor(ctx, trustedHosts) {
    super(ctx, "connection");
    this.trustedHosts = trustedHosts;
  }
  trustedHosts;
  interceptors = /* @__PURE__ */ new Map();
  /** Generic channel registry scoped to the Context reading this service. */
  get rpc() {
    const owner = this.ctx;
    return {
      handle: (channel, handler, options) => this.register(owner, channel, handler, options),
      intercept: (channel, matches, handler, options) => this.registerInterceptor(owner, channel, matches, handler, options)
    };
  }
  /**
   * Compose one shared-channel Fetch handler from its interceptor and fallback.
   * @param channel - shared channel mounted by Connection.
   * @param fallback - handler for endpoints not claimed by the interceptor.
   * @returns Fetch handler that selects exactly one target for each request.
   */
  createSharedFetchHandler(channel, fallback) {
    return {
      fetch: (request) => {
        const endpoint = endpointFromPath(channel, new URL(request.url).pathname);
        const interceptor = this.interceptors.get(channel);
        if (endpoint === void 0 || interceptor === void 0 || !interceptor.matches(endpoint)) {
          return fallback.fetch(request);
        }
        if (interceptor.options.authority === "loopback" && !isTrustedApiRequest(request, [])) {
          return Promise.resolve(new Response("forbidden", { status: 403 }));
        }
        return interceptor.fetchHandler.fetch(request);
      }
    };
  }
  register(owner, channel, handler, options) {
    assertChannel(channel);
    const trustedHosts = options.authority === "loopback" ? [] : this.trustedHosts;
    const fetchHandler = rpcFetchHandler(channel, handler);
    const route = {
      kind: "prefix",
      path: channel,
      handler: async (req, res) => {
        if (!isTrustedApiRequest(req, trustedHosts)) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        await bridge(req, res, fetchHandler);
      }
    };
    return owner.effect(
      () => owner.webServer.register(route),
      `client-connection: ${channel} rpc channel`
    );
  }
  registerInterceptor(owner, channel, matches, handler, options) {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`);
    }
    const interceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, handler),
      options
    };
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`);
      }
      this.interceptors.set(channel, interceptor);
      return () => {
        this.interceptors.delete(channel);
      };
    }, `client-connection: ${channel} rpc interceptor`);
  }
};
function rpcFetchHandler(channel, handler) {
  return {
    async fetch(request) {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname);
      if (request.method !== "POST" || endpoint === void 0) {
        return new Response("not found", { status: 404 });
      }
      const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/json") {
        return new Response("content type must be application/json", { status: 415 });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return new Response("body is not JSON", { status: 400 });
      }
      const envelope = clientRequestSchema.safeParse(body);
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues);
      }
      const message = envelope.data;
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: "bad-request",
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] }
        });
      }
      try {
        const result = await handler(endpoint, message.payload, request.signal);
        return fullResponse(message.rpcId, result);
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 });
      }
    }
  };
}
function invalidEnvelopeResponse(body, issues) {
  const rawId = body?.rpcId;
  const rpcId = typeof rawId === "string" ? RpcId2(rawId) : INVALID_REQUEST_RPC_ID;
  return errorResponse(rpcId, {
    code: "bad-request",
    message: "invalid client-request message",
    details: { issues }
  });
}
function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return void 0;
  const endpoint = pathname.slice(channel.length + 1);
  const segments = endpoint.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return void 0;
  }
  return endpoint;
}
function errorResponse(rpcId, error) {
  return fullResponse(rpcId, { ok: false, error });
}
function fullResponse(rpcId, result) {
  const body = { type: "server-response", rpcId, result };
  return Response.json(body);
}
function assertChannel(channel) {
  if (!CHANNEL_PATTERN.test(channel) || channel === "/api") {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`);
  }
}

// src/connection.ts
function createConnectionPlugin(deps) {
  return {
    name: "dsh-login-connection",
    inject: ["webServer"],
    apply(ctx) {
      for (const entry of deps.trustedHosts) assertTrustedAuthority(entry);
      const maxBytes = deps.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
      const proxyCache = /* @__PURE__ */ new Map();
      const connection = new HostConnectionService(ctx, deps.trustedHosts);
      const typertDispatch = connection.createSharedFetchHandler(API_PATH, {
        fetch: () => Promise.resolve(new Response("not found", { status: 404 }))
      });
      const userProxy = (api, user) => {
        const key = user.isAdmin ? `admin:${user.username}` : user.username;
        let entry = proxyCache.get(key);
        if (entry === void 0) {
          entry = { fetch: void 0, downlinks: createUserProxy(api, user, deps.ownership, { workspaceRoot: deps.defaultWorkspaceRoot }) };
          entry.fetch = deps.fetchForTest !== void 0 ? deps.fetchForTest(entry.downlinks, user).fetch : toFetchHandler(entry.downlinks).fetch;
          proxyCache.set(key, entry);
        }
        return entry.downlinks;
      };
      const userFetch = (api, user) => {
        const key = user.isAdmin ? `admin:${user.username}` : user.username;
        userProxy(api, user);
        return proxyCache.get(key).fetch;
      };
      const provisioner = deps.defaultWorkspaceRoot === void 0 ? void 0 : new DefaultWorkspaceProvisioner({
        workspaceRoot: deps.defaultWorkspaceRoot,
        getApi: () => ctx.get("apiProxy"),
        ownership: deps.ownership,
        get workspaceRegistry() {
          return ctx.get("workspaceRegistry");
        },
        enabled: deps.isDefaultWorkspaceEnabled
      });
      const ensureProvisioned = async (user) => {
        if (provisioner !== void 0) await provisioner.ensure(user);
      };
      const sharedFetch = (api) => ({
        fetch: async (request) => {
          const url = new URL(request.url);
          const token = extractSessionToken(request.headers.get("cookie") ?? void 0);
          const session = token === void 0 ? void 0 : deps.store.verify(token);
          if (session === void 0) return new Response("authentication required", { status: 401 });
          const user = { username: session.user, isAdmin: session.isAdmin };
          await ensureProvisioned(user);
          if (request.method === "GET" && (url.pathname === MUX_EVENTS_PATH || url.pathname === HOST_EVENTS_PATH)) {
            return new Response("upgrade required", {
              status: 426,
              headers: { connection: "Upgrade", upgrade: "websocket" }
            });
          }
          if (url.pathname === "/api/session.export") {
            const sid = url.searchParams.get("sessionId");
            if (!user.isAdmin && sid !== null) {
              const owned = await ownedSessionIds(api, user, deps.ownership);
              if (!owned.has(sid)) return new Response("forbidden", { status: 403 });
            }
            return userFetch(api, user)(request);
          }
          const method = url.pathname.startsWith(`${API_PATH}/`) ? url.pathname.slice(API_PATH.length + 1) : void 0;
          if (method !== void 0 && method.includes("/")) {
            const domain = method.slice(0, method.indexOf("/"));
            const member = method.slice(method.indexOf("/") + 1);
            if (!user.isAdmin && isUserDeniedTwoSegment(domain)) {
              const quiet = deps.quietDenials !== false && (reqReadOnlyContext(request) || isReadProbe(`${domain}.${member}`));
              return new Response(quiet ? void 0 : "forbidden", { status: quiet ? 204 : 403 });
            }
            return typertDispatch.fetch(request);
          }
          if (!user.isAdmin && method !== void 0 && !isUserAllowed(method)) {
            const quiet = deps.quietDenials !== false && (isReadProbe(method) || reqReadOnlyContext(request));
            return new Response(quiet ? void 0 : "forbidden", { status: quiet ? 204 : 403 });
          }
          return userFetch(api, user)(request);
        }
      });
      const route = {
        kind: "prefix",
        path: API_PATH,
        handler: async (req, res) => {
          if (!isTrustedApiRequest(req, deps.effectiveTrustedHosts?.() ?? deps.trustedHosts)) {
            res.writeHead(403);
            res.end("forbidden");
            return;
          }
          const api = ctx.get("apiProxy");
          if (api === void 0) {
            res.writeHead(404);
            res.end("not found");
            return;
          }
          await bridge(req, res, sharedFetch(api), maxBytes);
        }
      };
      ctx.effect(() => ctx.webServer.register(route), "dsh-login-connection: /api route");
      const downlinkSet = /* @__PURE__ */ new Set();
      const registerDownlink = (path, kind) => {
        ctx.effect(() => ctx.webServer.registerUpgrade({
          path,
          handler: (req, socket, head) => {
            if (!isTrustedApiRequest(req, deps.effectiveTrustedHosts?.() ?? deps.trustedHosts)) {
              rejectWebSocketUpgrade(socket);
              return;
            }
            const token = extractSessionToken(req.headers.cookie);
            const session = token === void 0 ? void 0 : deps.store.verify(token);
            if (session === void 0) {
              rejectWebSocketUpgrade(socket);
              return;
            }
            const api = ctx.get("apiProxy");
            if (api === void 0) {
              rejectWebSocketUpgrade(socket);
              return;
            }
            const downlinks = new WebSocketDownlinks(userProxy(api, { username: session.user, isAdmin: session.isAdmin }));
            downlinkSet.add(downlinks);
            socket.once("close", () => {
              void downlinks.close();
              downlinkSet.delete(downlinks);
            });
            if (kind === "mux") downlinks.handleMux(req, socket, head);
            else downlinks.handleHost(req, socket, head);
          }
        }), `dsh-login-connection: ${path} WebSocket`);
      };
      registerDownlink(MUX_EVENTS_PATH, "mux");
      registerDownlink(HOST_EVENTS_PATH, "host");
      ctx.effect(() => () => {
        for (const d of downlinkSet) void d.close();
      }, "dsh-login-connection: downlinks close");
    }
  };
}
function reqReadOnlyContext(request) {
  return request.method === "GET" || request.method === "HEAD";
}

// src/index.ts
var name = "dsh-login";
var inject = ["webServer", "credentials"];
function apply(ctx, config) {
  if (!config.enabled) return;
  const dataDir = config.dataDir === "" ? join3(resolveDshHome(), ".dsh-login") : config.dataDir;
  const store = new SessionStore(config.sessionTtl, join3(dataDir, "sessions.json"));
  const users = new UserStore(ctx.credentials, credentialRef(`${config.password}_USERS`));
  const ownership = new OwnershipIndex(join3(dataDir, "ownership.json"));
  const hosts = new TrustedHosts(join3(dataDir, "trusted-hosts.json"));
  const defaultWorkspaceSetting = new DefaultWorkspaceSetting(join3(dataDir, "settings.json"), config.defaultWorkspace);
  const defaultWorkspaceRoot = config.workspaceRoot === "" ? join3(resolveDshHome(), "workspaces") : config.workspaceRoot;
  const remoteWebUiSetting = new BooleanSetting(join3(dataDir, "settings-remote-web-ui.json"), config.remoteWebUiCompat);
  const remoteWebUiCompat = new RemoteWebUiCompat({
    getSettings: () => ctx.get("settings")
  });
  const distIndex = config.distIndex === "" ? resolveDistIndex() : config.distIndex;
  const gatewayConfig = { ...config, distIndex };
  const loginDeps = { users, store, sessionTtl: config.sessionTtl, hosts, autoTrust: config.autoTrustHosts };
  const runtime = config.takeOverWebRuntime ? provideWebRuntime(ctx, config.trustedHosts) : void 0;
  const lanAuthorities = runtime?.lanAddresses ?? [];
  const effectiveTrustedHosts = () => {
    const learned = config.autoTrustHosts ? hosts.list() : [];
    return [.../* @__PURE__ */ new Set([...lanAuthorities, ...config.trustedHosts, ...learned])];
  };
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
  const cap = deriveCapabilities({ username: "", isAdmin: false });
  const sessionBaselineScript = `window.__DSH_SESSION__={username:null,isAdmin:false,capabilities:${JSON.stringify(cap)}};`;
  ctx.effect(() => ctx.on("webserver/index-inject", (table) => {
    table.push({ kind: "script", placement: "head", text: sessionBaselineScript });
  }), "dsh-login: capability baseline injection");
  ctx.effect(() => {
    const child = ctx.plugin(createConnectionPlugin({
      store,
      ownership,
      trustedHosts: config.trustedHosts,
      effectiveTrustedHosts,
      defaultWorkspaceRoot,
      isDefaultWorkspaceEnabled: () => defaultWorkspaceSetting.get(),
      quietDenials: config.quietDenials
    }));
    return () => {
      void child.stop?.();
    };
  }, "dsh-login: connection takeover");
  ctx.effect(() => () => Promise.all([store.flush(), ownership.flush(), hosts.flush(), defaultWorkspaceSetting.flush(), remoteWebUiSetting.flush()]), "dsh-login: sessions + ownership + hosts + settings flush");
}
export {
  Config,
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
