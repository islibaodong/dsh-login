# dsh-login

[English](./README.md) | 简体中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 加上**登录页、用户账号和会话隔离**的插件：访问先登录，普通用户互相看不见对话，管理员在 GUI 内管理所有账号。

| 登录页 | 用户管理（设置 → 用户管理） |
|:---:|:---:|
| ![登录页](images/login.png) | ![用户管理](images/users.png) |

> **⚠️ 本仓库开发已暂停。** 详见[当前状态 →](#当前状态--开发暂停)。

---

## 当前状态 —— 开发暂停

**本仓库的开发已暂停。** 已经交付的：登录墙、多账号用户管理、按用户隔离会话/工作区、remote-web-ui 兼容、能力发现、写过读静默拒绝 —— 均已完成并正常运行。唯一**无法完成**的是「**对第三方 UI 插件的功能按角色控制**」（隐藏无权项、不渲染、不让其发请求），而这是**被上游 DSH 能力阻塞**，不是本插件单靠自己能解决的。

**已完成并可用的**
- 登录墙 + 多账号用户管理（设置 → 用户管理）+ 按用户隔离会话/工作区。
- 能力发现（`GET /api/auth/capabilities`，会话鉴权）与写读静默拒绝（无权读探针 → `204`，写 → `403`，可用 `quietDenials` 开关），普通用户浏览器不再被「forbidden」报错墙和重试风暴困扰。
- dsh-login **自己**的设置项**已按用户显隐**：管理员看到「用户管理」，普通用户看到「账户」（身份 + 退出）；普通用户不会调用任何 admin 接口。

**已知限制 —— 为什么无法做到对整个 UI 的按角色控制**
- DSH 的设置面板渲染的是**一张全局分组列表**（`SettingsRoot` → `useSections`，`HostObservable<readonly SettingsSectionRow[]>`，无身份维度），因此某个插件的设置项无法在 `dsh-login` 内部按用户显隐。
- DSH 的 WebServer 路由优先级是 **exact 优先于 prefix**，且**没有前置路由钩子**，因此像 `@linxin666/dsh-pet` 这样自己注册精确路由（`/api/pet/pets`、`/api/pet/state`、…）的插件，无法被 `dsh-login` 按用户拦截或静默。
- DSH 客户端运行时以**无按用户启用开关**的方式激活所有 bundle 插件，因此未改动的第三方插件仍会对每个用户触发其挂载期请求。

**等待的是：** 上游 DSH 在客户端与路由层提供**按身份的分组过滤**或**条件化插件激活**。一旦具备，就可以在已交付的能力面之上实现「按角色控制功能（无权限即隐藏 / 不渲染 / 不发请求）」。

## 这个插件解决什么问题

DSH 的 Web GUI 本身**没有登录**——它按“单用户、localhost”设计。只要把服务绑到 `0.0.0.0`（手机访问、局域网共享、团队共用），**网络上任何人都能直接打开你的 GUI**：看到全部对话、用你配置的模型密钥消耗额度，甚至修改宿主配置。

`dsh-login` 把它变成一个多用户部署：

- 🔐 **登录墙** —— 页面、静态资源、SPA 路由、API、WebSocket 全部要求有效会话，未登录一律跳转 `/login`
- 👥 **多账号** —— 首次访问创建管理员账号，其余用户由管理员在 GUI 里直接新建，无需命令行
- 🙈 **会话隔离** —— 普通用户只能看到、操作**自己**的对话（含其派生的子代理/分叉）；其他人的会话、消息、工作区一律不可见；凭据、宿主设置等管理域整体禁用
- 🛠 **用户管理** —— 设置 → 用户管理：最后登录时间、在线会话数、重置密码、禁用、删除；禁用/删除/改密会**立即吊销**该用户的现有会话
- 👑 **管理员例外** —— 管理员不受隔离限制，可见全部会话，可配置宿主
- 🚪 **登出** —— 每个用户的设置面板里都有登出入口
- 🌐 **远程访问友好** —— 通过 frp/隧道或局域网 IP 访问 GUI 无需手改 `trustedHosts`：`/api` 主机信任围栏使用「实时有效集」（LAN 字面量 + `trustedHosts` + 已学习主机），且任何成功登录都会把请求 Host 学进持久化白名单，可在「设置 → 用户管理」里增删管理

## 快速开始

无需环境变量、无需改配置文件，三步：

```bash
# 1. 安装（web 就是启动 Web GUI 的 profile）
dsh plugin --profile web add github:islibaodong/dsh-login
```

2. **初始化**：重启 `dsh web` 并打开 GUI，首次访问会出现「创建管理员账号」页面，选好用户名密码即完成
3. **添加用户**：以管理员登录 → 设置 → 用户管理 → 新建用户

卸载：

```bash
dsh plugin --profile web remove @islibaodong/dsh-login
```

> 为什么 `--profile web`？DSH 插件按 profile 目录安装（`$DSH_HOME/profiles/<name>`）；`web` 就是启动 Web GUI 的 profile，用自定义 profile 的话换成对应名字即可。

## 常见问题

- **重启 DSH 后要重新登录？** 不需要——登录会话会持久化到 `<dataDir>/sessions.json`（0o600），已登录的 Cookie 跨进程重启仍有效（Cookie 本身默认 7 天）。只有登出、改密、删用户或 TTL 过期才会使其失效。
- **普通用户能做什么？** 正常使用对话：新建/打开/继续自己的会话、派生子代理、管理工作区里自己的内容。除此之外（他人会话、凭据、插件/预设/宿主设置、模型密钥管理）一律拒绝。
- **从旧版（单密码）升级？** 旧的单密码凭据不再能登录任何人；升级后首次访问会引导创建新的管理员账号（细节见下方「迁移说明」）。

---

# 技术细节

> 以下内容面向二次开发、安全审阅与排障；日常使用不需要阅读。

## 安装时发生了什么

`dsh plugin add` 读取本包声明的 `cordis.patch.yml`（bundle patch），自动完成：

- 挂载 `dsh-login` 插件行（配置默认值即可用；`distIndex` 自动解析前端 dist 目录）
- 禁用 `web-runtime` 行（dsh-web-app 通过它挂载 frontend-static fallback）；dsh-login 接管 fallback 席位并重新提供 `webRuntime` 服务（`/api` 信任围栏的 LAN 信任 + `DSH_WEB_URL` 环境变量）
- 禁用自带的 `connection` 行（`/api` 通道）；dsh-login 挂载自己的身份感知接管插件，并提供配套的浏览器 bundle `dist/client.js`

### 手动安装（可选）

希望自己管理 patch 文件时，把以下内容加进 profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-login
      name: '@islibaodong/dsh-login'
      config:
        password: DSH_LOGIN_PASSWORD   # 凭据引用名；派生用户存储引用（<名称>_USERS）
        distIndex: ''                  # 留空则自动解析前端 dist
        dataDir: ''                    # 留空则解析为 <DSH_HOME>/.dsh-login（所有权索引）
        sessionTtl: 604800             # 会话有效期，7 天（默认）
        autoTrustHosts: true          # 将任何成功登录的请求 Host 学习进 /api 白名单
        enabled: true                 # 设为 false 可临时禁用
        defaultWorkspace: true        # 为每个普通用户首次 /api 访问自动供给默认工作区（默认开，可在设置-用户管理实时开关）
        workspaceRoot: ''             # 默认工作区沙箱根，留空解析为 <DSH_HOME>/workspaces

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
4. **用户管理** -> 管理员在 GUI「设置 → 用户管理」列出（最后登录/在线状态）、创建、禁用/启用、删除用户及重置密码（`/api/auth/admin/*` JSON 路由；删除最后一个管理员会被拒绝）
5. **安全保护** -> 已有用户后 `/api/auth/setup` 返回 403，防止劫持

> **迁移说明：** 旧版单一密码凭据（默认引用 `DSH_LOGIN_PASSWORD`）不再能登录任何人。它保持已配置状态但认证不再使用——`password` 配置项现在只用于派生用户存储引用（`${password}_USERS`）。因此从单密码部署升级后，首次访问需要重新引导创建一个管理员账号。

## 工作原理

```
请求 -> WebServer
  ├─ /login (精确匹配)        -> 设置页（无用户时）或 登录页（有用户时）
  ├─ /api/auth/setup (精确)   -> POST: 首次创建管理员（已有用户则 403）
  ├─ /api/auth/login (精确)   -> POST: 验证 {username,password}，设置 Cookie
  ├─ /api/auth/logout (精确)  -> POST: 撤销会话，清除 Cookie
  ├─ /logout (精确)           -> GET: 同样撤销，重定向到 /login
  ├─ /api/auth/me (精确)      -> GET: 当前会话身份
  ├─ /api/auth/admin/* (精确) -> 管理员 JSON API（users、password、disable、remove）
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
- **会话令牌**：32 字节随机值（256 位），带 TTL 自动过期；会话携带用户名与管理员标记，并持久化到 `<dataDir>/sessions.json`（0o600）跨重启存续，避免已加载的 SPA 在进程重载后 /api 全部 401
- **密码存储**：scrypt 哈希（每用户独立盐），存于 DSH 凭据系统的 `${password}_USERS` 引用

## 多用户权限模型

- **普通用户只能使用会话功能。** 通过 `/api` 接管，他们只能看到和操作**自己**的会话及其派生子会话（子代理/分叉——所有权沿 `parentSessionId` 传递），工作区视图也被过滤为仅含自己的会话。其余一律禁止：
  - 物理层允许清单：固定的一组 `session.*`、`subagent.*`、`workspace.*`、`goal.*` 方法，加上 `skill.list`、`host.describe`、`llm.providers`/`llm.models` 和 `respond`；其他任何线上方法在到达 harness 之前就是 403
  - 管理员专属域：`credentials.*`、`settings.*`、`agentPresets.*` 整体禁用
  - 同样禁止：`llm.discoverModels` 以及特权 `host.*` 目录对话框（`pickDirectory`、`listDirectory`、`createDirectory`、`openPath`）
  - 工作区级变更按 `workspaceId` 所有权守卫：普通用户只能对「含自己会话」的工作区执行 `rename`/`delete`/`insertBefore`，`create` 只能落在自己的沙箱目录（`workspaceRoot/<username>`）内——既动不了他人的工作区，也不能把工作区指向任意宿主目录
  - 物理层 `session.export` 通道（目标在查询字符串中、不走信封）在通道层按所有权校验
  - 事件流（mux/host WebSocket 帧）按所有权过滤，其他用户的流量不会到达浏览器
- **默认用户工作空间（`defaultWorkspace`，默认开启）：** 非管理员首次经 `/api` 访问时，自动为其供给一个按用户名隔离的默认工作区——`mkdir` 其沙箱目录（`workspaceRoot/<username>`，默认 `<DSH_HOME>/workspaces/<username>`）→ 注册进 durable workspace registry → 附加一个会话（`sessions.create({ workspaceId })`，群组归属）并记入所有权索引，使工作区立即在 `workspace.list` 对用户可见、可直接开聊。这解决了普通用户在公网部署下因 `host.pickDirectory` 被禁而"无法添加工作区"的问题：**无需放开特权目录选择器**（安全不回退）。管理员可在「设置 → 用户管理」通过「默认用户工作空间」开关实时开/关（持久化于 `<dataDir>/settings.json`，即时生效，无需重启）；关闭不影响已存在的工作区。供给幂等（每用户每进程一次）、best-effort（失败不阻断请求）。
- **远程访问兼容（`remoteWebUiCompat`，默认开启）：** 不改动社区常用插件 `@linxin666/dsh-remote-web-ui`。该插件的 `/remote` 设备配对门槛会在非回环（公网 frp）访问时，对桌面端（模型对话框、历史、写作区）返回 401——这与 dsh-login 本身正常的 `/api` 鉴权无关。开启本项时，dsh-login 会把 remote-web-ui 的 `enabled` 写为 `true`（这正是让它挂载宿主路由 `/remote`、`/api/pair/*` 的关键；否则服务端什么都不响应，客户端会回落到死掉的 `/remote` 405 墙）并把 `requirePairingForLan` 写为 `false`（**实时、settings 驱动**、每次请求重读），使非回环访问走 dsh-login 用 `dsh_session` cookie 鉴权的 `/api` 通道；同时若配置了 `remoteWebUiPublicBaseUrl`，会一并写入 `publicBaseUrl`——公网 frp/隧道场景必须设置，否则 remote-web-ui 基于 Host 头的 `/api/pair/*` 围栏会拒绝公网来源（浏览器在 `/api/pair/status` 得到 403，客户端仍回落 `/remote`）。未安装 remote-web-ui 时本项无效果；管理员可在「设置 → 用户管理」的「远程访问兼容」开关实时开/关（持久化、即时生效）。注意：`remoteWebUiCompat` 默认开启意味着所有「dsh-login + remote-web-ui」部署的配对门槛都默认关闭——这是预期的，因为 dsh-login 自己的 `/api` 鉴权仍在其前面。
- **管理员可见可做一切：** 不受限的 API 访问、所有会话/工作区可见，以及「设置 → 用户管理」设置分区。
- **登出：** 设置面板的「用户管理/账户」分区为每个用户提供登出入口（POST `/api/auth/logout` → `/login`）；`GET /logout` 可作为普通链接使用。
- **管理员用户管理（设置 → 用户管理）：** 通过浏览器 bundle 内置在 GUI 设置面板中，无独立页面。其中有一张「访问白名单 / Trusted Hosts」卡片列出 `/api` 白名单（自动学习 + 手动添加），支持增删；删除立即生效。「默认用户工作空间」开关实时开/关默认工作区供给（持久化、无需重启），「远程访问兼容」开关实时开/关 remote-web-ui 配对绕过。用户列表显示每个账号的最后登录时间（每次成功登录时落盘；功能上线后从未登录过的账号显示「从未登录」）、在线会话数与禁用标记；每行提供重置密码、禁用/启用、删除操作（单行右对齐不换行）。普通用户则得到「账户」分区（身份信息 + 登出入口）。面板样式全部走框架的 `--dsw-alias-*` 主题令牌，自动跟随应用皮肤（浅色/深色）。

## 数据位置

| 数据 | 位置 |
|------|------|
| 用户账号（scrypt 哈希） | DSH 凭据系统，引用 `${password}_USERS`（默认 `DSH_LOGIN_PASSWORD_USERS`） |
| 会话→用户所有权索引 | `<DSH_HOME>/.dsh-login/ownership.json`（可用 `dataDir` 配置；`DSH_HOME` 环境变量或 `~/.dsh`） |
| 自动学习 / 管理员白名单 | `<DSH_HOME>/.dsh-login/trusted-hosts.json`（可用 `dataDir` 配置） |
| 默认用户工作空间开关 | `<DSH_HOME>/.dsh-login/settings.json`（可用 `dataDir` 配置） |
| 远程访问兼容开关 | `<DSH_HOME>/.dsh-login/settings-remote-web-ui.json`（可用 `dataDir` 配置） |
| 登录会话 | `<DSH_HOME>/.dsh-login/sessions.json`（0o600；跨重启存续，TTL 过期的自动剔除） |

## `/api` 通道接管与客户端 bundle

本插件替换自带的 `/api` connection 行：`cordis.patch.yml` 将其禁用（WebServer 拒绝重复的 `/api` 前缀注册，因此自带行必须保持关闭），`dsh-login` 以子插件形式挂载自己的身份感知通道（`src/connection.ts`）——同样的主机信任围栏，但每个请求都从会话 Cookie 解析身份并按用户分发。

**主机信任按请求实时求值。** 围栏不再用静态列表，而是一组去重后的「有效集」——web runtime 的 LAN 字面量 + `trustedHosts` + 持久化白名单（`src/hosts.ts`）。每次成功登录/setup 都会自动学习请求 Host（受 `autoTrustHosts` 控制，默认开启），因此经 frp/隧道访问的公网主机**登录一次即被信任**；已学习的主机立即生效、删除后无需重启即失效。

浏览器端的协议不变，但 GUI 的线上客户端必须继续由本包提供：client-modules 扫描器会把被禁用行的浏览器半边从启动图中剔除。因此 dsh-login 声明了自身的 `dsh.client` 并随包发布 bundle `dist/client.js`——它是自带 connection 客户端的重新打标副本（`src/connection.client.ts` 原样转发导出），**外加第二个模块注册**：设置面板包装器（`src/settings-panel.client.js`），它原样应用线上客户端并注册「设置 → 用户管理/账户」设置分区（样式走框架 `--dsw-alias-*` 主题令牌；样式表按框架 bundle 预置的形状预打 `data-plugin`/`data-plugin-css` 标签）。`dsh.client.inject` 字段遵循生态惯例——填浏览器半边所需服务背后的**包 id**（`@deepseek-ai/dsh-client-ui-settings`、`@deepseek-ai/dsh-client-locale`），而非服务名；运行时纤维自身导出的 `inject` 才是权威依赖。React 与 UI 原语经平台模块表种子解析，任何 bundle 都可合法 require。重新生成：

```bash
npm run build:client   # node scripts/build-client.mjs；使用 node_modules 或 $DSH_HARNESS_CHECKOUT
```

**升级 `@deepseek-ai/dsh-client-connection` 或修改 `src/settings-panel.client.js` 之后必须重新执行**，否则浏览器 bundle 会与新通道脱节。

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

1. 开启 `autoTrustHosts`（默认）时，任何成功登录都会把请求 Host 学进白名单（`/api/auth/admin/hosts`，可在「设置 → 用户管理」管理），于是 frp/隧道主机登录一次即被信任，无需手改 `trustedHosts`。如需只接受回环 + 显式 `trustedHosts`，把它设为 `false`
2. 在 DSH 前部署反向代理（nginx/caddy）进行 TLS 终结
3. 网关 Cookie 为 `SameSite=Strict`，可防止针对登录/登出端点的 CSRF 攻击

**排障：公网普通用户"无法添加工作区"？**

定位经验（供快速排查）：这类问题几乎**不是** Host 白名单（`autoTrustHosts` 已自动学习、登录也能通），而是普通用户被卡在**建工作区的特权目录选择器** `host.pickDirectory` 上——`api-filter.ts` 刻意对普通用户 403（连同 `listDirectory`/`createDirectory`/`openPath`）。前端"添加工作区"必须先调 `pickDirectory` 选宿主目录，普通用户被拒后永远建不成工作区，错误形如 `transport failure for /api/host.pickDirectory: HTTP 403`。

- 这不是部署坏，是**隔离安全设计**。**不要**为修它放开 `host.pickDirectory`（会让普通用户能浏览/选择宿主任意目录、破坏多用户隔离）。
- 正确解法是启用本插件的**默认用户工作空间**（`defaultWorkspace`，默认开）：非管理员首次 `/api` 访问即自动供给按其用户名隔离的沙箱工作区（含一个起步会话，`workspace.list` 立即可见可用），完全**绕开**被禁的目录选择器。管理员可在「设置 → 用户管理」用「默认用户工作空间」开关实时开/关。
- 若 `autoTrustHosts` 已开、公网登录也通、仍 403，几乎可锁定为上述 `pickDirectory` 方法级权限，而非信任栅栏。

## 架构说明：fallback vs prefix /

网关使用 `registerFallback()` 而非 `register({ kind: 'prefix', path: '/' })`，因为 DSH WebServer 的前缀匹配逻辑检查 `pathname.startsWith(prefix + '/')`。当 prefix 为 `/` 时，拼接结果为 `//`，而正常路径不会以 `//` 开头——所以 `prefix /` 路由只能精确匹配 `/` 这一个路径。fallback 处理器能捕获所有未被命名路由匹配的请求，这才是认证网关所需的 catch-all 行为。

WebServer 只有一个 fallback 席位。dsh-web-app 的 `web-runtime` 行会无条件挂载 frontend-static 占据它，因此使用 `dsh-login` 时必须禁用 `web-runtime` 行；dsh-login 会重新提供它负责的 `webRuntime` 服务（LAN 信任、`DSH_WEB_URL`），组合其余部分不受影响。

## 运行测试

```bash
# 标准全量测试（185 项；需要 DSH 源码做包解析——
# 设置 DSH_HARNESS_CHECKOUT，或在默认路径旁运行）
npx vitest run
```

`.spec.ts` 文件是标准的 vitest 测试定义，含多用户套件（`users`、`ownership`、`hosts`、`api-filter`、`connection`、`admin-api`、`multiuser-e2e`、`client-bundle`、`settings-panel`、`remote-web-ui-compat`）。`tests/runner.mjs` 和 `tests/integration-runner.mjs` 是针对原单密码核心的沙箱兼容运行器，未随多用户功能扩展。

## 项目结构

```
src/
├── index.ts          # Cordis 插件入口：注册路由、fallback、所有权 + 通道子插件
├── config.ts         # schemastery 配置 schema（password、distIndex、dataDir、sessionTtl 等）
├── users.ts          # UserStore：用户记录、scrypt 哈希、凭据系统持久化
├── session.ts        # SessionStore：会话（用户 + 管理员标记）+ TTL 过期，跨重启持久化
├── ownership.ts      # OwnershipIndex: sessionId → 用户名索引（去抖写 JSON 文件）
├── hosts.ts          # TrustedHosts: /api 主机信任白名单（实时有效集 + 去抖 JSON 持久化）
├── api-filter.ts     # 按用户的 ApiProxy 装饰器：允许清单、所有权守卫、帧过滤
├── connection.ts     # dsh-login-connection：/api 通道接管 + WS 下联（子插件）
├── connection.client.ts  # 浏览器半边：原样转发自带 connection 客户端
├── settings-panel.client.js  # 设置面板浏览器半边（纯 JS）：用户管理/账户分区，主题令牌样式
├── workspace-setting.ts  # 默认用户工作空间 runtime 开关（继承 BooleanSetting）
├── boolean-setting.ts  # live + 持久化的 {enabled} 运行时开关，被各管理开关复用
├── remote-web-ui-compat.ts  # 写入 remote-web-ui 的 enabled+requirePairingForLan+publicBaseUrl（settings 驱动、实时）以挂载其路由、绕过配对门槛并信任公网 Host
├── admin-api.ts      # /api/auth/me + /api/auth/admin/* JSON 路由（设置面板后端）
├── auth.ts           # Cookie 管理 + 常量时间比较工具
├── gateway.ts        # 认证网关 handler（fallback + serveStatic）
├── login-api.ts      # POST /api/auth/login + logout + setup
├── login-page.ts     # 登录页与设置页 HTML
├── http-json.ts      # readBody/sendJson 工具 + resolveDshHome
└── web-runtime.ts    # webRuntime 接管：LAN 信任 + DSH_WEB_URL
dist/client.js        # 构建产物浏览器 bundle（npm run build:client）
scripts/build-client.mjs  # 重新生成 dist/client.js：自带通道 bundle + 设置面板
tests/
├── *.spec.ts         # vitest 测试定义
└── memory-credentials.ts   # 测试用内存凭据提供器
```

## 许可证

MIT
