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
function header(headers, name) {
  if (headers instanceof Headers) return headers.get(name) ?? void 0;
  const value = headers[name];
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
  if (entryUrl !== void 0 && canonicalAuthority(entry, entryUrl) === entry.toLowerCase()) return;
  throw new Error(`client-connection: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`);
}
function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
  return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}
function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry);
    if (entryUrl === void 0) return false;
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
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

// src/api-filter.ts
import { isAbsolute, relative, resolve } from "node:path";
import { RpcId as makeRpcId } from "@deepseek-ai/dsh-host-apiproxy/api";

// src/provision.ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
    const dir = join(this.deps.workspaceRoot, sandboxSegment(username));
    await mkdir(dir, { recursive: true });
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
  const wrapSessionMethod = (name, method, fields) => async (request) => {
    if ((fields !== void 0 || SESSION_GUARDED.has(name)) && !await guard(request, fields)) return forbidden(request);
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
  const wrapWorkspaceId = (name, method) => async (request) => {
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
      ...Object.fromEntries([...SESSION_GUARDED].map((name) => [
        name,
        name === "fork" ? (async (request) => {
          if (!await guard(request)) return forbidden(request);
          const res = await api.sessions.fork(request);
          if (res.result.ok) {
            ownership.record(res.result.value.sessionId, user.username);
          }
          return res;
        }) : wrapSessionMethod(name, api.sessions[name])
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
      ...Object.fromEntries(["history", "prompt", "interrupt"].map((name) => [
        name,
        wrapSessionMethod(name, api.subagents[name])
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
      ...Object.fromEntries(Object.getOwnPropertyNames(api.goals).map((name) => [
        name,
        wrapSessionMethod(name, api.goals[name], ["sessionId"])
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
export {
  createConnectionPlugin
};
//# sourceMappingURL=connection.js.map
