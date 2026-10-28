# dsh-login

[English](./README.md) | 简体中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI 加上**登录页、用户账号和会话隔离**的插件：访问先登录，普通用户互相看不见对话，管理员在 GUI 内管理所有账号。

| 登录页 | 用户管理（设置 → 用户管理） |
|:---:|:---:|
| ![登录页](images/login.png) | ![用户管理](images/users.png) |

## 这个插件解决什么问题

DSH 的 Web GUI 本身**没有登录**——它按“单用户、localhost”设计。只要把服务绑到 `0.0.0.0`（手机访问、局域网共享、团队共用），**网络上任何人都能直接打开你的 GUI**：看到全部对话、用你配置的模型密钥消耗额度，甚至修改宿主配置。

`dsh-login` 把它变成一个多用户部署：

- 🔐 **登录墙** —— 页面、静态资源、SPA 路由、API、WebSocket 全部要求有效会话，未登录一律跳转 `/login`
- 👥 **多账号** —— 首次访问创建管理员账号，其余用户由管理员在 GUI 里直接新建，无需命令行
- 🙈 **会话隔离** —— 普通用户只能看到、操作**自己**的对话（含其派生的子代理/分叉）；桥墙对普通用户拒绝白名单外的方法，并把 `session.list`/`session.search`/`workspace.list` 响应收窄为自己拥有的会话；组合后的 REMOTE 层守卫再按所有权收窄分发；其他人的会话、消息、工作区一律不可见；凭据、宿主设置等管理域整体禁用
- 🛠 **用户管理** —— 设置 → 用户管理：最后登录时间、在线会话数、重置密码、禁用、删除；禁用/删除/改密会**立即吊销**该用户的现有会话
- 👑 **管理员例外** —— 管理员不受隔离限制，可见全部会话，可配置宿主
- 🚪 **登出** —— 每个用户的设置面板里都有登出入口
- 🌐 **远程访问友好** —— 通过 frp/隧道或局域网 IP 访问 GUI 无需手改 `trustedHosts`：`/api` 主机信任围栏使用「实时有效集」（LAN 字面量 + `trustedHosts` + 已学习主机），且任何成功登录都会把请求 Host 学进持久化白名单，可在「设置 → 用户管理」里增删管理

---

## 当前状态 —— 已发布（option A）

