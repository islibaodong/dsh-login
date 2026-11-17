/**
 * dsh-login settings-panel client half — plain browser JavaScript.
 *
 * This file is NOT transformed: scripts/build-client.mjs wraps it verbatim
 * into dist/client.js as the plugin's dsh.client registration (a module-loader
 * factory closure). Under option A (DSH ≥ 0.1.5-alpha.1) the plugin does NOT
 * provide the `connection` service — the shipped `connection` row owns /api —
 * so this half is a standalone settings-section contribution over the native
 * `slots` + `locale`: it registers 用户管理 for admins (user table +
 * create/reset/disable/remove + logout) or 账户 for ordinary users (identity +
 * logout).
 *
 * All styling runs through the framework's `--dsw-alias-*` theme tokens, so
 * the panel follows the app skin (light/dark) automatically. React and the
 * UI primitives come from the platform module-table seeds every bundle may
 * require; no cross-plugin value imports and no hard inject that could
 * deadlock (this fiber depends only on `slots`/`locale`, resolved by
 * ctx.inject when they exist).
 */
function (require) {
  var React = require('react')
  var useState = React.useState
  var useEffect = React.useEffect
  var useCallback = React.useCallback
  var h = React.createElement
  var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
  var Button = primitives.Button
  var Input = primitives.Input
  var Modal = primitives.Modal
  var RiskConfirmation = primitives.RiskConfirmation

  // ---- styles (settings-panel design language: 14/22 body, 12/18 caption,
  // 12px-radius outlined cards, --dsw-alias-border-l2 hairlines) ----
  var CSS = `
.dshlu-section { display: flex; flex-direction: column; gap: 12px; max-width: 720px; color: var(--dsw-alias-label-primary); }
.dshlu-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dshlu-intro { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }
.dshlu-notice { margin: 0; font-size: 12px; line-height: 18px; min-height: 18px; }
.dshlu-notice--error { color: var(--dsw-alias-state-error-primary); }
.dshlu-notice--success { color: var(--dsw-alias-state-success-primary); }
/* ONE shared grid for the whole table: .dshlu-table owns the columns and
   the header/rows are subgrids spanning all of them, so every track —
   including the content-sized 状态/操作 ones — resolves once for the whole
   table. (Per-row grids were the bug: max-content tracks sized to each
   container's own content, so the narrow header labels got ~30px tracks
   while the rows' buttons got ~250px — header and body fully misaligned.)
   Head and row share identical side insets (14px padding + 1px border)
   so the subgrid tracks also start at the same origin pixel. */
.dshlu-table { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) max-content max-content; column-gap: 8px; row-gap: 8px; align-items: center; margin: 4px 0 0; }
.dshlu-head, .dshlu-row { display: grid; grid-template-columns: subgrid; grid-column: 1 / -1; align-items: center; }
.dshlu-head { padding: 0 14px; border: 1px solid transparent; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); }
.dshlu-head > :last-child { text-align: right; }
.dshlu-row { padding: 8px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; }
.dshlu-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshlu-row--disabled .dshlu-name { color: var(--dsw-alias-label-tertiary); }
.dshlu-name { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; min-width: 0; font-size: 14px; line-height: 22px; font-weight: 500; overflow-wrap: anywhere; }
.dshlu-cell { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary); }
.dshlu-cell--login { min-width: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshlu-cell--status { display: flex; align-items: center; flex-wrap: nowrap; gap: 4px; }
.dshlu-cell--actions { display: flex; flex-wrap: nowrap; gap: 6px; justify-content: flex-end; white-space: nowrap; }
/* Narrow viewports drop the last-login column (header cell + row cells)
   instead of squeezing; subgridded rows follow the parent template. */
@media (max-width: 620px) {
  .dshlu-table { grid-template-columns: minmax(0, 1fr) max-content max-content; }
  .dshlu-head > :nth-child(2), .dshlu-row > .dshlu-cell--login { display: none; }
}
.dshlu-badge { flex: none; padding: 1px 6px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 4px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }
.dshlu-badge--muted { color: var(--dsw-alias-label-caption); }
.dshlu-badge--admin { border-color: transparent; background: var(--dsw-alias-fill-tsp-secondary); color: var(--dsw-alias-label-secondary); }
.dshlu-badge--online { border-color: transparent; color: var(--dsw-alias-state-success-primary); }
.dshlu-badge--disabled { border-color: transparent; color: var(--dsw-alias-state-warn-label); }
.dshlu-danger { color: var(--dsw-alias-state-error-primary); }
.dshlu-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.dshlu-card h3 { margin: 0; font-size: 14px; line-height: 22px; font-weight: 500; }
.dshlu-fields { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dshlu-fields > :first-child { flex: 1 1 140px; }
.dshlu-fields > :nth-child(2) { flex: 1 1 140px; }
.dshlu-check { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dshlu-account { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dshlu-account-id { display: inline-flex; align-items: baseline; gap: 8px; min-width: 0; }
.dshlu-account-name { font-size: 14px; line-height: 22px; font-weight: 500; overflow-wrap: anywhere; }
.dshlu-account-role { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); }
.dshlu-empty { padding: 8px 14px; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }
.dshlu-loading { padding: 8px 14px; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }
.dshlu-dialog-fields { display: flex; flex-direction: column; gap: 10px; }
.dshlu-dialog-desc { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary); }
.dshlu-hostlist { display: flex; flex-direction: column; gap: 8px; }
.dshlu-hostrow { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; }
.dshlu-hostrow code { font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dshlu-switchrow { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dshlu-switchtext { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dshlu-switchlabel { font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dshlu-switchdesc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dshlu-switch { position: relative; display: inline-flex; flex: none; width: 40px; height: 24px; margin-top: 0; cursor: pointer; }
.dshlu-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.dshlu-switch-track { position: absolute; inset: 0; border-radius: 12px; background: var(--dsw-alias-fill-tsp-secondary); border: 1px solid var(--dsw-alias-border-l3); transition: background 120ms ease; }
.dshlu-switch-knob { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: var(--dsw-alias-label-secondary); transition: transform 120ms ease, background 120ms ease; }
.dshlu-switch input:checked + .dshlu-switch-track { background: var(--dsw-alias-state-success-primary); border-color: transparent; }
.dshlu-switch input:checked + .dshlu-switch-track + .dshlu-switch-knob,
.dshlu-switch input:checked ~ .dshlu-switch-knob { transform: translateX(16px); }
.dshlu-switch input:focus-visible + .dshlu-switch-track { outline: 2px solid var(--dsw-alias-border-interactive); outline-offset: 1px; }
.dshlu-switch input:disabled + .dshlu-switch-track { opacity: 0.5; }
.dshlu-switch-status { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); }

/* ---- main-panel page (用户管理 opened as a full panel from the sidebar) ----
   The settings section above stays a compact 720px stack (it lives in the
   settings column). The main panel is a whole page, so it gets its own
   centred column with viewport-scaled page insets, section blocks, stat tiles
   and a card grid — otherwise a 720px list pinned to the left edge of a wide
   main area is exactly the "ugly" state this replaces. */
.dshlu-page { display: flex; flex-direction: column; align-items: center; box-sizing: border-box; width: 100%; min-height: 100%; padding: 0 clamp(16px, 3vw, 36px); color: var(--dsw-alias-label-primary); }
.dshlu-pagecol { display: flex; flex-direction: column; gap: 20px; box-sizing: border-box; width: 100%; max-width: 1040px; padding: 30px 0 44px; }
.dshlu-hero { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dshlu-heroTitle { margin: 0; font-size: 22px; line-height: 30px; font-weight: 600; letter-spacing: -0.01em; }
.dshlu-heroLede { margin: 0; max-width: 680px; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-tertiary); }
.dshlu-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.dshlu-stat { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; background: var(--dsw-alias-card-fill); }
.dshlu-statValue { font-size: 22px; line-height: 30px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.dshlu-statLabel { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); }
.dshlu-stat--success .dshlu-statValue { color: var(--dsw-alias-state-success-primary); }
.dshlu-stat--warn .dshlu-statValue { color: var(--dsw-alias-state-warn-primary); }
.dshlu-stat--muted .dshlu-statValue { color: var(--dsw-alias-label-caption); }
.dshlu-block { display: flex; flex-direction: column; gap: 8px; padding: 16px 18px 18px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px; background: var(--dsw-alias-card-fill); }
.dshlu-blockHead { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.dshlu-blockTitle { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; }
.dshlu-blockNote { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); }
/* Setting ROWS live inside one block in the main panel (a card per switch
   left three short boxes separated by holes); hairlines separate the rows. */
.dshlu-block--rows { gap: 0; }
.dshlu-block--rows .dshlu-blockHead { padding-bottom: 10px; }
.dshlu-settingrow { padding-top: 14px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dshlu-blockHead + .dshlu-settingrow { padding-top: 0; border-top: 0; }
.dshlu-avatar { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 50%; background: var(--dsw-alias-interactive-bg-hover); font-size: 11px; line-height: 1; font-weight: 600; color: var(--dsw-alias-label-secondary); text-transform: uppercase; }
@media (max-width: 720px) {
  .dshlu-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dshlu-pagecol { padding: 20px 0 32px; }
}
/* Main-page rhythm: rows get more breathing room and empty/loading states
   centre instead of hugging the left edge; block intros shrink to caption
   scale so a block's title stays the dominant line. */
.dshlu-pagecol .dshlu-row { padding: 10px 14px; }
.dshlu-pagecol .dshlu-block .dshlu-intro { font-size: 12px; line-height: 18px; }
.dshlu-pagecol .dshlu-empty, .dshlu-pagecol .dshlu-loading { padding: 24px 14px; text-align: center; }
/* Inside the account block the table reads as a table: one header hairline
   and row separators, instead of a boxed card inside a boxed block. */
.dshlu-pagecol .dshlu-table .dshlu-head { padding-bottom: 8px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dshlu-pagecol .dshlu-table .dshlu-row { border: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); border-radius: 0; }
.dshlu-pagecol .dshlu-table .dshlu-row:last-child { border-bottom: 0; }
/* Form fields do not need to stretch across a 1040px block. */
.dshlu-pagecol .dshlu-fields > :first-child, .dshlu-pagecol .dshlu-fields > :nth-child(2) { flex: 0 1 240px; }
`

  // ---- locale dictionaries ----
  var NS = 'dsh-login'
  var zh = {
    'users.nav': '用户管理',
    'users.title': '用户管理',
    'users.intro': '管理本部署的登录账户：新建用户、重置密码、禁用或删除。禁用用户的现有会话会被立即吊销。',
    'account.nav': '账户',
    'account.title': '账户',
    'account.intro': '当前登录的身份。修改密码或账户问题请联系管理员。',
    'account.logout': '退出登录',
    'col.username': '用户名',
    'col.lastLogin': '最后登录',
    'col.status': '状态',
    'col.actions': '操作',
    'stats.accounts': '账户总数',
    'stats.online': '在线',
    'stats.disabled': '已禁用',
    'table.title': '账户列表',
    'table.count': '共 {n} 个',
    'access.title': '登录与访问',
    'status.never': '从未登录',
    'role.admin': '管理员',
    'role.user': '用户',
    'status.online': '在线 ×{n}',
    'status.offline': '离线',
    'status.disabled': '已禁用',
    'action.resetPassword': '重置密码',
    'action.disable': '禁用',
    'action.enable': '启用',
    'action.remove': '删除',
    'create.title': '新建用户',
    'create.username': '用户名',
    'create.password': '密码',
    'create.admin': '管理员',
    'create.submit': '创建',
    'dialog.resetTitle': '重置密码',
    'dialog.resetDesc': '为 {username} 设置新密码。重置后该用户的现有会话将被吊销，需要重新登录。',
    'dialog.newPassword': '新密码',
    'dialog.disableTitle': '禁用用户',
    'dialog.disableDesc': '禁用后 {username} 将无法登录，现有会话立即失效；可随时重新启用。',
    'dialog.disableSelf': '注意：这会禁用你自己的账户，确认后你将立即退出登录。',
    'dialog.removeTitle': '删除用户',
    'dialog.removeDesc': '删除 {username} 及其全部账户数据。该操作不可撤销。',
    'dialog.removeAck': '我确认永久删除该用户',
    'dialog.confirm': '确认',
    'dialog.cancel': '取消',
    'error.loadFailed': '加载用户列表失败',
    'hosts.title': '访问白名单 / Trusted Hosts',
    'hosts.intro': '允许访问 /api 的主机（除本机回环）。公网通过 frp/隧道登录成功后会自动加入；可在此手动添加或移除。删除后立即生效。',
    'hosts.empty': '暂无信任的主机',
    'hosts.placeholder': 'host 或 host:port',
    'hosts.add': '添加',
    'hosts.remove': '移除',
    'hosts.removed': '已移除',
    'hosts.added': '已添加',
    'hosts.addFailed': '添加失败',
    'hosts.removeFailed': '移除失败',
    'ws.title': '默认用户工作空间',
    'ws.intro': '开启后，每个普通用户首次访问时自动得到专属工作空间（含一个起步会话），无需手动选择宿主目录。关闭不影响已存在的用户工作空间。',
    'ws.on': '已开启',
    'ws.off': '已关闭',
    'ws.toggleFailed': '切换失败',
    'rwu.title': '远程访问兼容（remote-web-ui）',
    'rwu.intro': '开启后会把 remote-web-ui 的宿主路由打开（enabled:true）、关闭设备配对门槛（requirePairingForLan:false），并在配置了 remoteWebUiPublicBaseUrl 时一并写入，让通过公网 frp/隧道访问的桌面端（模型对话框、历史、写作区）走 dsh-login 的 /api 通道，由 dsh_session 登录态鉴权。未安装该插件时此项无效果。',
    'rwu.on': '已开启',
    'rwu.off': '已关闭',
    'rwu.applied': '已生效于 remote-web-ui',
    'rwu.unregistered': '未检测到 remote-web-ui',
    'rwu.toggleFailed': '切换失败',
    'sidebar.title': '侧边栏显示',
    'sidebar.intro': '开启后，主页面左侧边栏显示「用户管理」入口；关闭后隐藏。',
    'sidebar.hidden': '「用户管理」当前已从左侧边栏隐藏，重新开启即可恢复显示。',
    'sidebar.on': '已显示',
    'sidebar.off': '已隐藏',
    'sidebar.toggleFailed': '切换失败',
  }
  var en = {
    'users.nav': 'Users',
    'users.title': 'User management',
    'users.intro': 'Manage this deployment\'s login accounts: create users, reset passwords, disable or remove them. Disabling a user revokes their live sessions immediately.',
    'account.nav': 'Account',
    'account.title': 'Account',
    'account.intro': 'Your signed-in identity. Contact an administrator for password or account issues.',
    'account.logout': 'Log out',
    'col.username': 'Username',
    'col.lastLogin': 'Last login',
    'col.status': 'Status',
    'col.actions': 'Actions',
    'stats.accounts': 'Accounts',
    'stats.online': 'Online',
    'stats.disabled': 'Disabled',
    'table.title': 'Accounts',
    'table.count': '{n} total',
    'access.title': 'Sign-in & access',
    'status.never': 'never',
    'role.admin': 'admin',
    'role.user': 'user',
    'status.online': 'online ×{n}',
    'status.offline': 'offline',
    'status.disabled': 'disabled',
    'action.resetPassword': 'Reset password',
    'action.disable': 'Disable',
    'action.enable': 'Enable',
    'action.remove': 'Remove',
    'create.title': 'Create user',
    'create.username': 'Username',
    'create.password': 'Password',
    'create.admin': 'Administrator',
    'create.submit': 'Create',
    'dialog.resetTitle': 'Reset password',
    'dialog.resetDesc': 'Set a new password for {username}. Their live sessions are revoked and they must sign in again.',
    'dialog.newPassword': 'New password',
    'dialog.disableTitle': 'Disable user',
    'dialog.disableDesc': '{username} will not be able to sign in and their live sessions end immediately; they can be re-enabled at any time.',
    'dialog.disableSelf': 'Note: this disables your own account — you will be signed out immediately.',
    'dialog.removeTitle': 'Remove user',
    'dialog.removeDesc': 'Remove {username} and all their account data. This cannot be undone.',
    'dialog.removeAck': 'I confirm permanently removing this user',
    'dialog.confirm': 'Confirm',
    'dialog.cancel': 'Cancel',
    'error.loadFailed': 'Failed to load users',
    'hosts.title': 'Allowed hosts / Trusted Hosts',
    'hosts.intro': 'Hosts allowed to reach /api (besides loopback). Public hosts learned after a successful login via frp/tunnel appear here automatically; manage them manually here. Removals take effect immediately.',
    'hosts.empty': 'No trusted hosts yet',
    'hosts.placeholder': 'host or host:port',
    'hosts.add': 'Add',
    'hosts.remove': 'Remove',
    'hosts.removed': 'Removed',
    'hosts.added': 'Added',
    'hosts.addFailed': 'Failed to add',
    'hosts.removeFailed': 'Failed to remove',
    'ws.title': 'Default user workspace',
    'ws.intro': 'When enabled, every non-admin user gets an automatic private workspace (with a starter session) on first access, without manually choosing a host directory. Turning it off does not affect existing user workspaces.',
    'ws.on': 'Enabled',
    'ws.off': 'Disabled',
    'ws.toggleFailed': 'Failed to toggle',
    'rwu.title': 'Remote access compat (remote-web-ui)',
    'rwu.intro': 'When enabled, mounts remote-web-ui\'s host routing (enabled:true) with the device-pairing gate off (requirePairingForLan:false), and writes remoteWebUiPublicBaseUrl when configured, so desktop clients reaching via public frp/tunnel (model dialog, history, composer) ride dsh-login\'s /api channel gated by the dsh_session login cookie. No effect when remote-web-ui is not installed.',
    'rwu.on': 'Enabled',
    'rwu.off': 'Disabled',
    'rwu.applied': 'Applied to remote-web-ui',
    'rwu.unregistered': 'remote-web-ui not detected',
    'rwu.toggleFailed': 'Failed to toggle',
    'sidebar.title': 'Show in sidebar',
    'sidebar.intro': 'When enabled, the app sidebar shows a User management entry; when disabled it is hidden.',
    'sidebar.hidden': 'User management is currently hidden from the app sidebar. Turn this back on to restore it.',
    'sidebar.on': 'Visible',
    'sidebar.off': 'Hidden',
    'sidebar.toggleFailed': 'Failed to toggle',
  }

  // ---- same-origin admin API helpers ----
  async function api(path, method, body) {
    var init = { method: method }
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    var res = await fetch(path, init)
    var text = await res.text()
    var data = null
    try { data = text.length > 0 ? JSON.parse(text) : null } catch (err) { /* not JSON */ }
    if (!res.ok) {
      var detail = data !== null && typeof data.error === 'string' && data.error.length > 0 ? data.error : ('HTTP ' + String(res.status))
      throw new Error(detail)
    }
    return data
  }

  async function fetchMe() {
    try {
      // Bounded probe: a stalled connection must not hold the plugin (and
      // with it the whole boot activation audit) open indefinitely.
      var res = await fetch('/api/auth/me', { signal: AbortSignal.timeout(15000) })
      if (!res.ok) return undefined
      var me = await res.json()
      if (me === null || typeof me !== 'object' || typeof me.username !== 'string') return undefined
      return me
    } catch (err) {
      return undefined
    }
  }

  function logout() {
    void fetch('/api/auth/logout', { method: 'POST' }).catch(function () {}).finally(function () {
      window.location.assign('/login')
    })
  }

  function fmtDate(ms) {
    var d = new Date(ms)
    if (isNaN(d.getTime())) return String(ms)
    // Compact minute precision keeps the last-login column narrow.
    return d.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  // ---- shared pieces ----
  function Badge(tone, key, t, n) {
    var label = n === undefined ? t(key) : t(key).replace('{n}', String(n))
    return h('span', { className: 'dshlu-badge dshlu-badge--' + tone }, label)
  }

  /** One main-page stat tile: a big number over its caption. */
  function StatTile(t, key, value, tone) {
    return h('div', { className: 'dshlu-stat' + (tone ? ' dshlu-stat--' + tone : '') },
      h('span', { className: 'dshlu-statValue' }, String(value)),
      h('span', { className: 'dshlu-statLabel' }, t(key)))
  }

  function AccountBar(t, me) {
    return h('div', { className: 'dshlu-account' },
      h('div', { className: 'dshlu-account-id' },
        h('span', { className: 'dshlu-account-name' }, me.username),
        h('span', { className: 'dshlu-account-role' }, t(me.isAdmin ? 'role.admin' : 'role.user'))),
      h(Button, { variant: 'outline', size: 'sm', onClick: logout }, t('account.logout')))
  }

  /** Panel id shared by the sidebar icon entry and the main seat. */
  var PANEL_ID = 'dsh-login-users'

  /** Sidebar icon for the 用户管理 panel entry (two-person glyph, theme-following). */
  function UsersPanelIcon(props) {
    var size = props && props.size ? props.size : 16
    return h('svg', {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.6,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    },
      h('circle', { cx: '9', cy: '8', r: '3.4' }),
      h('path', { d: 'M3.2 20c.6-3.6 2.9-5.6 5.8-5.6s5.2 2 5.8 5.6' }),
      h('circle', { cx: '17', cy: '9.2', r: '2.6' }),
      h('path', { d: 'M15.8 14.9c2.7.3 4.6 1.9 5 4.7' }))
  }

  /**
   * 侧边栏显示 switch: whether the 用户管理 entry shows in the MAIN-page left
   * sidebar (the entry opens 用户管理 as a full panel). Rendered inside the
   * users panel; the settings-panel section itself is always present, so the
   * switch stays reachable even when the main-sidebar entry is hidden.
   */
  function SidebarCard(props) {
    var t = props.t
    var onSidebarVisible = props.onSidebarVisible
    var enabledState = useState(props.me.usersSidebarVisible !== false)
    var enabled = enabledState[0]
    var setEnabled = enabledState[1]
    var busyState = useState(false)
    var busy = busyState[0]
    var setBusy = busyState[1]
    var errorState = useState('')
    var error = errorState[0]
    var setError = errorState[1]
    var toggle = async function (next) {
      setBusy(true)
      try {
        var data = await api('/api/auth/admin/settings/sidebar', 'POST', { enabled: next })
        // The server value is authoritative (it may have flipped concurrently).
        var applied = data !== null && data.enabled === true
        setEnabled(applied)
        setError('')
        if (onSidebarVisible) onSidebarVisible(applied)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      setBusy(false)
    }
    var description = error.length > 0
      ? t('sidebar.toggleFailed') + ': ' + error
      : (enabled ? t('sidebar.intro') : t('sidebar.hidden'))
    var row = h('div', { className: 'dshlu-switchrow' },
      h('div', { className: 'dshlu-switchtext' },
        h('div', { className: 'dshlu-switchlabel' }, t('sidebar.title')),
        h('p', { className: 'dshlu-switchdesc' }, description)),
      h('label', { className: 'dshlu-switch', title: enabled ? t('sidebar.on') : t('sidebar.off') },
        h('input', {
          type: 'checkbox',
          'data-switch': 'sidebar',
          checked: enabled,
          disabled: busy,
          onChange: function (e) { void toggle(e.target.checked) },
        }),
        h('span', { className: 'dshlu-switch-track' }),
        h('span', { className: 'dshlu-switch-knob' })))
    // Main panel: a setting row inside the access block. Settings column: its
    // own card, where the section is a stack of self-contained cards.
    if (props.as === 'row') return h('div', { className: 'dshlu-settingrow' }, row)
    return h('div', { className: 'dshlu-card' }, row)
  }

  /** Ordinary-user section: identity + logout. */
  function AccountPanel(props) {
    var t = props.t
    return h('div', { className: 'dshlu-section' },
      h('h2', { className: 'dshlu-title' }, t('account.title')),
      h('p', { className: 'dshlu-intro' }, t('account.intro')),
      AccountBar(t, props.me))
  }

  /** Admin section: user table + create card + dialogs + account bar. */
  function UsersPanel(props) {
    var t = props.t
    var me = props.me
    // Two presentations share this panel: the settings column (compact stack
    // of cards, 720px cap) and the MAIN panel page (full-width blocks).
    var main = props.layout === 'main'

    var listState = useState({ status: 'loading', users: [], error: '' })
    var list = listState[0]
    var setList = listState[1]

    var noticeState = useState({ kind: '', text: '' })
    var notice = noticeState[0]
    var setNotice = noticeState[1]

    var resetForState = useState(null)
    var resetFor = resetForState[0]
    var setResetFor = resetForState[1]
    var resetPwState = useState('')
    var resetPw = resetPwState[0]
    var setResetPw = resetPwState[1]

    var disableForState = useState(null)
    var disableFor = disableForState[0]
    var setDisableFor = disableForState[1]

    var removeForState = useState(null)
    var removeFor = removeForState[0]
    var setRemoveFor = removeForState[1]
    var removeAckState = useState(false)
    var removeAck = removeAckState[0]
    var setRemoveAck = removeAckState[1]

    var createUsernameState = useState('')
    var createUsername = createUsernameState[0]
    var setCreateUsername = createUsernameState[1]
    var createPasswordState = useState('')
    var createPassword = createPasswordState[0]
    var setCreatePassword = createPasswordState[1]
    var createAdminState = useState(false)
    var createAdmin = createAdminState[0]
    var setCreateAdmin = createAdminState[1]

    var hostsState = useState({ status: 'loading', hosts: [], error: '' })
    var hosts = hostsState[0]
    var setHosts = hostsState[1]
    var hostInputState = useState('')
    var hostInput = hostInputState[0]
    var setHostInput = hostInputState[1]

    var wsState = useState({ status: 'loading', enabled: true, error: '' })
    var ws = wsState[0]
    var setWs = wsState[1]
    var wsBusyState = useState(false)
    var wsBusy = wsBusyState[0]
    var setWsBusy = wsBusyState[1]

    var rwuState = useState({ status: 'loading', enabled: true, error: '' })
    var rwu = rwuState[0]
    var setRwu = rwuState[1]
    var rwuBusyState = useState(false)
    var rwuBusy = rwuBusyState[0]
    var setRwuBusy = rwuBusyState[1]

    var refresh = useCallback(async function () {
      try {
        var data = await api('/api/auth/admin/users', 'GET')
        setList({ status: 'ready', users: Array.isArray(data.users) ? data.users : [], error: '' })
      } catch (err) {
        setList({ status: 'error', users: [], error: err instanceof Error ? err.message : String(err) })
      }
    }, [])

    useEffect(function () {
      void refresh()
      var timer = setInterval(function () { void refresh() }, 20000)
      return function () { clearInterval(timer) }
    }, [refresh])

    var refreshHosts = useCallback(async function () {
      try {
        var data = await api('/api/auth/admin/hosts', 'GET')
        setHosts({ status: 'ready', hosts: Array.isArray(data.hosts) ? data.hosts : [], error: '' })
      } catch (err) {
        setHosts({ status: 'error', hosts: [], error: err instanceof Error ? err.message : String(err) })
      }
    }, [])
    useEffect(function () { void refreshHosts() }, [refreshHosts])

    var refreshWs = useCallback(async function () {
      try {
        var data = await api('/api/auth/admin/settings/default-workspace', 'GET')
        setWs({ status: 'ready', enabled: data !== null && data.enabled === true, error: '' })
      } catch (err) {
        setWs({ status: 'error', enabled: true, error: err instanceof Error ? err.message : String(err) })
      }
    }, [])
    useEffect(function () { void refreshWs() }, [refreshWs])

    var toggleWs = async function (enabled) {
      setWsBusy(true)
      try {
        var data = await api('/api/auth/admin/settings/default-workspace', 'POST', { enabled: enabled })
        setWs({ status: 'ready', enabled: data !== null && data.enabled === true, error: '' })
        setNotice({ kind: 'success', text: enabled ? t('ws.on') : t('ws.off') })
      } catch (err) {
        setWs({ status: 'error', enabled: enabled, error: err instanceof Error ? err.message : String(err) })
        setNotice({ kind: 'error', text: t('ws.toggleFailed') + ': ' + (err instanceof Error ? err.message : String(err)) })
      }
      setWsBusy(false)
    }

    var refreshRwu = useCallback(async function () {
      try {
        var data = await api('/api/auth/admin/settings/remote-web-ui-compat', 'GET')
        setRwu({ status: 'ready', enabled: data !== null && data.enabled === true, error: '' })
      } catch (err) {
        setRwu({ status: 'error', enabled: true, error: err instanceof Error ? err.message : String(err) })
      }
    }, [])
    useEffect(function () { void refreshRwu() }, [refreshRwu])

    var toggleRwu = async function (enabled) {
      setRwuBusy(true)
      try {
        var data = await api('/api/auth/admin/settings/remote-web-ui-compat', 'POST', { enabled: enabled })
        setRwu({ status: 'ready', enabled: data !== null && data.enabled === true, error: '' })
        if (data !== null && data.applied === 'ok') setNotice({ kind: 'success', text: enabled ? t('rwu.on') + ' · ' + t('rwu.applied') : t('rwu.off') + ' · ' + t('rwu.applied') })
        else if (data !== null && data.applied === 'unregistered') setNotice({ kind: 'success', text: enabled ? t('rwu.on') + ' · ' + t('rwu.unregistered') : t('rwu.off') + ' · ' + t('rwu.unregistered') })
        else setNotice({ kind: 'success', text: enabled ? t('rwu.on') : t('rwu.off') })
      } catch (err) {
        setRwu({ status: 'error', enabled: enabled, error: err instanceof Error ? err.message : String(err) })
        setNotice({ kind: 'error', text: t('rwu.toggleFailed') + ': ' + (err instanceof Error ? err.message : String(err)) })
      }
      setRwuBusy(false)
    }

    var run = async function (action, successKey) {
      try {
        await action()
        setNotice({ kind: 'success', text: t(successKey) })
      } catch (err) {
        setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
      setResetFor(null); setDisableFor(null); setRemoveFor(null); setRemoveAck(false)
      await refresh()
    }

    var table
    if (list.status === 'loading') {
      table = h('div', { className: 'dshlu-loading' }, '…')
    } else if (list.status === 'error') {
      table = h('div', { className: 'dshlu-empty' }, t('error.loadFailed') + ': ' + list.error)
    } else if (list.users.length === 0) {
      table = h('div', { className: 'dshlu-empty' }, '—')
    } else {
      table = h('div', { className: 'dshlu-table' },
        h('div', { className: 'dshlu-head' },
          h('div', null, t('col.username')),
          h('div', null, t('col.lastLogin')),
          h('div', null, t('col.status')),
          h('div', null, t('col.actions'))),
        list.users.map(function (u) {
          return h('div', { key: u.username, className: 'dshlu-row' + (u.disabled ? ' dshlu-row--disabled' : '') },
            h('div', { className: 'dshlu-cell dshlu-name' },
              h('span', { className: 'dshlu-avatar', 'aria-hidden': 'true' }, u.username.slice(0, 1).toUpperCase()),
              u.username,
              u.isAdmin ? Badge('admin', 'role.admin', t) : null),
            h('div', { className: 'dshlu-cell dshlu-cell--login', title: u.lastLoginAt !== null && u.lastLoginAt !== undefined ? fmtDate(u.lastLoginAt) : undefined },
              u.lastLoginAt !== null && u.lastLoginAt !== undefined ? fmtDate(u.lastLoginAt) : t('status.never')),
            h('div', { className: 'dshlu-cell dshlu-cell--status' },
              u.onlineSessions > 0 ? Badge('online', 'status.online', t, u.onlineSessions) : Badge('muted', 'status.offline', t),
              u.disabled ? Badge('disabled', 'status.disabled', t) : null),
            h('div', { className: 'dshlu-cell dshlu-cell--actions' },
              h(Button, { variant: 'ghost', size: 'sm', onClick: function () { setResetFor(u.username); setResetPw('') } }, t('action.resetPassword')),
              h(Button, { variant: 'ghost', size: 'sm', onClick: function () { setDisableFor(u.username) } }, t(u.disabled ? 'action.enable' : 'action.disable')),
              h(Button, { variant: 'ghost', size: 'sm', className: 'dshlu-danger', onClick: function () { setRemoveFor(u.username); setRemoveAck(false) } }, t('action.remove'))))
        }))
    }

    var createForm = h('form', {
      className: 'dshlu-fields',
      onSubmit: function (e) {
        e.preventDefault()
        if (createUsername.length === 0 || createPassword.length === 0) return
        void run(async function () {
          await api('/api/auth/admin/users', 'POST', { username: createUsername, password: createPassword, isAdmin: createAdmin })
          setCreateUsername(''); setCreatePassword(''); setCreateAdmin(false)
        }, 'create.title')
      },
    },
      h(Input, { placeholder: t('create.username'), value: createUsername, autoComplete: 'off', onChange: function (e) { setCreateUsername(e.target.value) } }),
      h(Input, { placeholder: t('create.password'), value: createPassword, type: 'password', autoComplete: 'new-password', onChange: function (e) { setCreatePassword(e.target.value) } }),
      h('label', { className: 'dshlu-check' },
        h('input', { type: 'checkbox', checked: createAdmin, onChange: function (e) { setCreateAdmin(e.target.checked) } }),
        t('create.admin')),
      h(Button, { variant: 'primary', size: 'sm', type: 'submit', disabled: createUsername.length === 0 || createPassword.length === 0 }, t('create.submit')))

    var createCard = h('div', { className: 'dshlu-card' },
      h('h3', null, t('create.title')),
      createForm)

    var resetDialog = h(Modal, {
      open: resetFor !== null,
      onClose: function () { setResetFor(null) },
      title: t('dialog.resetTitle'),
      closeLabel: t('dialog.cancel'),
      description: resetFor !== null ? t('dialog.resetDesc').replace('{username}', resetFor) : undefined,
      footer: h(React.Fragment, null,
        h(Button, { variant: 'outline', size: 'sm', onClick: function () { setResetFor(null) } }, t('dialog.cancel')),
        h(Button, {
          variant: 'primary', size: 'sm', disabled: resetPw.length === 0,
          onClick: function () {
            var username = resetFor
            var password = resetPw
            void run(async function () { await api('/api/auth/admin/users/password', 'POST', { username: username, password: password }) }, 'action.resetPassword')
          },
        }, t('dialog.confirm')),
      ),
    },
      h('div', { className: 'dshlu-dialog-fields' },
        h(Input, {
          placeholder: t('dialog.newPassword'), value: resetPw, type: 'password', autoComplete: 'new-password',
          onChange: function (e) { setResetPw(e.target.value) },
        })))

    var disableDialog = h(Modal, {
      open: disableFor !== null,
      onClose: function () { setDisableFor(null) },
      title: t('dialog.disableTitle'),
      closeLabel: t('dialog.cancel'),
      footer: h(React.Fragment, null,
        h(Button, { variant: 'outline', size: 'sm', onClick: function () { setDisableFor(null) } }, t('dialog.cancel')),
        h(Button, {
          variant: 'primary', size: 'sm',
          onClick: function () {
            var username = disableFor
            var target = list.users.find(function (u) { return u.username === username })
            var disabled = !(target !== undefined && target.disabled)
            void run(async function () { await api('/api/auth/admin/users/disable', 'POST', { username: username, disabled: disabled }) }, 'action.' + (disabled ? 'disable' : 'enable'))
          },
        }, t('dialog.confirm')),
      ),
    },
      h('div', { className: 'dshlu-dialog-fields' },
        h('p', { className: 'dshlu-dialog-desc' }, disableFor !== null ? t('dialog.disableDesc').replace('{username}', disableFor) : ''),
        disableFor === me.username ? h('p', { className: 'dshlu-dialog-desc dshlu-danger' }, t('dialog.disableSelf')) : null))

    var removeDialog = h(RiskConfirmation, {
      open: removeFor !== null,
      title: t('dialog.removeTitle'),
      description: removeFor !== null ? t('dialog.removeDesc').replace('{username}', removeFor) : '',
      acknowledgeLabel: t('dialog.removeAck'),
      cancelLabel: t('dialog.cancel'),
      confirmLabel: t('action.remove'),
      acknowledged: removeAck,
      onAcknowledgedChange: function (v) { setRemoveAck(v) },
      onCancel: function () { setRemoveFor(null); setRemoveAck(false) },
      onConfirm: function () {
        var username = removeFor
        void run(async function () { await api('/api/auth/admin/users/remove', 'POST', { username: username }) }, 'action.remove')
      },
    })

    var hostsIntro = h('p', { className: 'dshlu-intro' }, t('hosts.intro'))
    var hostsList = hosts.status === 'loading'
      ? h('div', { className: 'dshlu-loading' }, '…')
      : hosts.status === 'error'
        ? h('div', { className: 'dshlu-empty' }, hosts.error)
        : hosts.hosts.length === 0
          ? h('div', { className: 'dshlu-empty' }, t('hosts.empty'))
          : h('div', { className: 'dshlu-hostlist' }, hosts.hosts.map(function (hst) {
              return h('div', { key: hst, className: 'dshlu-hostrow' },
                h('code', null, hst),
                h(Button, { variant: 'ghost', size: 'sm', className: 'dshlu-danger', onClick: function () {
                  void (async function () {
                    try { await api('/api/auth/admin/hosts', 'DELETE', { host: hst }); setNotice({ kind: 'success', text: t('hosts.removed') }) }
                    catch (err) { setNotice({ kind: 'error', text: (err instanceof Error ? err.message : String(err)) + ' (' + t('hosts.removeFailed') + ')' }) }
                    void refreshHosts()
                  })()
                } }, t('hosts.remove')))
            }))
    var hostsForm = h('form', { className: 'dshlu-fields', onSubmit: function (e) {
      e.preventDefault()
      if (hostInput.length === 0) return
      var value = hostInput
      void (async function () {
        try { await api('/api/auth/admin/hosts', 'POST', { host: value }); setHostInput(''); setNotice({ kind: 'success', text: t('hosts.added') }) }
        catch (err) { setNotice({ kind: 'error', text: (err instanceof Error ? err.message : String(err)) + ' (' + t('hosts.addFailed') + ')' }) }
        void refreshHosts()
      })()
    } },
      h(Input, { placeholder: t('hosts.placeholder'), value: hostInput, autoComplete: 'off', onChange: function (e) { setHostInput(e.target.value) } }),
      h(Button, { variant: 'primary', size: 'sm', type: 'submit', disabled: hostInput.length === 0 }, t('hosts.add')))

    var hostsCard = h('div', { className: 'dshlu-card' },
      h('h3', null, t('hosts.title')),
      hostsIntro,
      hostsList,
      hostsForm)

    var wsEnabled = ws.status === 'ready' ? ws.enabled : true
    var wsRow = h('div', { className: 'dshlu-switchrow' },
      h('div', { className: 'dshlu-switchtext' },
        h('div', { className: 'dshlu-switchlabel' }, t('ws.title')),
        h('p', { className: 'dshlu-switchdesc' }, ws.status === 'error' ? t('ws.toggleFailed') + ': ' + ws.error : t('ws.intro'))),
      h('label', { className: 'dshlu-switch', title: wsEnabled ? t('ws.on') : t('ws.off') },
        h('input', {
          type: 'checkbox',
          checked: wsEnabled,
          disabled: wsBusy || ws.status === 'loading',
          onChange: function (e) { void toggleWs(e.target.checked) },
        }),
        h('span', { className: 'dshlu-switch-track' }),
        h('span', { className: 'dshlu-switch-knob' })))

    var rwuEnabled = rwu.status === 'ready' ? rwu.enabled : true
    var rwuRow = h('div', { className: 'dshlu-switchrow' },
      h('div', { className: 'dshlu-switchtext' },
        h('div', { className: 'dshlu-switchlabel' }, t('rwu.title')),
        h('p', { className: 'dshlu-switchdesc' }, rwu.status === 'error' ? t('rwu.toggleFailed') + ': ' + rwu.error : t('rwu.intro'))),
      h('label', { className: 'dshlu-switch', title: rwuEnabled ? t('rwu.on') : t('rwu.off') },
        h('input', {
          type: 'checkbox',
          checked: rwuEnabled,
          disabled: rwuBusy || rwu.status === 'loading',
          onChange: function (e) { void toggleRwu(e.target.checked) },
        }),
        h('span', { className: 'dshlu-switch-track' }),
        h('span', { className: 'dshlu-switch-knob' })))

    // A switch card in the settings column becomes a hairline-separated
    // setting row inside the main panel's access block.
    var wrapSwitch = function (row) {
      return main
        ? h('div', { className: 'dshlu-settingrow' }, row)
        : h('div', { className: 'dshlu-card' }, row)
    }
    var wsCard = wrapSwitch(wsRow)
    var rwuCard = wrapSwitch(rwuRow)
    var sidebarCard = SidebarCard({ t: t, me: me, onSidebarVisible: props.onSidebarVisible, as: main ? 'row' : '' })
    var noticeLine = notice.text.length > 0
      ? h('p', { className: 'dshlu-notice dshlu-notice--' + notice.kind }, notice.text)
      : null

    // Main panel: the sidebar entry opens 用户管理 as a whole page, so it
    // renders the page shell — a hero, stat tiles, then titled blocks (table,
    // create, trusted hosts, sign-in settings). The settings column keeps the
    // compact single stack below.
    if (main) {
      var statsRow = null
      if (list.status === 'ready') {
        var onlineUsers = 0
        var disabledUsers = 0
        list.users.forEach(function (u) {
          if (u.onlineSessions > 0) onlineUsers += 1
          if (u.disabled) disabledUsers += 1
        })
        statsRow = h('div', { className: 'dshlu-stats' },
          StatTile(t, 'stats.accounts', list.users.length, ''),
          StatTile(t, 'stats.online', onlineUsers, onlineUsers > 0 ? 'success' : 'muted'),
          StatTile(t, 'stats.disabled', disabledUsers, disabledUsers > 0 ? 'warn' : 'muted'))
      }
      var accountBlock = h('section', { className: 'dshlu-block' },
        h('div', { className: 'dshlu-blockHead' },
          h('h2', { className: 'dshlu-blockTitle' }, t('table.title')),
          list.status === 'ready'
            ? h('span', { className: 'dshlu-blockNote' }, t('table.count').replace('{n}', String(list.users.length)))
            : null),
        table)
      var createBlock = h('section', { className: 'dshlu-block' },
        h('div', { className: 'dshlu-blockHead' },
          h('h2', { className: 'dshlu-blockTitle' }, t('create.title'))),
        createForm)
      var hostsBlock = h('section', { className: 'dshlu-block' },
        h('div', { className: 'dshlu-blockHead' },
          h('h2', { className: 'dshlu-blockTitle' }, t('hosts.title'))),
        hostsIntro,
        hostsList,
        hostsForm)
      var accessBlock = h('section', { className: 'dshlu-block dshlu-block--rows' },
        h('div', { className: 'dshlu-blockHead' },
          h('h2', { className: 'dshlu-blockTitle' }, t('access.title'))),
        wsCard,
        rwuCard,
        sidebarCard)
      return h('div', { className: 'dshlu-page' },
        h('div', { className: 'dshlu-pagecol' },
          h('header', { className: 'dshlu-hero' },
            h('h1', { className: 'dshlu-heroTitle' }, t('users.title')),
            h('p', { className: 'dshlu-heroLede' }, t('users.intro'))),
          statsRow,
          noticeLine,
          accountBlock,
          createBlock,
          hostsBlock,
          accessBlock,
          AccountBar(t, me),
          resetDialog,
          disableDialog,
          removeDialog))
    }

    return h('div', { className: 'dshlu-section' },
      h('h2', { className: 'dshlu-title' }, t('users.title')),
      h('p', { className: 'dshlu-intro' }, t('users.intro')),
      noticeLine,
      table,
      createCard,
      wsCard,
      rwuCard,
      sidebarCard,
      hostsCard,
      AccountBar(t, me),
      resetDialog,
      disableDialog,
      removeDialog)
  }

  // Factory-time side effect (module-system contract): inject the themed
  // stylesheet, pre-tagged the way the framework's own bundle preset does
  // (data-plugin + a stable data-plugin-css tag id, deduped by that id) so
  // HMR re-materialization reuses the tag instead of stacking duplicates.
  if (typeof document !== 'undefined') {
    var styleTagId = '@islibaodong/dsh-login/settings-panel.css'
    if (document.querySelector('style[data-plugin-css=' + JSON.stringify(styleTagId) + ']') === null) {
      var styleEl = document.createElement('style')
      styleEl.dataset.plugin = '@islibaodong/dsh-login'
      styleEl.dataset.pluginCss = styleTagId
      styleEl.textContent = CSS
      document.head.append(styleEl)
    }
  }

  // ---- the wrapper plugin ----
  // Option A (DSH ≥ 0.1.5-alpha.1): this fiber does NOT provide `connection`
  // (the native connection row owns /api), so it declares no hard dependency —
  // the settings section is registered in a dependency fiber once `slots` +
  // `locale` exist, so this plugin's activation never stalls on services that
  // transitively wait on connection.
  return {
    name: 'dsh-login',
    inject: [],
    apply: function (ctx) {
      // Dictionaries + the settings section, registered in a dependency
      // fiber that starts once slots and locale are available.
      ctx.inject(['slots', 'locale'], function (sub) {
        sub.effect(function () {
          return sub.locale.register(NS, { zh: zh, en: en })
        }, 'dsh-login: settings-panel dictionaries')
        var t = sub.locale.bind(NS)

        // Identity probe: admins get the 用户管理 settings section (always
        // present — the recovery path for the main-sidebar toggle) and, when
        // the 侧边栏显示 flag is on, a MAIN-page sidebar entry that opens
        // 用户管理 as a full panel. Ordinary users get 账户 only.
        void fetchMe().then(function (me) {
          if (me === undefined) return
          var isAdmin = me.isAdmin === true
          var panelProps = function (layout) {
            return { t: t, me: me, layout: layout, onSidebarVisible: setVisible }
          }
          // Main-sidebar entry state machine: the icon + main seat
          // (de)register live as the switch flips, no reload needed.
          var visible = me.usersSidebarVisible !== false
          var regIcon = undefined
          var regMain = undefined
          var setVisible = function (next) {
            if (visible === next) return
            visible = next
            applySidebar()
          }
          var applySidebar = function () {
            if (visible && regIcon === undefined) {
              regIcon = sub.slots.register({
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 20,
                label: function () { return t('users.nav') },
                locale: NS,
              }, UsersPanelIcon)
            }
            if (!visible && regIcon !== undefined) { regIcon(); regIcon = undefined }
            if (visible && regMain === undefined) {
              regMain = sub.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, function () {
                return h(UsersPanel, panelProps('main'))
              })
            }
            if (!visible && regMain !== undefined) { regMain(); regMain = undefined }
          }
          // Settings panel section: fixed single entry (admin → 用户管理,
          // ordinary → 账户); the settings sidebar itself is not togglable.
          sub.slots.inject('settings.section', function () {
            return sub.slots.register({
              name: 'settings.section',
              id: isAdmin ? 'users' : 'account',
              order: 25,
              label: function () { return t(isAdmin ? 'users.nav' : 'account.nav') },
              locale: NS,
            }, function () { return h(isAdmin ? UsersPanel : AccountPanel, panelProps('settings')) })
          })
          if (!isAdmin) return
          applySidebar()
          return function () {
            if (regIcon !== undefined) { regIcon(); regIcon = undefined }
            if (regMain !== undefined) { regMain(); regMain = undefined }
          }
        })
      })
    },
  }
}
