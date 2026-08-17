# dsh-login

[English](./README.md) | 简体中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 的单一密码认证网关插件。

## 它做什么

当 DSH Web 服务器暴露在 `0.0.0.0` 或公网时，`dsh-login` 要求用户输入密码后才能访问 Web GUI。它接管 WebServer 的 fallback 处理器，所有未被命名路由（如 `/api/*`）匹配的请求都会经过认证网关：

- **未认证请求** -> 重定向到 `/login`
- **已认证请求** -> 从前端 dist 目录提供静态文件

## 快速开始

```bash
dsh plugin --profile web add github:islibaodong/dsh-login
```

就这一步。该包的 `cordis.patch.yml` 声明为 bundle patch，`add` 之后会自动：

- 挂载 `dsh-login` 插件行（配置默认值即可用；`distIndex` 自动解析前端 dist 目录），
- 禁用 `web-runtime` 行（dsh-web-app 通过它挂载 frontend-static fallback），dsh-login 接管 fallback 席位并重新提供 `webRuntime` 服务（`/api` 信任围栏的 LAN 信任 + `DSH_WEB_URL` 环境变量）。

> 为什么需要 `--profile web`？DSH 没有"全局安装插件"的概念：插件按 profile 目录（`$DSH_HOME/profiles/<name>`）安装。`web` 就是启动 Web GUI 的 profile；如果你用的是自定义 profile，换成对应名字即可。

启动 DSH（`dsh web`），在浏览器中打开 Web GUI，你会看到设置密码页面。输入密码（两次确认）-- 密码自动存储到 DSH 凭据系统中。后续访问将显示正常的登录页。

无需设置环境变量，无需编辑配置文件。密码在首次使用时通过浏览器设置。

### 手动安装（可选）

如果你希望自己管理 `cordis.patch.yml`，可以把以下内容手动加进 profile 的 patch 文件：

```yaml
- insert:
    - id: dsh-login
      name: '@deepseek-ai/dsh-login'
      config:
        password: DSH_LOGIN_PASSWORD   # 凭据引用名（不是密码本身）
        distIndex: ''                  # 留空则自动解析前端 dist
        sessionTtl: 604800             # 会话有效期，7 天（默认）
        enabled: true                 # 设为 false 可临时禁用

# 重要：dsh-login 接管 fallback 席位，必须禁用 web-runtime 行
# （dsh-web-app 通过该行挂载 frontend-static；dsh-login 会重新提供 webRuntime 服务）
- id: web-runtime
  disabled: true
```

> 注意：新增行必须写在 `- insert:` 下——顶层直接写行会被当成对已存在行的覆盖，对不存在的行是静默空操作；禁用行的键是 `disabled`（不是 `disable`）。

## 首次设置流程

1. **首次访问**（无密码配置）-> `/login` 显示「设置密码」页面
2. 用户输入密码两次（确认）-> `POST /api/auth/setup` 通过 `ctx.credentials.set()` 自动存储
3. **后续访问** -> `/login` 显示正常登录页（密码已存储）
4. **安全保护** -> 密码已设置后 `/api/auth/setup` 返回 403，防止劫持

## 工作原理

```
请求 -> WebServer
  ├─ /login (精确匹配)        -> 设置页（无密码时）或 登录页（有密码时）
  ├─ /api/auth/setup (精确)   -> POST: 首次设置密码（已设置则 403）
  ├─ /api/auth/login (精确)   -> POST: 验证密码，设置 Cookie
  ├─ /api/auth/logout (精确)  -> POST: 撤销会话，清除 Cookie
  ├─ /api/* (前缀匹配)        -> client-connection（主机信任检查）
  └─ fallback (兜底)          -> dsh-login: 认证网关 + 静态文件服务
                                 ├─ 无有效 Cookie -> 302 重定向到 /login
                                 └─ 有有效 Cookie -> serveStatic() 提供文件
```

- **Cookie 名称**：`dsh_session`，HttpOnly、SameSite=Strict、Path=/
- **会话令牌**：32 字节随机值（256 位），内存存储，带 TTL 自动过期
- **密码比较**：使用 `crypto.timingSafeEqual` 常量时间比较，防止时序攻击
- **密码存储**：通过 DSH 凭据系统的 `credentialRef` 引用，首次使用时通过浏览器写入本地凭据文件，不会出现在配置文件中

## 安全说明

### 网关保护范围

| 资产 | 保护方式 |
|------|----------|
| 页面导航 (`/`) | 未认证时 302 重定向到 `/login` |
| 静态资源 (`/assets/*.js`、`.css` 等) | 同样的网关检查 |
| SPA 路由 (`/conversations`、`/settings` 等) | 同样的网关检查 |

### 网关不保护的范围

| 资产 | 现有保护 |
|------|----------|
| API 请求 (`/api/*`) | `isTrustedApiRequest` 主机信任检查（仅 loopback 或配置的 `trustedHosts`） |
| WebSocket (`/api/events.mux`、`/api/events.host`) | `isTrustedApiRequest` 主机信任检查 |

### 公网暴露建议

1. 将 `trustedHosts` 设置为仅允许需要访问 API 的特定主机
2. 在 DSH 前部署反向代理（nginx/caddy）进行 TLS 终结
3. 网关 Cookie 为 `SameSite=Strict`，可防止针对登录/登出端点的 CSRF 攻击

## 架构说明：fallback vs prefix /

网关使用 `registerFallback()` 而非 `register({ kind: 'prefix', path: '/' })`，因为 DSH WebServer 的前缀匹配逻辑检查 `pathname.startsWith(prefix + '/')`。当 prefix 为 `/` 时，拼接结果为 `//`，而正常路径不会以 `//` 开头——所以 `prefix /` 路由只能精确匹配 `/` 这一个路径。fallback 处理器能捕获所有未被命名路由匹配的请求，这才是认证网关所需的 catch-all 行为。

WebServer 只有一个 fallback 席位。dsh-web-app 的 `web-runtime` 行会无条件挂载 frontend-static 占据它，因此使用 `dsh-login` 时必须禁用 `web-runtime` 行；dsh-login 会重新提供它负责的 `webRuntime` 服务（LAN 信任、`DSH_WEB_URL`），组合其余部分不受影响。

## 运行测试

```bash
# 单元测试 + 集成测试（需要 DSH 源码用于包解析）
node --import tsx tests/runner.mjs              # 单元测试（40 项）
node --import tsx tests/integration-runner.mjs  # 集成测试（67 项，含 patch 格式回归）

# 或使用 vitest（在非沙箱环境中）：
npx vitest run
```

`tests/runner.mjs` 和 `tests/integration-runner.mjs` 是沙箱兼容的测试运行器，绕过了 esbuild 二进制（在某些沙箱环境中会被阻断）。`.spec.ts` 文件是标准的 vitest 测试定义。

## 项目结构

```
src/
├── index.ts          # Cordis 插件入口，注册路由和 fallback
├── config.ts         # schemastery 配置 schema
├── session.ts        # SessionStore: 内存会话存储 + TTL 过期
├── auth.ts           # 密码验证 + Cookie 构建/解析
├── gateway.ts        # 认证网关 handler（fallback + serveStatic）
├── login-api.ts      # POST /api/auth/login + logout + setup
└── login-page.ts     # 登录页 + 设置密码页 HTML
tests/
├── *.spec.ts         # vitest 测试定义（可在标准环境运行）
├── runner.mjs        # 沙箱兼容单元测试运行器
├── integration-runner.mjs  # 沙箱兼容集成测试运行器
└── memory-credentials.ts   # 测试用内存凭据提供器
```

## 许可证

MIT