> **已发布：`@islibaodong/dsh-login@0.3.8`（git 标签 `v0.3.8`；已在 npm 发布——`latest` = 0.3.8）。** 已验证兼容 DSH **0.2.2-alpha.2**（2026-10-28；全量测试 21 文件 / 267 用例在正式 alpha.2 构建上全绿）。**0.3.8 的新内容：** 上游一天内连发两个版本——0.2.1-rc.4（504a01a957，仅版本号与 UI 修补，对适配面零影响）与 0.2.2-alpha.2（f3803c9697，release merge PR #7437，2161 个提交）。线方法（wire surface）146 → 199：新分类 53 个方法——`forgePanel.*` 18 个（每会话 git worktree/PR 面板，首参 `sessionId` 由网关解析并做归属校验，会话作用域）与 `session.events/observeEvent/observeProjections/observeState/state/wait` 6 个、`toolResults.watch`（会话自身的工具结果流）、`actionCards.act`、`pluginRecommendations.describe` 一并放行给普通用户；`cuaAccess.*` 9 个（CUA 同意/应用图标）、`pluginManager.listVersions/readBundleDetail/updateBundle`、`pluginMarket.readEntryDetail`、`schedule.deleteInactive` 与整个 `liveshareShares` 命名空间 12 个（上游声明为 owner 专属的分享管理面——对外发布会话、宿主中继、owner 身份、审计——多用户部署下属运维员领地）门控为 admin 专属。桶尺寸 119 用户 / 79 管理员 / 1 宿主内部（共 199，穷尽且测试强制）。PR #6901 重写了 `@deepseek-ai/dsh-host-frontend-static` 为 WebResource API 的 cordis 插件并删除了 `serveStatic` 导出——`src/serve-static.ts` 以 node:http 自持鉴权静态回退（dist 根限定、index 走 `authorizeIndex()`+`renderIndex()`，信任形状不变）。devDeps 重定向到 11 个 dsh 包 `^0.2.2-alpha.2` + vendor alpha（cordis ~4.0.6-alpha.1、schemastery ~3.18.6-alpha.1、include ~1.0.11-alpha.1、loader ~1.0.7-alpha.1）；peerDeps 为 7 个 dsh 包追加 `|| >=0.2.2-alpha.2 <0.3.0-0` 段（semver prerelease 元组规则：旧段 `>=0.2.1-alpha.1 <0.3.0-0` 不匹配 [0,2,2] 元组）并为 cordis/schemastery 加 vendor alpha 分支。多用户复核：上游仍无原生账号体系（grep 唯一命中仍是 remote-access README）。
>
> **适配历史（以下版本均已在 npm 发布）：** `0.3.8` → DSH 0.2.2-alpha.2（devDep 重定向到 alpha.2 元组线并采用重新发布的 vendor alpha；peer 追加 `>=0.2.2-alpha.2 <0.3.0-0` 段 + vendor alpha 倾斜；线方法 146 → 199——`forgePanel.*` 18 + `session.events/observeEvent/observeProjections/observeState/state/wait` 6 + `toolResults.watch` + `actionCards.act` + `pluginRecommendations.describe` 按用户方法放行，`cuaAccess.*` 9 + `pluginManager.listVersions/readBundleDetail/updateBundle` + `pluginMarket.readEntryDetail` + `schedule.deleteInactive` + `liveshareShares.*` 12 门控为 admin；`src/serve-static.ts` 替代被上游 PR #6901 移除的 `@deepseek-ai/dsh-host-frontend-static` `serveStatic` 导入——网关自持鉴权静态回退；桶尺寸现为 119/79/1；多用户复核——仍无原生账号，grep 唯一命中仍是 remote-access README）；`0.2.1` → DSH 0.1.6-alpha.1（侧栏**终端**、**会话取消归档**）；`0.2.2` → 0.1.6-alpha.2（共享 `/api` 桥鉴权墙 `apiBridgeAuth`、文档预览 `workspaceFiles`/`officeToPdf` 用户面、原生 `pluginManager` 命名空间仅管理员）；`0.2.3` → 0.1.7-alpha.2（设置 seam 重构、新 `account` 命名空间仅管理员、`job` 控制器用户面、会话置顶）；`0.2.4` → DSH #4587 设置报错修复；`0.2.5` → DSH 0.2.0-rc.2（peer 重定向到 0.2.0 元组线——兼容面验证源码零改动，无需代码适配）；`0.2.6` → issue #3 修复（新设备登录后的首次页面加载命中核心 BrowserAuth 的纯文本 401——网关现在会先 302 一次经过 `?token=` 交换，让核心铸出浏览器 Cookie）；`0.2.7` → DSH 0.2.1-alpha.1（peer 重定向到 0.2.1 元组线 + 移除已退役的 `@deepseek-ai/dsh-invariants` 引用——无源码改动）；`0.3.0` → 整 UI 按角色门控 `uiRoleGate` 在引导图杠杆上落地（仍跟随 DSH 0.2.1-alpha.1）；`0.3.1` → 共享 `/api` 桥墙按用户强制（`USER_ALLOWED` 方法门、`session.list`/`session.search`/`workspace.list` owned-only 收窄、所有权记录含管理员 record-only、默认工作区供给接线）+ `composeDshLoginGuard` 部署胶水（无上游改动——仍 0.2.1-alpha.1）；`0.3.2` → DSH 0.2.1-alpha.2（devDep 重定向——peer 元组本就接纳 alpha.2——加上 `dsh web:` URL 行/`DSH_WEB_URL` 改拼实际绑定地址；上游退役其 `webRuntime` 服务，dsh-login 的接管转为纯兼容保留，上游另新增 TLS）；`0.3.3` → DSH 0.2.1-alpha.3（devDep 重定向到随 alpha.3 重新发布的 vendor alpha——peer 不变；供给 `webApp` 让新 `harness-dev-context` 行注入成功；放行面跟上 alpha.3 线面：`terminal.attach` 取代 follow/write/resize、放行 `remoteAccess.follow`；上游首个 RBAC 基座已评估）；`0.3.4` → DSH 0.2.1-alpha.4（devDep 重定向——peer 元组本就接纳 alpha.4；新 `pluginMarket` 命名空间——插件市场的实例级索引配置——三层全部挡成管理员专属；`uiRoleGate` 引导图过滤回归测试确保保留新的 `release` 图字段）；`0.3.5` → DSH 0.2.1-rc.2（devDep 重定向到 rc.2 元组线 + vendor 转 stable——peer 不变，alpha peer 范围接纳 stable；整个适配面验证源码零变更、`/api` 控制器零 diff——无代码改动；新 `web-deepseek-api`/`ui-deepseek-model-label-1017`/`ui-settings-web-search` 不新增 wire 面；多用户/RBAC 复核仍无原生能力）；`0.3.7` → DSH 0.2.1-rc.3（devDep 重定向——peer 本就接纳 rc.3；rc.3 是纯客户端 UI 版本（6 commits：导航入口自定义、导航钉住/菜单图标修复、analytics 事件、llm `/models` 列表重构），146 方法 wire 注册表与 rc.2 逐字节一致、引导图杠杆原封未动——无源码改动）。0.1.7-rc.1 / rc.2 验证兼容、无需发版——详见 [`docs/adapt-dsh-0.1.7-rc.1.md`](docs/adapt-dsh-0.1.7-rc.1.md) / [`docs/adapt-dsh-0.1.7-rc.2.md`](docs/adapt-dsh-0.1.7-rc.2.md) / [`docs/adapt-dsh-0.2.0-rc.2.md`](docs/adapt-dsh-0.2.0-rc.2.md)。上游**仍然没有**原生多用户账号与按角色的 UI 门控，但 0.2.1-alpha.3 交付了首个**原生 RBAC 基座**（面向非 owner 连接的 `packages/api/remote-access` + 多主体 Peer；2026-10-16 在 0.2.1-alpha.4 重新评估——见下文）。

