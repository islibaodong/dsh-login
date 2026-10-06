# 组合 REMOTE 层隔离守卫（部署侧，option A/B）

> 面向部署方的一页文档：把 dsh-login 的按用户 REMOTE 层守卫组合进原生 `typertGateway`。
> 这是 0.3.0 交付的部署胶水的使用说明 + 验收清单。代码见 `src/glue.ts`（从宿主 bundle 导出），
> 守卫本体见 `src/remote-guard.ts`，背景与验收矩阵见 [`docs/verify-option-A.md`](./verify-option-A.md) §B。

## 为什么需要这一步

DSH ≥ 0.1.5（option A）下 `/api` 传输归原生 `connection` + `api-remotes`/`api-gateway` 持有，
dsh-login 不再接管 `/api`。此时按用户隔离分两层：

1. **桥墙（出厂即生效）**：`apiBridgeAuth` 在上游 `connection/request` 钩子上做 401 认证、
   普通用户 `USER_ALLOWED` 方法门、`session.list`/`session.search`/`workspace.list` 响应收窄、
   所有权记录与默认工作区供给。
2. **REMOTE 层守卫（本页要组合的）**：在 `typertGateway` 分发层按所有权校验每个请求的
   `sessionId`/`workspaceId` 等字段——这是 defense-in-depth 的最后一道闸，桥墙覆盖不到的
   分发路径（例如未来绕过桥的内部调用）由它兜底。

**dsh-login 不能自己替换 `typertGateway`**：该服务由宿主核心行 provide，第二次 provide 同键
服务是 duplicate-service 错误。所以组合是**启动期、部署侧**动作——按 `cordis.patch.yml` 换行
的同一方式，fork 部署的 `typertGateway` 行，在 connection 行绑定前把原生网关包进守卫。

## 前置条件

- `@islibaodong/dsh-login@>=0.3.0` 已安装并启用（`apiBridgeAuth: true`，默认）。
- dsh-login 已把所有权 sidecar 发布为 `dshLoginOwnership` 服务（0.3.0 起，`src/index.ts` 接线）。
- 组合行声明 `inject`（或等效的行排序机制）使其**晚于** dsh-login 行运行，否则
  `getDshLoginOwnership(ctx)` 拿不到 sidecar（`composeDshLoginGuard` 会原样返回未包装网关——
  见下方「返回未包装网关」一节）。

## 最小组合行模块

在部署 profile 的插件目录放一个普通 cordis 行模块（示例 `dsh-login-guard-row.mjs`），
然后在 `cordis.patch.yml` 中用它替换/包裹原生 `typertGateway` 行的 provide——具体挂载点
取决于部署的 patch 结构：核心思路是**让该模块在原生 gateway 可用后、connection 行消费前，
把 `ctx.typertGateway`（或行内局部网关）替换为包装后的版本**。

```js
// dsh-login-guard-row.mjs
// composeDshLoginGuard 等胶水从宿主 bundle（包主入口 dist/index.js）导出
import { composeDshLoginGuard } from '@islibaodong/dsh-login'

export function apply(ctx) {
  ctx.effect(() => {
    const native = ctx.get('typertGateway')          // 原生网关（connection 行的依赖）
    const guarded = composeDshLoginGuard(ctx, native) // 包装为守卫网关
    // 以守卫网关 provide 供 connection 行消费（键与部署的行结构一致）
    ctx.provide('typertGateway', guarded)
  }, { inject: ['dshLoginOwnership'] })
}
```

> 若部署不想整键替换，可用两步等价写法：`getDshLoginOwnership(ctx)` 取 sidecar →
> `createDshLoginIsolation({ ownership, currentSessionId })` 构造隔离对 →
> `composeGuardedGateway(native, isolation)` 包装。三个导出的完整签名见下。

## API 参考（全部从宿主 bundle 导出）

### `DSH_LOGIN_OWNERSHIP_SERVICE = 'dshLoginOwnership'`

dsh-login 发布所有权 sidecar 的 cordis 服务键。组合行应把它写进 `inject` 以排序。

### `getDshLoginOwnership(ctx): OwnershipIndex | undefined`

惰性读取 dsh-login 发布的 live sidecar（`ownership.json` 的内存实例，桥墙持续写入）。
dsh-login 缺席/禁用时返回 `undefined`。

### `createDshLoginIsolation(deps): { resolveUser, owns }`

构造守卫的隔离对：

