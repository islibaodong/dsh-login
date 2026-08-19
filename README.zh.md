# dsh-login

[English](./README.md) | 简体中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的多用户认证网关插件：用户账号 + 管理员页面，`/api` 通道按用户做会话隔离。

## 它做什么

当 DSH Web 服务器暴露在 `0.0.0.0` 或公网时，`dsh-login` 要求登录用户账号后才能访问 Web GUI。它接管 WebServer 的 fallback 处理器，所有未被命名路由（如 `/api/*`）匹配的请求都会经过认证网关：

- **未认证请求** -> 重定向到 `/login`
- **已认证请求** -> 从前端 dist 目录提供静态文件

## 快速开始

```bash
dsh plugin --profile web add github:islibaodong/dsh-login
```

就这一步。该包的 `cordis.patch.yml` 声明为 bundle patch，`add` 之后会自动：

- 挂载 `dsh-login` 插件行（配置默认值即可用；`distIndex` 自动解析前端 dist 目录），
- 禁用 `web-runtime` 行（dsh-web-app 通过它挂载 frontend-static fallback），dsh-login 接管 fallback 席位并重新提供 `webRuntime` 服务（`/api` 信任围栏的 LAN 信任 + `DSH_WEB_URL` 环境变量），
- 禁用自带的 `connection` 行（`/api` 通道）；dsh-login 挂载自己的身份感知接管插件，并提供配套的浏览器 bundle `dist/client.js`。

> 为什么需要 `--profile web`？DSH 没有"全局安装插件"的概念：插件按 profile 目录（`$DSH_HOME/profiles/<name>`）安装。`web` 就是启动 Web GUI 的 profile；如果你用的是自定义 profile，换成对应名字即可。

启动 DSH（`dsh web`），在浏览器中打开 Web GUI，你会看到初始设置页面。选择用户名和密码——首个账号即成为管理员（scrypt 哈希后自动存入 DSH 凭据系统）。后续访问将显示正常的用户名/密码登录页。

无需设置环境变量，无需编辑配置文件。账号全部通过浏览器创建：首个（管理员）账号在首次访问时创建，其余账号由管理员在 `/admin` 页面添加。

### 手动安装（可选）

如果你希望自己管理 `cordis.patch.yml`，可以把以下内容手动加进 profile 的 patch 文件：

```yaml
- insert:
    - id: dsh-login
      name: '@deepseek-ai/dsh-login'
      config:
        password: DSH_LOGIN_PASSWORD   # 凭据引用名；派生用户存储引用（<名称>_USERS）
        distIndex: ''                  # 留空则自动解析前端 dist
        dataDir: ''                    # 留空则解析为 <DSH_HOME>/.dsh-login（所有权索引）
        sessionTtl: 604800             # 会话有效期，7 天（默认）
        enabled: true                 # 设为 false 可临时禁用

# 重要：dsh-login 接管 fallback 席位，必须禁用 web-runtime 行
# （dsh-web-app 通过该行挂载 frontend-static；dsh-login 会重新提供 webRuntime 服务）
- id: web-runtime
  disabled: true

# 重要：WebServer 拒绝重复的 /api 前缀注册，自带的 connection 行必须保持禁用；
# dsh-login 自己挂载身份感知的 /api 接管插件（含浏览器 bundle dist/client.js）
- id: connection
  disabled: true
```

> 注意：新增行必须写在 `- insert:` 下——顶层直接写行会被当成对已存在行的覆盖，对不存在的行是静默空操作；禁用行的键是 `disabled`（不是 `disable`）。

## 首次设置流程

1. **首次访问**（无任何用户）-> `/login` 显示「创建管理员账号」页面（用户名 + 密码）
2. 用户选择凭据 -> `POST /api/auth/setup` 创建强制管理员的第一个账号（scrypt 哈希，存入 `${password}_USERS` 凭据引用，默认 `DSH_LOGIN_PASSWORD_USERS`）并自动登录
3. **后续访问** -> `/login` 显示正常的用户名/密码登录表单
4. **用户管理** -> 管理员打开 `/admin` 列出、创建、删除用户及修改密码（`/api/auth/admin/*` JSON 路由；删除最后一个管理员会被拒绝；删除用户或修改密码会立即吊销该用户的全部活跃会话）
5. **安全保护** -> 已有用户后 `/api/auth/setup` 返回 403，防止劫持