**`@islibaodong/dsh-login@0.3.8` 已发布（git 标签 `v0.3.8`；已在 npm 发布——`latest` = 0.3.8）。** 0.3.8 跟随 DSH **0.2.2-alpha.2**（2026-10-28）：线方法 146 → 199，静态托管接缝上移（PR #6901 删除了 `@deepseek-ai/dsh-host-frontend-static` 的 `serveStatic` 导出，dsh-login 现以 `src/serve-static.ts` 自持鉴权回退——信任形状不变：dist 根限定路径、index 走 `authorizeIndex()` + `renderIndex()`），方法墙按真实 alpha.2 注册表重新推导（199 个方法中 119 用户 / 79 admin / 1 宿主内部，穷尽且测试强制）。新用户面：每会话 forge 面板（`forgePanel.*`——作用域为会话自身 checkout 的 git worktree/变更请求操作，首参 `sessionId` 由网关解析并做归属校验）、会话状态/观察（`session.events/observeEvent/observeProjections/observeState/state/wait`）、`toolResults.watch`（会话自身的工具结果流）、`actionCards.act`、`pluginRecommendations.describe`。新 admin 专属面：CUA 同意（`cuaAccess.applicationIcons/applications/enablePersistentPtc/openSettings/ptcConfiguration/requestPermission/retryApproval/revoke/systemStatus`）、插件详情/更新（`pluginManager.listVersions/readBundleDetail/updateBundle`、`pluginMarket.readEntryDetail`）、`schedule.deleteInactive` 与整个 `liveshareShares` 命名空间（上游声明为 owner 专属分享管理面——向外部查看者发布会话、宿主中继、owner 身份、审计轨迹——多用户部署下的运维员领地）。0.3.6 是 issue-#4 修复：普通用户方法放行面按 DSH 0.2.1-rc.2 真实线面重推（92 用户 / 53 admin / 1 宿主内部，共 146 方法，穷尽且测试强制），非管理员的模型选择、添加工作区与设置→模型恢复工作。DSH ≥ 0.1.5-alpha.1 的 option-A 适配完成并跟随上游至 **0.2.2-alpha.2**（2026-10-28 验证）：dsh-login 不再接管 `/api`——原生 `connection` + `api-remotes`/`api-gateway` 栈持有传输——并在此之上组合登录墙（回退席）、共享 `/api` 桥上的 `apiBridgeAuth` 墙与能力发现。**0.3.0 交付按角色的整 UI 门**：`uiRoleGate: true`（默认）时网关为普通用户过滤 `window.__DSH_BOOT__` 引导图，admin 专属客户端包不再挂载（`src/ui-gate.ts`；拒绝清单 = `ADMIN_ONLY_UI_PLUGINS`；管理员与 `uiRoleGate:false` 看到完整图；任何意外形状 fail-open）。桥墙新增（0.3.1）每用户方法门（`USER_ALLOWED`）、`session.list`/`session.search`/`workspace.list` 的 owned-only 响应收窄、归属记录（含管理员创建的资源，仅记录）与每用户默认工作区供给。0.3.2 镜像上游 bind-address URL 行（上游 `webRuntime` 退役使接管仅余兼容）。0.3.3 重定向 devDeps 至 0.2.1-alpha.3 并为新 `harness-dev-context` 行 provide `webApp`。0.3.4 重定向 devDeps 至 0.2.1-alpha.4（peer 已放行）并保持墙与新线面同步：alpha.4 的**插件市场**（`packages/boot/plugin-market`，typert 命名空间 `pluginMarket`——实例级市场索引列表的 `listIndexes`/`setIndexes`/`search`）在**全部三层**门控为 admin（`src/remote-guard.ts` `ADMIN_ONLY_NAMESPACES`、`src/capabilities.ts` 两段拒绝 + admin 广告 + `listIndexes`/`search` 静默探测、`setIndexes` 保持响亮 403），引导图新 **`release`** 戳（`WebBootRelease {version, commit?}`——alpha.4 的客户端重载门控）经 `uiRoleGate` 过滤器字节级保留并有回归测试。0.3.5 重定向 devDeps 至 0.2.1-rc.2（peer 已放行，vendor 稳定重发）——适配面**源码零改动**（每个集成点只变 `package.json`；`/api` 控制器零 src diff），墙无需编辑；rc.2 新增（`web-deepseek-api`、`ui-deepseek-model-label-1017`、`ui-settings-web-search`）无线方法。全量测试 **21 文件 / 267 用例**在正式 0.2.2-alpha.2 构建上全绿（含真实组合测试于启动的服务器上）。**有意未做启动验证（需真实 `dsh web` 启动确认）：** 经出厂部署胶水（[`docs/compose-guard.md`](docs/compose-guard.md)）组合在原生 `typertGateway` 之上的每用户隔离守卫，与双浏览器隔离签核（见 [`docs/verify-option-A.md`](docs/verify-option-A.md) §B）。本发布的完整面分析见 [`docs/adapt-dsh-0.2.2-alpha.2.md`](docs/adapt-dsh-0.2.2-alpha.2.md)，最初的状态矩阵见 [`docs/adapt-dsh-0.1.5.md`](docs/adapt-dsh-0.1.5.md)。
任务清单与验收矩阵见 [`docs/verify-option-A.md`](docs/verify-option-A.md)。

**已完成并可用的**
- 登录墙 + 多账号用户管理（设置 → 用户管理）+ 按用户隔离会话/工作区。
- 能力发现（`GET /api/auth/capabilities`，会话鉴权）与桥墙静默拒绝（普通用户无权 POST → wire 正确的 forbidden envelope（HTTP 200），可切回 403，`quietDenials` 开关），普通用户浏览器不再被「forbidden」报错墙和重试风暴困扰。
- dsh-login **自己**的设置项**已按用户显隐**：管理员看到「用户管理」，普通用户看到「账户」（身份 + 退出）；普通用户不会调用任何 admin 接口。
- **按用户隔离守卫作为组合原语交付（option A）。** DSH ≥ 0.1.5 下 `/api` 归原生 `connection`/`api-gateway` 持有，dsh-login 的隔离是 REMOTE 层守卫——`wrapRemoteGateway` + `createRemoteIsolation`，从本包宿主 bundle 导出并经单元/集成测试（含所有权收窄与管理员放行）。包装器会原样转发守卫两个分发方法之外的全部网关成员（例如 DSH 0.2.0-rc.2 新增的必需方法 `hasLiveClient()`），组合后接口始终完整。`connection` 所有权与按用户默认工作区已在原生栈上重建。**守卫需在启动时组合进原生 `typertGateway` 行**（部署决策，非运行时热替换——重新 provide `typertGateway` 会触发重复服务错误）；dsh-login 已交付现成胶水——所有权 sidecar 以 `dshLoginOwnership` 服务发布，`composeDshLoginGuard(ctx, gateway)` 一步包装原生网关（完整行模块与验收清单见 [`docs/compose-guard.md`](docs/compose-guard.md)）。两浏览器行为验收仍是部署侧步骤。详见 [`docs/verify-option-A.md`](docs/verify-option-A.md) §B。
- **跟随上游 0.1.5-alpha.1 → 0.2.1-rc.3。** 每个上游版本的用户面线方法随发布即加入普通用户放行面（侧栏 `terminal.*`、`workspace.unarchiveSession`/`pinSession`/`unpinSession`、只读 `workspaceFiles`/`officeToPdf` 文档预览、`job` 控制器；0.2.0 未新增任何 wire 方法或命名空间；0.2.1 新增 `claudeCodeMods` 命名空间——提示框上方的 agent-mod 带状 UI——走默认拒绝，暂无用户面；0.2.1-alpha.2 也未新增；0.2.1-alpha.3 以 `terminal.attach` 流取代终端三方法，并放行 `remoteAccess.follow`——原生 remote-access 快照流，只回答调用者自己的授权；0.2.1-alpha.4 新增 `pluginMarket` 命名空间——整体管理员专属，见下文；0.2.1-rc.2 完全未新增 wire 方法或命名空间——整个适配面源码零变更，rc.2 新包均为 agent 侧或纯 UI；0.2.1-rc.3 同样未新增任何 wire 方法或命名空间——其改动全部在客户端 UI（导航入口自定义、导航钉住/菜单图标、analytics 事件、llm `/models` 列表重构））；0.2.2-alpha.2 新增 53 个（forge 面板、会话状态/观察、`toolResults.watch`、CUA 同意、插件详情/更新、`actionCards.act`、`pluginRecommendations.describe`、`schedule.deleteInactive` 与 Liveshare 分享管理——分类见上）），而新的管理员专属命名空间（`pluginManager` + `pluginRegistryProbe`、DeepSeek Platform 的 `account` 控制器——唯一进程级上游授权，含 0.1.7-rc.2 的 `watchExpiry` 过期通知流、以及 0.2.1-alpha.4 的 `pluginMarket`，以及 0.2.2-alpha.2 的 `liveshareShares` 命名空间与其 `cuaAccess`/`pluginManager` 详情/更新新增）整体禁用。DSH ≥ 0.1.7-rc.1 起，宿主在启动期对 peer 范围运行**插件兼容性准入**——dsh-login 的 peer 范围接纳当前 runtime（0.2.7 已加入 0.2.1 分支），且该检查是 fail-open（仅 stderr 报告）：任何 DSH 升级后，请确认登录页真的出现了。0.3.0 另行交付 `uiRoleGate`——按角色的整 UI 引导图过滤（见下文）。