- `deps.ownership: OwnershipIndex`（必填）——建议注入 `dshLoginOwnership` 服务的实例。
- `deps.currentSessionId?: () => string | undefined` ——解析发起当前分发的 agent 会话 id
  （例如 `() => ctx.agents?.currentInitiator?.()?.id`）。**省略时守卫只依赖 sidecar 解析，
  而无 initiator 的解析必然失败（undefined → 拒绝）**；任何非平凡用途都需要它。
- `deps.isAdmin?: (username: string) => boolean` ——可选的按用户名管理员判定。管理员会话
  也被桥墙记入 sidecar，守卫解析到 admin 用户即放行；此项只影响在 sidecar 之外解析用户的部署。

`resolveUser` 链路：`currentSessionId()` → `ownership.lookup(sid)` → 用户名（查不到 → undefined 拒绝，
fail-closed）。`owns(id)`：管理员恒真；否则 `lookup(id) === resolveUser()`。

### `composeGuardedGateway(gateway, isolation): WrappedRemoteGateway`

`wrapRemoteGateway(gateway, resolveUser, owns)` 的直接转发：包装原生网关为守卫网关——
`invoke`/`stream` 走守卫（admin 直通 → `ADMIN_ONLY_NAMESPACES` 拒绝 → `USER_ALLOWED` 白名单 →
参数 id 字段所有权校验），**其余全部网关成员原样转发**（含 DSH 0.2.0-rc.2 起必需的
`hasLiveClient()`）。

### `composeDshLoginGuard(ctx, gateway): WrappedRemoteGateway`

一键便捷组合：`getDshLoginOwnership(ctx)` → `createDshLoginIsolation`（currentSessionId 取
`ctx.agents.currentInitiator().id`）→ `composeGuardedGateway`。
**dsh-login 未发布 sidecar 时原样返回未包装网关**——没有 dsh-login 的组合就是单管理员部署，
不需要守卫。

### 拒绝行为

守卫拒绝抛 `Error("dsh-login: forbidden: <namespace>.<method>", { code: 'forbidden' })`，
上游网关把它折叠为 wire 正确的错误 envelope——浏览器侧表现为对应操作的常规失败，不是崩溃。

## 验收清单（两浏览器，boot 后一次）

部署侧完成组合后，用**两个浏览器**（或普通窗口 + 隐身窗口）做一次行为签收：

| # | 场景 | 期望 |
|---|------|------|
| 1 | 用户 A 登录，看会话列表 | 只看到自己的会话（含自己派生的子代理/分叉） |
| 2 | 用户 B 在地址栏/接口直接按 id 打开 A 的会话 | 拒绝（forbidden），内容不可见 |
| 3 | 用户 B 对 A 的会话发消息/fork/取消 | 拒绝（forbidden） |
| 4 | 用户 A 对自己的工作区 rename/pin | 正常 |
| 5 | 用户 B 对 A 的工作区 rename/delete | 拒绝（forbidden） |
| 6 | 管理员登录 | 全部会话/工作区可见可操作，无限制 |
| 7 | 用户调用管理员方法（如 `credentials.list`） | 拒绝（桥墙已拦；守卫同判） |
| 8 | 登出后刷新 | 302 到 `/login`，无数据残留 |

补充检查：`<dataDir>/ownership.json` 中能看到两个用户的 session→username 记录
（桥墙 record tee 写入；管理员的创建也记录——record-only）。

## 排障

- **启动报 duplicate service（`typertGateway`）** ——组合行 provide 了原生行仍在的键。
  改为 fork/禁用原生 `typertGateway` 行、由组合行独占 provide，或在行内包裹而非重复 provide
  （以部署的 patch 结构为准）。
- **普通用户合法操作全被拒** ——守卫 fail-closed：sidecar 无法归属的会话一律拒绝。
  检查 `inject` 是否含 `dshLoginOwnership`（排序太早会拿到 undefined → 未包装或全拒）、
  `currentSessionId` 是否真的解析到 initiator 会话 id；dsh-login 组合之前已存在的旧会话
  不在 sidecar 里，需重建或回填 `ownership.json`（`{ "sessionId": "username", ... }`）。
- **守卫似乎没生效（跨用户可见）** ——`composeDshLoginGuard` 在 sidecar 缺失时**原样返回
  未包装网关**（单管理员语义）。若 dsh-login 已装但仍未包装，确认服务键为
  `dshLoginOwnership`（0.3.0+）、组合行晚于 dsh-login 运行，以及 connection 行消费的是
  包装后的网关实例。
- **升级 DSH 后守卫接口不完整** ——`wrapRemoteGateway` 只覆写 `invoke`/`stream` 并转发其余
  成员；若上游给网关新增了**分发语义**的方法（历史上没有），需要同步扩展 `src/remote-guard.ts`
  的覆写面。
