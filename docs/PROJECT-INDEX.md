# dsh-login 项目索引

> 生成于 2026-08-17 · 由 agent 扫描源码产出

## 概览

- **包名**: `@islibaodong/dsh-login` v0.1.0（MIT，ESM，`main: src/index.ts`）
- **定位**: DSH Web GUI 的**单密码认证网关插件**（Cordis 插件）
- **插件名 / 注入**: `name = 'dsh-login'`，`inject = ['webServer', 'credentials']`
- **测试**: `vitest run`（`pnpm test`）
- **peerDeps**: cordis、dsh-credentials、dsh-host-frontend-static、dsh-host-webserver、dsh-invariants、schemastery
- **bundle**: `dsh.bundle.patch = ./cordis.patch.yml`（禁用 dsh-web-app 的 web-runtime 行）

## 源码地图（src/）

| 文件 | 职责 |
|---|---|
| `index.ts` | 插件入口 `apply()`：注册 `/login` 页面路由、`/api/auth/setup`、`/api/auth/login`、`/api/auth/logout` 三条 API 路由（均经 `ctx.effect` 托管销毁），并以 `registerFallback` 占据 fallback 席位挂认证网关 |
| `config.ts` | Config schema：`password`(必填，凭据引用名)、`distIndex`(空=自动解析)、`sessionTtl`(默认 604800s=7天)、`enabled`、`takeOverWebRuntime`(默认 true)、`trustedHosts`、`autoTrustHosts`(默认 true)、`defaultWorkspace`(默认 false)、`workspaceRoot`(空=<DSH_HOME>/workspaces) |
| `provision.ts` | `DefaultWorkspaceProvisioner`：非管理员首次 /api 访问时供给默认工作区（mkdir 沙箱目录 → workspaceRegistry.create → sessions.create({workspaceId}) 附加并记所有权；`sandboxSegment` 用户名安全化）；幂等、best-effort |
| `gateway.ts` | 网关 fallback handler：非 GET/HEAD → 405；无有效会话 → 302 `/login`；已登录经 `serveStatic` 服务前端 dist（index.html 经 `applyIndexTaps`） |
| `session.ts` | `SessionStore`：内存 Map，`randomBytes(32)` hex token，TTL 过期 + 机会式 cleanup；进程重启即失（单机/边缘部署可接受） |
| `auth.ts` | cookie `dsh_session`（HttpOnly; SameSite=Strict; Path=/）；`timingSafeEqual` 常时密码比较；cookie 构建/清除/解析 |
| `login-api.ts` | setup/login/logout handler：首次未设密码时 `/login` 显示 setup 表单；`/api/auth/setup` 经 dsh-credentials 存储密码并在控制台 announce 值与存储路径（`.credentials.yaml`，`DSH_HOME` 或 `~/.dsh`）；请求体上限 8192 字节 |
| `login-page.ts` | 登录页 / 首次设密页的 HTML 渲染 |
| `web-runtime.ts` | 接管 `webRuntime` 服务：`resolveLanTrust`（绑 `0.0.0.0` 时收集 LAN IPv4 + 显式 trustedHosts）、`resolveDistIndex`（经 `@deepseek-ai/dsh-web-frontend` exports 解析，未构建时抛错带提示）、打印 `DSH_WEB_URL` 就绪行 |

## 关键设计点

1. **fallback 而非 prefix `/`**：WebServer 的前缀匹配对 `/` 前缀只命中精确路径 `/`，网关必须用 `registerFallback` 才能兜住所有未命名路由。
2. **webRuntime 接管**：`takeOverWebRuntime=true` 时由本插件提供 `webRuntime`（LAN 信任、DSH_WEB_URL），原 dsh-web-app 的 web-runtime 行已被 cordis.patch.yml 禁用；两边同时启用会导致第二次 fallback 注册失败。
3. **首次设密流程**：密码未配置 → `/login` 渲染 setup 表单 → `/api/auth/setup` 写入凭据系统 → 之后进入正常登录流。
4. **会话仅内存**：重启失效，属有意的单密码本地/边缘取舍。

## 测试（tests/）

`session.spec.ts`、`auth.spec.ts`、`gateway.spec.ts`、`login-api.spec.ts`、`login-page.spec.ts`、`plugin-entry.spec.ts`、`memory-credentials.ts`（测试用内存凭据 provider）、`runner.mjs` / `integration-runner.mjs`。

## 文档

- 设计：`docs/superpowers/specs/2026-08-17-dsh-login-plugin-design.md`
- 计划：`docs/superpowers/plans/2026-08-17-dsh-login-plugin.md`