**对整个 UI 的按角色控制 —— 0.3.0 已交付（`uiRoleGate`）**
- **dsh-login 0.3.0 在插件内实现了整 UI 门控（无需上游改动）。** 网关自己渲染 index，客户端模块清单以 `window.__DSH_BOOT__` 的形式就在这份 HTML 里；页面只激活该清单（`ClientEntries.reconcile()` 为清单每一行创建一个条目，并**移除**不在清单中的 bundle）。当 `uiRoleGate: true`（默认）且会话为普通用户时，网关在返回 index 前重写引导图：命中 `ADMIN_ONLY_UI_PLUGINS` 拒绝列表的条目被剔除，其所属批次被修补或删除，shell 因此永远不会挂载这些 bundle。仅是展示层——安全边界仍是 `/api` 放行面（`apiBridgeAuth` + `USER_ALLOWED`）。管理员拿到完整图；任何意外形状一律 fail-open（原样返回 HTML）。详见 [`docs/adapt-dsh-0.2.1-alpha.1.md`](docs/adapt-dsh-0.2.1-alpha.1.md) §6。
- **该门不做的事：** 粒度只到**包**——放行包**内部**的某个 slot/设置项（例如 DSH 设置面板，其 `SettingsRoot` → `useSections` 列表没有身份维度）仍不在范围内。DSH 的 WebServer 路由优先级是 **exact 优先于 prefix** 且没有前置路由钩子，因此像 `@linxin666/dsh-pet` 这样自己注册精确路由（`/api/pet/pets`）的插件，同样无法被 `dsh-login` 按用户拦截。
- 上游仍**没有按身份的 UI 门**：客户端引导/激活层与 ui-slots 完全没有 `role`/`permission`/`isAdmin` 概念（2026-10-28 在 0.2.2-alpha.2 复核，此前 2026-10-24 在 0.2.1-rc.3：`isAdmin`/`isAllowed` 在 `packages/client` 下零命中——注意约 238 个文件仍会命中裸 `role` 搜索，那是 DOM `role="…"` 无障碍属性，不是账号角色）。0.2.1-alpha.3 新增的 remote-access RBAC 是**非 owner Peer 连接的服务端**按资源 `decide()` + 快照注入，管的是连接授权而不是客户端 UI 装配——与本引导图门是完全不同的轴；0.2.1-alpha.4 在此无变化（其 `release` 图字段是客户端 reload 门控的发布标识管道，不是权限轴，dsh-login 的门控会保留它）；0.2.1-rc.2 复核无变化；0.2.1-rc.3 同样（其 UI 改动是内容级自定义，不是权限轴）；0.2.2-alpha.2 于 2026-10-28 复核——其新客户端包（forge 面板 UI、liveshare 查看器、CUA 同意 UI）经同一引导图挂载，无权限轴，门的拒绝清单不变。