> **迁移说明：** 旧版单一密码凭据（默认引用 `DSH_LOGIN_PASSWORD`）不再能登录任何人。它保持已配置状态但认证不再使用——`password` 配置项现在只用于派生用户存储引用（`${password}_USERS`）。因此从单密码部署升级后，首次访问需要重新引导创建一个管理员账号。

## 工作原理

```
请求 -> WebServer
  ├─ /login (精确匹配)        -> 设置页（无用户时）或 登录页（有用户时）
  ├─ /api/auth/setup (精确)   -> POST: 首次创建管理员（已有用户则 403）
  ├─ /api/auth/login (精确)   -> POST: 验证 {username,password}，设置 Cookie
  ├─ /api/auth/logout (精确)  -> POST: 撤销会话，清除 Cookie
  ├─ /api/auth/me (精确)      -> GET: 当前会话身份
  ├─ /api/auth/admin/* (精确) -> 管理员 JSON API（users、password、remove）
  ├─ /admin (精确)            -> 管理页面（非管理员 302 /login）
  ├─ /api/* (前缀匹配)        -> dsh-login 通道接管：
  │                             ├─ 主机不可信 -> 403
  │                             ├─ 无有效 Cookie -> 401
  │                             ├─ 事件路径上的 GET -> 426（需要升级）
  │                             └─ 按用户经代理过滤后分发
  ├─ /api/events.mux + /api/events.host（WS 升级）-> 同样的信任 + Cookie 检查，
  │                             之后按用户过滤事件下联
  └─ fallback (兜底)          -> dsh-login: 认证网关 + 静态文件服务
                                  ├─ 无有效 Cookie -> 302 重定向到 /login
                                  └─ 有有效 Cookie -> serveStatic() 提供文件
```

- **Cookie 名称**：`dsh_session`，HttpOnly、SameSite=Strict、Path=/
- **会话令牌**：32 字节随机值（256 位），内存存储，带 TTL 自动过期；会话携带用户名与管理员标记，进程重启后失效
- **密码存储**：scrypt 哈希（每用户独立盐），存于 DSH 凭据系统的 `${password}_USERS` 引用

## 多用户权限模型

- **普通用户只能使用会话功能。** 通过 `/api` 接管，他们只能看到和操作**自己**的会话及其派生子会话（子代理/分叉——所有权沿 `parentSessionId` 传递），工作区视图也被过滤为仅含自己的会话。其余一律禁止：
  - 物理层允许清单：固定的一组 `session.*`、`subagent.*`、`workspace.*`、`goal.*` 方法，加上 `skill.list`、`host.describe`、`llm.providers`/`llm.models` 和 `respond`；其他任何线上方法在到达 harness 之前就是 403
  - 管理员专属域：`credentials.*`、`settings.*`、`agentPresets.*` 整体禁用
  - 同样禁止：`llm.discoverModels` 以及特权 `host.*` 目录对话框（`pickDirectory`、`listDirectory`、`createDirectory`、`openPath`）
  - 事件流（mux/host WebSocket 帧）按所有权过滤，其他用户的流量不会到达浏览器
- **管理员可见可做一切：** 不受限的 API 访问、所有会话/工作区可见，以及 `/admin` 管理页面。

## 数据位置

| 数据 | 位置 |
|------|------|
| 用户账号（scrypt 哈希） | DSH 凭据系统，引用 `${password}_USERS`（默认 `DSH_LOGIN_PASSWORD_USERS`） |
| 会话→用户所有权索引 | `<DSH_HOME>/.dsh-login/ownership.json`（可用 `dataDir` 配置；`DSH_HOME` 环境变量或 `~/.dsh`） |
| 登录会话 | 仅内存（DSH 重启后需重新登录） |

## `/api` 通道接管与客户端 bundle

本插件替换自带的 `/api` connection 行：`cordis.patch.yml` 将其禁用（WebServer 拒绝重复的 `/api` 前缀注册，因此自带行必须保持关闭），`dsh-login` 以子插件形式挂载自己的身份感知通道（`src/connection.ts`）——同样的主机信任围栏，但每个请求都从会话 Cookie 解析身份并按用户分发。

浏览器端的协议不变，但 GUI 的线上客户端必须继续由本包提供：client-modules 扫描器会把被禁用行的浏览器半边从启动图中剔除。因此 dsh-login 声明了自身的 `dsh.client` 并随包发布 bundle `dist/client.js`——它是自带 connection 客户端的重新打标副本（`src/connection.client.ts` 原样转发导出）。重新生成：

```bash
npm run build:client   # node scripts/build-client.mjs；使用 node_modules 或 $DSH_HARNESS_CHECKOUT
```

