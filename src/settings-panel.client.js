/**
 * dsh-login settings-panel client half — plain browser JavaScript.
 *
 * This file is NOT transformed: scripts/build-client.mjs appends it verbatim
 * to dist/client.js as a second module registration. The factory wraps the
 * re-stamped connection client (registered by the same bundle under the
 * internal id "@islibaodong/dsh-login/connection") and returns one Cordis
 * plugin that applies the shipped wire client verbatim (provides the
 * `connection` service) and registers the dsh-login settings section:
 * 用户管理 for admins (user table + create/reset/disable/remove + logout)
 * or 账户 for ordinary users (identity + logout).
 *
 * All styling runs through the framework's `--dsw-alias-*` theme tokens, so
 * the panel follows the app skin (light/dark) automatically. React and the
 * UI primitives come from the platform module-table seeds every bundle may
 * require; no cross-plugin value imports.
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
  // Same-bundle internal registration (see build-client.mjs): materializes
  // the shipped connection client this wrapper applies verbatim.
  var inner = require('@islibaodong/dsh-login/connection')

  // ---- styles (settings-panel design language: 14/22 body, 12/18 caption,
  // 12px-radius outlined cards, --dsw-alias-border-l2 hairlines) ----
  var CSS = `
.dshlu-section { display: flex; flex-direction: column; gap: 12px; max-width: 720px; color: var(--dsw-alias-label-primary); }
.dshlu-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dshlu-intro { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }
.dshlu-notice { margin: 0; font-size: 12px; line-height: 18px; min-height: 18px; }
.dshlu-notice--error { color: var(--dsw-alias-state-error-primary); }
.dshlu-notice--success { color: var(--dsw-alias-state-success-primary); }
.dshlu-table { display: flex; flex-direction: column; gap: 8px; margin: 4px 0 0; }
.dshlu-head, .dshlu-row { display: grid; grid-template-columns: minmax(0, 1fr) 56px 150px 112px max-content; gap: 8px; align-items: center; }
.dshlu-head { padding: 0 14px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); }
.dshlu-head > :last-child { text-align: right; }
.dshlu-row { padding: 8px 14px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; }
.dshlu-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshlu-row--disabled .dshlu-name { color: var(--dsw-alias-label-tertiary); }
.dshlu-name { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-size: 14px; line-height: 22px; font-weight: 500; overflow-wrap: anywhere; }
.dshlu-cell { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-secondary); }
.dshlu-cell--login { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dshlu-cell--actions { display: flex; flex-wrap: nowrap; gap: 6px; justify-content: flex-end; white-space: nowrap; }
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
    'col.role': '角色',
    'col.lastLogin': '最后登录',
    'col.status': '状态',
    'col.actions': '操作',
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
    'col.role': 'Role',
    'col.lastLogin': 'Last login',
    'col.status': 'Status',
    'col.actions': 'Actions',
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

  function AccountBar(t, me) {
    return h('div', { className: 'dshlu-account' },
      h('div', { className: 'dshlu-account-id' },
        h('span', { className: 'dshlu-account-name' }, me.username),
        h('span', { className: 'dshlu-account-role' }, t(me.isAdmin ? 'role.admin' : 'role.user'))),
      h(Button, { variant: 'outline', size: 'sm', onClick: logout }, t('account.logout')))
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
          h('div', null, t('col.role')),
          h('div', null, t('col.lastLogin')),
          h('div', null, t('col.status')),
          h('div', null, t('col.actions'))),
        list.users.map(function (u) {
          return h('div', { key: u.username, className: 'dshlu-row' + (u.disabled ? ' dshlu-row--disabled' : '') },
            h('div', { className: 'dshlu-cell dshlu-name' },
              u.username,
              u.isAdmin ? Badge('admin', 'role.admin', t) : null),
            h('div', { className: 'dshlu-cell' }, t(u.isAdmin ? 'role.admin' : 'role.user')),
            h('div', { className: 'dshlu-cell dshlu-cell--login', title: u.lastLoginAt !== null && u.lastLoginAt !== undefined ? fmtDate(u.lastLoginAt) : undefined },
              u.lastLoginAt !== null && u.lastLoginAt !== undefined ? fmtDate(u.lastLoginAt) : t('status.never')),
            h('div', { className: 'dshlu-cell' },
              u.onlineSessions > 0 ? Badge('online', 'status.online', t, u.onlineSessions) : Badge('muted', 'status.offline', t),
              u.disabled ? Badge('disabled', 'status.disabled', t) : null),
            h('div', { className: 'dshlu-cell dshlu-cell--actions' },
              h(Button, { variant: 'ghost', size: 'sm', onClick: function () { setResetFor(u.username); setResetPw('') } }, t('action.resetPassword')),
              h(Button, { variant: 'ghost', size: 'sm', onClick: function () { setDisableFor(u.username) } }, t(u.disabled ? 'action.enable' : 'action.disable')),
              h(Button, { variant: 'ghost', size: 'sm', className: 'dshlu-danger', onClick: function () { setRemoveFor(u.username); setRemoveAck(false) } }, t('action.remove'))))
        }))
    }

    var createCard = h('div', { className: 'dshlu-card' },
      h('h3', null, t('create.title')),
      h('form', {
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
        h(Button, { variant: 'primary', size: 'sm', type: 'submit', disabled: createUsername.length === 0 || createPassword.length === 0 }, t('create.submit'))))

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

    return h('div', { className: 'dshlu-section' },
      h('h2', { className: 'dshlu-title' }, t('users.title')),
      h('p', { className: 'dshlu-intro' }, t('users.intro')),
      notice.text.length > 0 ? h('p', { className: 'dshlu-notice dshlu-notice--' + notice.kind }, notice.text) : null,
      table,
      createCard,
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
  // Wire-root discipline: this fiber is the ONLY provider of `connection`
  // (the shipped connection row is disabled while this takeover is active),
  // so it must not declare ANY hard service dependency — `locale` itself
  // waits on `connection`, and a hard inject here deadlocks the whole boot
  // (every UI plugin transitively waits on connection). The settings-panel
  // registration therefore runs in a dependency fiber (ctx.inject callback)
  // once slots+locale exist, never blocking this plugin's activation.
  return {
    name: 'dsh-login',
    inject: [],
    apply: function (ctx) {
      // 1. The shipped wire client, applied verbatim — synchronously, so
      //    `connection` exists the moment this fiber activates.
      inner.apply(ctx)

      // 2. Dictionaries + the settings section, registered in a dependency
      //    fiber that starts once slots and locale are available.
      ctx.inject(['slots', 'locale'], function (sub) {
        sub.effect(function () {
          return sub.locale.register(NS, { zh: zh, en: en })
        }, 'dsh-login: settings-panel dictionaries')
        var t = sub.locale.bind(NS)

        // Identity probe: pick the admin (用户管理) or ordinary (账户)
        // section. Unauthenticated pages never reach the SPA shell (the
        // gateway redirects first); a failed probe registers nothing.
        void fetchMe().then(function (me) {
          if (me === undefined) return
          var isAdmin = me.isAdmin === true
          sub.slots.inject('settings.section', function () {
            return sub.slots.register({
              name: 'settings.section',
              id: isAdmin ? 'users' : 'account',
              order: 25,
              label: function () { return t(isAdmin ? 'users.nav' : 'account.nav') },
              locale: NS,
            }, function () { return h(isAdmin ? UsersPanel : AccountPanel, { t: t, me: me }) })
          })
        })
      })
    },
  }
}