**上游多用户 / RBAC 评估（首次 0.2.1-alpha.3，2026-10-15；0.2.1-alpha.4，2026-10-16、0.2.1-rc.2，2026-10-18、0.2.1-rc.3，2026-10-24 与 0.2.2-alpha.2，2026-10-28 复核）**
- **没有原生用户账号**——没有用户存储、没有登录、没有身份 UI（每日常规的 `multi.?user|multiuser|role.?based|\brbac\b` 搜索六次 watch 以来**首次命中**：`packages/api/remote-access/README.md`；0.2.1-rc.2 仍只有这一条命中，0.2.1-rc.3（2026-10-24）同样只有这一条，0.2.2-alpha.2（2026-10-28）亦然——2161 个提交的积压，线面仍然没有账号存储）。dsh-login 仍是账号/认证层。
- **0.2.1-alpha.3 实际新增的是**：面向非 owner Peer 的原生**只授权 RBAC 引擎**（`packages/api/remote-access`：`Principal`/`PrincipalMap`——今天只有 `{kind:'owner'}` 一种，可扩展合并——加 `registerPolicy`/按资源 `decide`、以 `__DSH_REMOTE_ACCESS__` 全局注入的 owner 基线快照、永远放行的 `remoteAccess.follow` 快照流），以及背后的**多主体连接机制**（`createPeer`/`admitConnection`、v2 API Cookie `{version:2, id: PeerId}`、`GET /connect` token 交换、socket 所有权 409）。这是未来原生按资源/整 UI 权限体系会踩的基座——目前还没有任何东西把它用于 dsh-login 的场景。
- **为什么不改变 dsh-login 的安全模型**：dsh-login 用户以 **owner 主体**抵达原生栈（浏览器 Cookie 铸出 `browserPeer {kind:'owner'}`），而 remote-access 从不拦截 owner——dsh-login 的登录墙、`USER_ALLOWED` 桥墙、remote 守卫与 `uiRoleGate` 仍是真正的多用户边界。该基座已知的泄露点（未声明资源 UNCHECKED、api-session `added` 条目泄露 `parentSessionId`、ready 帧暴露完整 host/home）已由 dsh-login 自己的清洗逻辑覆盖。0.2.2-alpha.2 处基座本身有所生长（`forgePanel`/`liveshareShares`/`session` 资源种类上的角色绑定、每 Peer 访问快照）但仍然只门控非 owner Peer——dsh-login 用户保持 owner 主体，评估不变（2026-10-28 复核，见 [`docs/adapt-dsh-0.2.2-alpha.2.md`](docs/adapt-dsh-0.2.2-alpha.2.md) §6）。
- **未来可选项（已记录，本次不集成）**：若 dsh-login 将来铸造非 owner 主体，可按 dsh-login 角色注册 remote-access 策略，免费获得原生按资源强制。

**仍希望上游提供：** 按身份的分组/设置项**过滤**（用于放行包**内部**的细粒度控制）与宿主侧的按用户插件激活门。0.2.2-alpha.2 处两者都没有（remote-access 基座是按资源的*连接*策略，不是 UI 激活；0.2.1-alpha.4 新增的是管理员专属的插件市场与 `release` 引导图戳——发布标识管道，不是权限轴；rc.2/rc.3 在此无新增；0.2.2-alpha.2 的新 UI 包走同一激活层——其 `forgePanel`/`liveshareShares`/`session` RBAC 新增同样只作用于连接轴）；0.3.0 的引导图门控目前只能覆盖整个包。

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
- 禁用 `web-runtime` 行（dsh-web-app 通过它挂载 frontend-static fallback）；dsh-login 接替 fallback 席位作为登录墙并重新提供 `webRuntime` 服务（`/api` 信任围栏的 LAN 信任 + `DSH_WEB_URL` 环境变量）
- **保留**自带的 `connection` 行（option A，DSH ≥ 0.1.5-alpha.1：`/api` 通道归上游 `dsh-client-connection` + `api-remotes`/`api-gateway` 持有）；dsh-login 提供自己的浏览器 `dsh.client` 贡献（设置面板 `dist/client.js`），并按其凭据 cookie 在 login 墙后调度

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
        apiBridgeAuth: true           # 共享 /api 桥要求 dsh_session 会话（DSH ≥ 0.1.6-alpha.2，默认开）

# 重要：dsh-login 接替 fallback 席位作为登录墙，必须禁用 web-runtime 行
# （dsh-web-app 通过该行挂载 frontend-static；dsh-login 会重新提供 webRuntime 服务）
- id: web-runtime
  disabled: true

# option A（DSH ≥ 0.1.5-alpha.1）：**不要**禁用自带的 connection 行——`/api`
# 通道归上游 connection + api-gateway/remotes 持有，dsh-login 在其上做登录墙与
# 按用户层（设置面板由本包自带的 dsh.client 贡献 dist/client.js 提供）。
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
  ├─ /api/...                 -> 原生 connection + api-remotes/api-gateway（option A）：
  │                            浏览器会话认证、typert REMOTE 分发、WS 流
  └─ fallback (兜底)          -> dsh-login: 认证网关 + 静态文件服务
                                  ├─ 无有效 Cookie -> 302 重定向到 /login
                                  └─ 有有效 Cookie -> serveStatic + connection.authorizeIndex