**升级 `@deepseek-ai/dsh-client-connection` 之后必须重新执行**，否则浏览器 bundle 会与新通道脱节。

## 安全说明

### 网关保护范围

| 资产 | 保护方式 |
|------|----------|
| 页面导航 (`/`) | 未认证时 302 重定向到 `/login` |
| 静态资源 (`/assets/*.js`、`.css` 等) | 同样的网关检查 |
| SPA 路由 (`/conversations`、`/settings` 等) | 同样的网关检查 |

### 通道接管保护范围

| 资产 | 保护方式 |
|------|----------|
| API 请求 (`/api/*`) | `isTrustedApiRequest` 主机信任检查 **加上** 有效 `dsh_session` Cookie（缺失则 401）；普通用户调用不允许的方法返回 403 |
| WebSocket (`/api/events.mux`、`/api/events.host`) | 升级时同样的主机信任 + Cookie 检查；帧按用户所有权过滤 |

### 公网暴露建议

1. 将 `trustedHosts` 设置为仅允许需要访问 API 的特定主机
2. 在 DSH 前部署反向代理（nginx/caddy）进行 TLS 终结
3. 网关 Cookie 为 `SameSite=Strict`，可防止针对登录/登出端点的 CSRF 攻击

## 架构说明：fallback vs prefix /

网关使用 `registerFallback()` 而非 `register({ kind: 'prefix', path: '/' })`，因为 DSH WebServer 的前缀匹配逻辑检查 `pathname.startsWith(prefix + '/')`。当 prefix 为 `/` 时，拼接结果为 `//`，而正常路径不会以 `//` 开头——所以 `prefix /` 路由只能精确匹配 `/` 这一个路径。fallback 处理器能捕获所有未被命名路由匹配的请求，这才是认证网关所需的 catch-all 行为。

WebServer 只有一个 fallback 席位。dsh-web-app 的 `web-runtime` 行会无条件挂载 frontend-static 占据它，因此使用 `dsh-login` 时必须禁用 `web-runtime` 行；dsh-login 会重新提供它负责的 `webRuntime` 服务（LAN 信任、`DSH_WEB_URL`），组合其余部分不受影响。

## 运行测试

```bash
# 标准全量测试（109 项；需要 DSH 源码做包解析——
# 设置 DSH_HARNESS_CHECKOUT，或在默认路径旁运行）
npx vitest run
```

`.spec.ts` 文件是标准的 vitest 测试定义，含多用户套件（`users`、`ownership`、`api-filter`、`connection`、`admin-api`、`multiuser-e2e`、`client-bundle`）。`tests/runner.mjs` 和 `tests/integration-runner.mjs` 是针对原单密码核心的沙箱兼容运行器，未随多用户功能扩展。

## 项目结构

```
src/
├── index.ts          # Cordis 插件入口：注册路由、fallback、所有权 + 通道子插件
├── config.ts         # schemastery 配置 schema（password、distIndex、dataDir、sessionTtl 等）
├── users.ts          # UserStore：用户记录、scrypt 哈希、凭据系统持久化
├── session.ts        # SessionStore：内存会话（用户 + 管理员标记）+ TTL 过期
├── ownership.ts      # OwnershipIndex: sessionId → 用户名索引（去抖写 JSON 文件）
├── api-filter.ts     # 按用户的 ApiProxy 装饰器：允许清单、所有权守卫、帧过滤
├── connection.ts     # dsh-login-connection：/api 通道接管 + WS 下联（子插件）
├── connection.client.ts  # 浏览器半边：原样转发自带 connection 客户端
├── admin-api.ts      # /api/auth/me + /api/auth/admin/* JSON 路由 + GET /admin 页面
├── auth.ts           # Cookie 管理 + 常量时间比较工具
├── gateway.ts        # 认证网关 handler（fallback + serveStatic）
├── login-api.ts      # POST /api/auth/login + logout + setup
├── login-page.ts     # 登录页、设置页与管理页 HTML
├── http-json.ts      # readBody/sendJson 工具 + resolveDshHome
└── web-runtime.ts    # webRuntime 接管：LAN 信任 + DSH_WEB_URL
dist/client.js        # 构建产物浏览器 bundle（npm run build:client）
scripts/build-client.mjs  # 从自带通道 bundle 重新生成 dist/client.js
tests/
├── *.spec.ts         # vitest 测试定义
└── memory-credentials.ts   # 测试用内存凭据提供器
```

## 许可证

MIT