```

- **Cookie 名称**：`dsh_session`，HttpOnly、SameSite=Strict、Path=/
- **会话令牌**：32 字节随机值（256 位），带 TTL 自动过期；会话携带用户名与管理员标记，并持久化到 `<dataDir>/sessions.json`（0o600）跨重启存续，避免已加载的 SPA 在进程重载后 /api 全部 401
- **密码存储**：scrypt 哈希（每用户独立盐），存于 DSH 凭据系统的 `${password}_USERS` 引用

## 多用户权限模型

- **普通用户只能使用会话功能。** 在 option A 下 `/api` 由原生 `connection`/`api-gateway` 持有并按 agent 键控；按用户隔离由两层组成：
  1. **桥墙方法门（已出厂强制，`apiBridgeAuth` 开启即生效）**——普通用户的 POST 分发只放行 `USER_ALLOWED` 白名单方法，白名单外直接拒绝（wire 正确的 forbidden envelope 或 403）；其 `session.list`/`session.search`/`workspace.list` 响应被收窄为仅含自己拥有的会话；
  2. **REMOTE 层守卫（组合后生效，defense-in-depth）**——`wrapRemoteGateway`（从本包导出）组合进 `typertGateway` 后，把普通用户限制为只能看到和操作**自己**的会话及其派生子会话（子代理/分叉——所有权沿 `parentSessionId` 传递），并按 `sessionId`/`workspaceId` 等字段校验分发参数所有权。其余一律禁止：
  - 物理层允许清单：面向用户的线方法面（`USER_ALLOWED`，DSH 0.2.1-rc.3 实际暴露的 146 个方法中的 92 个）——`session.*`（19 个：prompt/page/modelCatalog/selectModel/fork/attachment/…）、`workspace.*`（10 个）、`goals.*`、`subagents.*`、`terminal.*`（8 个）、`job.*`、只读 `workspaceFiles.*`/`officeToPdf.*` 文档预览、`llm.listProviders`/`llm.listConfigurableProviders`/`llm.discoverModels`（模型选择器与设置→模型）、`skills.list`、`commands.*`、`directoryPicker.*`（添加工作区目录）、`schedule.*`、`speech.*`、`userQuestions.*`、`messageFeedback.*`、`sessionFeedback.record`、`fileUploads.upload`、`fileReferences.list`、`permissionPresets.catalog`、`productAnalytics.*`、`cotTranslation.*`、`sessionReferenceResolver.candidates` 以及 `remoteAccess.follow` 授权流；其他任何线上方法都会被拒绝（桥墙方法门对普通用户强制；REMOTE 层守卫组合后在分发层拒绝同一集合）。清单对 wire 面是穷尽的：上游改名或新增方法而没分类时，`tests/wire-surface.spec.ts` 会失败（见 [`docs/adapt-dsh-0.2.1-rc.2-issue-4.md`](docs/adapt-dsh-0.2.1-rc.2-issue-4.md)）
  - 管理员专属域（`ADMIN_ONLY_METHODS`，53 个）：`credentials.*`、`settings.*`、`agentPresets.*`（预设的系统提示与插件组合）、原生插件管理器（`pluginManager.*`、`pluginMarket.*`、`pluginRegistryProbe.*`、`pluginInventory.*`）、`dynamicCordisRunner.*`（可在宿主执行任意代码）、`claudeCodeMods.*`，以及整个 `account.*` 命名空间（唯一的进程级上游 DeepSeek Platform 授权——登录/登出、资料/钱包投影、rc.2 的 `watchExpiry` 过期通知流）整体禁用
  - 宿主内部：`workspace.initializeDefault`（首次使用的内部管线，对用户拒绝且从不对外通告）
  - 未知方法（不在本版本 wire 面上）会在宿主日志里按方法名报一次并带上目标版本，于是上游改名留下的是诊断信息而不是用户侧的静默拒绝——用 `node scripts/dump-wire-surface.mjs` 从 checkout 重新生成 `src/api-filter.ts`
  - 工作区级变更按 `workspaceId` 所有权守卫：普通用户只能对「含自己会话」的工作区执行 `rename`/`delete`/`insertBefore`，`create` 只能落在自己的沙箱目录（`workspaceRoot/<username>`）内——既动不了他人的工作区，也不能把工作区指向任意宿主目录
  - 物理层 `session.export` 通道（目标在查询字符串中、不走信封）在通道层按所有权校验
  - 事件流（mux/host WebSocket 帧）：按用户的帧过滤由组合后的 REMOTE 层守卫提供（见其文档的流面覆盖）；升级本身仍由上游 Host/Origin + 浏览器鉴权围栏把关
- **默认用户工作空间（`defaultWorkspace`，默认开启）：** 非管理员首次经 `/api` 访问时，自动为其供给一个按用户名隔离的默认工作区——`mkdir` 其沙箱目录（`workspaceRoot/<username>`，默认 `<DSH_HOME>/workspaces/<username>`）→ 注册进 durable workspace registry → 附加一个会话（`sessions.create({ workspaceId })`，群组归属）并记入所有权索引，使工作区立即在 `session.list`/`workspace.follow` 对用户可见、可直接开聊。这让非管理员在公网/FRP 部署下不会一开始就没有工作区可用；自 0.3.6 起原生目录选择器（`directoryPicker.*`）对他也放行，而 `workspace.create` 仍被限制在其沙箱内。管理员可在「设置 → 用户管理」通过「默认用户工作空间」开关实时开/关（持久化于 `<dataDir>/settings.json`，即时生效，无需重启）；关闭不影响已存在的工作区。供给幂等（每用户每进程一次）、best-effort（失败不阻断请求）。
- **远程访问兼容（`remoteWebUiCompat`，默认开启）：** 不改动社区常用插件 `@linxin666/dsh-remote-web-ui`。该插件的 `/remote` 设备配对门槛会在非回环（公网 frp）访问时，对桌面端（模型对话框、历史、写作区）返回 401——这与 dsh-login 本身正常的 `/api` 鉴权无关。开启本项时，dsh-login 会把 remote-web-ui 的 `enabled` 写为 `true`（这正是让它挂载宿主路由 `/remote`、`/api/pair/*` 的关键；否则服务端什么都不响应，客户端会回落到死掉的 `/remote` 405 墙）并把 `requirePairingForLan` 写为 `false`（**实时、settings 驱动**、每次请求重读），使非回环访问走 dsh-login 用 `dsh_session` cookie 鉴权的 `/api` 通道；同时若配置了 `remoteWebUiPublicBaseUrl`，会一并写入 `publicBaseUrl`——公网 frp/隧道场景必须设置，否则 remote-web-ui 基于 Host 头的 `/api/pair/*` 围栏会拒绝公网来源（浏览器在 `/api/pair/status` 得到 403，客户端仍回落 `/remote`）。未安装 remote-web-ui 时本项无效果；管理员可在「设置 → 用户管理」的「远程访问兼容」开关实时开/关（持久化、即时生效）。注意：`remoteWebUiCompat` 默认开启意味着所有「dsh-login + remote-web-ui」部署的配对门槛都默认关闭——这是预期的，因为 dsh-login 自己的 `/api` 鉴权仍在其前面。
- **`/api` 桥鉴权墙（`apiBridgeAuth`，默认开启；DSH ≥ 0.1.6-alpha.2）：** 在上游的 `connection/request` 钩子上，dsh-login 对**未携带有效 `dsh_session` 的桥接 `/api` 请求直接回 401**——注销/过期/吊销会话后，即使浏览器仍持有 connection 行的进程级浏览器 cookie，也无法继续调用 `/api`。对已认证的普通用户，桥墙继续做方法级强制（见上文两层模型）并在请求/响应两侧保温所有权索引：记录经 `session.create`/`session.fork`/`workspace.create` 产生的新资源（含管理员创建——record-only，不限制管理员请求），过滤普通用户的 list 响应，并在需要时触发默认工作区供给。插件自有精确路由（`/api/auth/*`、remote-web-ui 的 `/api/pair/*` 配对）不经过桥，登录前照常可用；Remote 流 mux 的 WebSocket 升级仍由上游的 Host/Origin + 浏览器鉴权围栏把关（上游没有提供逐请求钩子）。仅当有无法携带 `dsh_session` cookie 的客户端需要直连桥时才关闭本项——例如 remote-web-ui 的 `/remote` 配对设备通道会在服务端重新发起请求且不带该 cookie（配对凭证在设计上就是绕开 dsh-login 用户模型的完全控制凭据）。DSH < 0.1.6-alpha.2 时该钩子不存在，本项是无害的空操作。
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

## `/api` 集成（option A，DSH ≥ 0.1.5-alpha.1）

DSH ≥ 0.1.5-alpha.1 下 dsh-login **不再接管 `/api` 通道**：`cordis.patch.yml` 让自带的 `connection` 行保持启用，`dsh-client-connection` + `api-remotes`/`api-gateway` 持有 `/api` 传输与实时 Remote 流。dsh-login 在这些原生栈之上组成自己的按用户层（详见 [`docs/adapt-dsh-0.1.5.md`](docs/adapt-dsh-0.1.5.md) 与验收清单 [`docs/verify-option-A.md`](docs/verify-option-A.md)）：登录墙占据 fallback 席位并通过原生 `serveStatic` 提供静态服务，同时在对 index 响应时调用 `connection.authorizeIndex`，让浏览器拿到上游 `/api` cookie。旧的 `src/connection.ts` 通道接管及其基于 `dsh-host-apiproxy` 的按用户 `ApiProxy` 已被移除；它提供的按用户会话/工作区隔离已改为 **REMOTE 层的守卫**（`wrapRemoteGateway` + `createRemoteIsolation`，从宿主 bundle 导出、已通过单元/集成测试），由部署在启动时使用随附胶水组合进原生 `typertGateway`（dsh-login 把所有权 sidecar 发布为 `dshLoginOwnership` 服务；`composeDshLoginGuard` / [`docs/compose-guard.md`](docs/compose-guard.md)）。**该组合的两浏览器行为验收仍是需要真实 boot 才能完成的一步**（详见 `docs/verify-option-A.md` §B）。

**主机信任按请求实时求值。** 围栏不再用静态列表，而是一组去重后的「有效集」——web runtime 的 LAN 字面量 + `trustedHosts` + 持久化白名单（`src/hosts.ts`）。每次成功登录/setup 都会自动学习请求 Host（受 `autoTrustHosts` 控制，默认开启），因此经 frp/隧道访问的公网主机**登录一次即被信任**；已学习的主机立即生效、删除后无需重启即失效。

客户端侧，本包自带一个独立的 `dsh.client`（`dist/client.js`，由 `scripts/build-client.mjs` 生成）：一个 `__ModuleLoader__.load({ id:"@islibaodong/dsh-login", factory })` 注册，应用 `src/settings-panel.client.js` 并注册「设置 → 用户管理/账户」分区（样式走框架 `--dsw-alias-*` 主题令牌；`dsh.client.inject` 列举 `@deepseek-ai/dsh-client-ui-settings`、`@deepseek-ai/dsh-client-locale`）。不再重打上游 connection 客户端。重新生成：

```bash
npm run build:client   # node scripts/build-client.mjs
```

## 安全说明

### 网关保护范围

| 资产 | 保护方式 |
|------|----------|
| 页面导航 (`/`) | 未认证时 302 重定向到 `/login` |
| 静态资源 (`/assets/*.js`、`.css` 等) | 同样的网关检查 |
| SPA 路由 (`/conversations`、`/settings` 等) | 同样的网关检查 |

### 桥墙保护范围

| 资产 | 保护方式 |
|------|----------|
| API 请求 (`/api/*`) | `isTrustedApiRequest` 主机信任检查 **加上** 有效 `dsh_session` Cookie（缺失则 401）；普通用户白名单外 POST 方法被拒（`quietDenials` 时回 wire 正确的 forbidden envelope，否则 403）；`session.list`/`session.search`/`workspace.list` 响应收窄为拥有的会话 |
| WebSocket (`/api/events.mux`、`/api/events.host`) | 升级时主机信任 + 浏览器鉴权检查（上游围栏——该处无逐请求钩子）；按用户帧过滤由组合后的 REMOTE 层守卫提供，不在升级围栏内 |

### 公网暴露建议

1. 开启 `autoTrustHosts`（默认）时，任何成功登录都会把请求 Host 学进白名单（`/api/auth/admin/hosts`，可在「设置 → 用户管理」管理），于是 frp/隧道主机登录一次即被信任，无需手改 `trustedHosts`。如需只接受回环 + 显式 `trustedHosts`，把它设为 `false`
2. 在 DSH 前部署反向代理（nginx/caddy）进行 TLS 终结
3. 网关 Cookie 为 `SameSite=Strict`，可防止针对登录/登出端点的 CSRF 攻击

**排障：公网普通用户"无法添加工作区"？**

定位经验（供快速排查）：这类问题几乎**不是** Host 白名单（`autoTrustHosts` 已自动学习、登录也能通）。在 **≤ 0.3.5** 上，真正的原因是方法门：前端"添加工作区"调用目录选择器，而 0.3.5 的 `USER_ALLOWED` 里存的是 0.2 之前的旧拼写（`host.pickDirectory` 等），于是普通用户被拒为 `not permitted for this user` / `HTTP 403`。**0.3.6 正是修这个**（issue #4）：真名是 `directoryPicker.pick`/`list`/`createDirectory`，已对普通用户放行。

- 放开选择器是安全的，因为权限边界在下一跳：`workspace.create` 被限制在调用者沙箱（`workspaceRoot/<username>`）内，普通用户无法把工作区注册到沙箱之外。而且普通用户本就能通过 `terminal.*` 以宿主用户身份跑 shell，浏览宿主目录不新增能力类别。
- `defaultWorkspace`（默认开）仍会给每个非管理员在首次 `/api` 访问时备好隔离沙箱，所以并不**必须**用选择器——但现在原生流程也能用了。
- 若 0.3.7+ 仍返回 `not permitted for this user`，说明该方法不在本版本 wire 面上：看宿主日志里每个方法只报一次的 `dsh-login: /api/<method> was denied …`（其中带目标 DSH 版本），再用 `node scripts/dump-wire-surface.mjs` 重新同步。

## 架构说明：fallback vs prefix /

网关使用 `registerFallback()` 而非 `register({ kind: 'prefix', path: '/' })`，因为 DSH WebServer 的前缀匹配逻辑检查 `pathname.startsWith(prefix + '/')`。当 prefix 为 `/` 时，拼接结果为 `//`，而正常路径不会以 `//` 开头——所以 `prefix /` 路由只能精确匹配 `/` 这一个路径。fallback 处理器能捕获所有未被命名路由匹配的请求，这才是认证网关所需的 catch-all 行为。

WebServer 只有一个 fallback 席位。dsh-web-app 的 `web-runtime` 行会无条件挂载 frontend-static 占据它，因此使用 `dsh-login` 时必须禁用 `web-runtime` 行；dsh-login 会重新提供它负责的 `webRuntime` 服务（LAN 信任、`DSH_WEB_URL`），组合其余部分不受影响。

## 运行测试

```bash
# 标准全量测试（247 项；option A 下在 DSH 0.1.5-alpha.1 至 0.2.1-alpha.2 上全绿——
# 设置 DSH_HARNESS_CHECKOUT，或在默认路径旁运行）
npx vitest run
```

`.spec.ts` 文件是标准的 vitest 测试定义，含纯逻辑/多用户相关套件（`users`、`ownership`、`hosts`、`session`、`gateway`、`admin-api`、`capabilities`、`remote-guard`、`remote-web-ui-compat`、`client-bundle`、`settings-panel`、`plugin-entry`、`bridge-list-filter` 等）。`connection`/`api-filter`/`multiuser-e2e` 三个 spec 已在 option A 适配时移除（它们测试的是已删除的 `dsh-host-apiproxy` `/api` 接管）；`remote-guard.spec.ts` 覆盖了 REMOTE 层隔离守卫（含所有权收窄与管理员放行），桥墙（401 + 方法门 + 静默拒绝 + record/filter tee + 供给触发）由 `tests/api-bridge-auth.spec.ts` 覆盖。`tests/runner.mjs` 和 `tests/integration-runner.mjs` 是针对原单密码核心的沙箱兼容运行器，未随多用户功能扩展。

## 项目结构

```
src/
├── index.ts          # Cordis 插件入口：注册鉴权路由、fallback 登录墙、webRuntime
├── config.ts         # schemastery 配置 schema（password、distIndex、dataDir、sessionTtl 等）
├── users.ts          # UserStore：用户记录、scrypt 哈希、凭据系统持久化
├── session.ts        # SessionStore：会话（用户 + 管理员标记）+ TTL 过期，跨重启持久化
├── ownership.ts      # OwnershipIndex: sessionId → 用户名索引（去抖写 JSON 文件）
├── hosts.ts          # TrustedHosts: 信任主机白名单（去抖 JSON 持久化）
├── api-filter.ts     # 纯谓词（AuthUser/USER_ALLOWED/isUserAllowed）
├── bridge-list-filter.ts  # wire 响应观察：owned 会话闭包 + session/workspace.list 收窄（供桥墙使用）
├── host-session-access.ts  # 惰性宿主侧会话面（sessionController 优先、typertGateway 兜底），供供给/列表探针
├── provision.ts      # DefaultWorkspaceProvisioner：按用户沙箱 + registry 工作区 + 种子会话
├── glue.ts           # 部署侧组合胶水（dshLoginOwnership 服务 + composeDshLoginGuard），见 docs/compose-guard.md
├── api-bridge-auth.ts  # 共享 /api 桥墙：401 + 方法门 + 静默拒绝 + 响应观察 tee
├── remote-guard.ts   # option A 隔离：typertGateway RBAC 守卫 + createRemoteIsolation 胶水
├── settings-panel.client.js  # 设置面板浏览器半边（纯 JS）：用户管理/账户分区，主题令牌样式
├── workspace-setting.ts  # 默认用户工作空间 runtime 开关（继承 BooleanSetting）
├── boolean-setting.ts  # live + 持久化的 {enabled} 运行时开关，被各管理开关复用
├── remote-web-ui-compat.ts  # 写入 remote-web-ui 的 enabled+requirePairingForLan+publicBaseUrl（settings 驱动、实时）
├── capabilities.ts  # 能力发现（deriveCapabilities）+ 读探针分类（isReadProbe）
├── admin-api.ts      # /api/auth/me + /api/auth/admin/* JSON 路由（设置面板后端）
├── auth.ts           # Cookie 管理 + 常量时间比较工具
├── gateway.ts        # 认证网关 fallback（登录墙 + serveStatic + 上游 connection.authorizeIndex）
├── login-api.ts      # POST /api/auth/login + logout + setup
├── login-page.ts     # 登录页与设置页 HTML
├── http-json.ts      # readBody/sendJson 工具 + resolveDshHome
└── web-runtime.ts    # webRuntime 接管：LAN 信任 + DSH_WEB_URL
dist/client.js        # 构建产物浏览器 bundle（npm run build:client）
scripts/build-client.mjs  # 生成 dist/client.js：设置面板 dsh.client 注册
tests/（option A 套件：19 文件 / 247 用例全绿——详见 docs/verify-option-A.md）
└── *.spec.ts         # vitest 测试定义

## 许可证

MIT
