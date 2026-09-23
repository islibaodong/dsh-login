import { describe, expect, it } from 'vitest'
import { ADMIN_ONLY_TWO_SEGMENT_DOMAINS, deriveCapabilities, isReadProbe, isUserDeniedTwoSegment, QUIET_DENY_METHODS, userAllowedMethods } from '../src/capabilities.ts'
import { USER_ALLOWED } from '../src/api-filter.ts'

describe('capabilities', () => {
  it('advertises exactly the USER_ALLOWED allow-list for an ordinary user', () => {
    const caps = deriveCapabilities({ username: 'alice', isAdmin: false })
    expect(new Set(caps.methods)).toEqual(new Set([...USER_ALLOWED]))
    // Every advertised method must be in the allow-list, so the capability
    // surface can never exceed what the physical layer actually grants.
    for (const method of caps.methods) expect(USER_ALLOWED.has(method)).toBe(true)
  })

  it('advertises every method/domain/plugin for an admin', () => {
    const caps = deriveCapabilities({ username: 'root', isAdmin: true })
    // A superset of the ordinary-user surface.
    expect(caps.methods.length).toBeGreaterThanOrEqual([...USER_ALLOWED].length)
    expect(caps.domains).toContain('credentials')
    expect(caps.domains).toContain('settings')
    expect(caps.domains).toContain('agentPresets')
    // Admin sees the admin-only UI plugins.
    for (const p of ['@linxin666/dsh-client-ui-plugin-manager', '@linxin666/dsh-doctor']) {
      expect(caps.uiPlugins).toContain(p)
    }
  })

  it('hides admin-only domains and UI plugins from an ordinary user', () => {
    const caps = deriveCapabilities({ username: 'alice', isAdmin: false })
    expect(caps.domains).not.toContain('credentials')
    expect(caps.domains).not.toContain('settings')
    expect(caps.domains).not.toContain('agentPresets')
    expect(caps.uiPlugins).toEqual(['@islibaodong/dsh-login'])
  })

  it('userAllowedMethods matches the allow-list exactly', () => {
    expect(userAllowedMethods()).toEqual([...USER_ALLOWED])
  })

  it('grants the DSH 0.1.6 user-facing additions (unarchive + terminal)', () => {
    // workspace.unarchiveSession pairs with the already-allowed
    // workspace.archiveSession — an ordinary user who can archive a Session
    // can also restore it (0.1.6 sidebar feature).
    expect(USER_ALLOWED.has('workspace.unarchiveSession')).toBe(true)
    // The 0.1.6 sidebar terminal (typert namespace `terminal`): every method
    // is session-agent-scoped by the Gateway, so it rides the caller's own
    // agent subtree — the same trust boundary as session.prompt.
    for (const m of [
      'terminal.environment', 'terminal.shells', 'terminal.list', 'terminal.create',
      'terminal.follow', 'terminal.write', 'terminal.resize', 'terminal.rename',
      'terminal.close',
    ]) {
      expect(USER_ALLOWED.has(m)).toBe(true)
    }
  })

  it('grants the DSH 0.1.6-alpha.2 additions (terminal.retain + document preview)', () => {
    // 0.1.6-alpha.2 terminal retention across reconnects; addresses a session
    // explicitly (ownership-guarded like terminal.list).
    expect(USER_ALLOWED.has('terminal.retain')).toBe(true)
    // The right Sidebar's document preview: the read-only workspaceFiles
    // surface plus the Office→PDF converter. Every wire call carries the
    // scoped session identity (workspaceFileScopeId) the guard checks.
    for (const m of [
      'workspaceFiles.read', 'workspaceFiles.readAll', 'workspaceFiles.readBytes',
      'workspaceFiles.readRelated', 'workspaceFiles.stat', 'workspaceFiles.list',
      'workspaceFiles.changes', 'officeToPdf.render', 'officeToPdf.generation',
    ]) {
      expect(USER_ALLOWED.has(m)).toBe(true)
    }
  })

  it('exposes the alpha.2 document-preview domains to ordinary users', () => {
    const caps = deriveCapabilities({ username: 'alice', isAdmin: false })
    expect(caps.domains).toContain('workspaceFiles')
    expect(caps.domains).toContain('officeToPdf')
    // ...while the native plugin manager stays admin-only.
    expect(caps.domains).not.toContain('pluginManager')
  })

  it('advertises the native plugin manager to admins only (0.1.6-alpha.2)', () => {
    const admin = deriveCapabilities({ username: 'root', isAdmin: true })
    expect(admin.domains).toContain('pluginManager')
    expect(admin.methods).toContain('pluginManager.listPlugins')
    expect(admin.methods).toContain('pluginManager.installBundle')
    expect(admin.methods).toContain('pluginManager.removeBundle')
    const caps = deriveCapabilities({ username: 'alice', isAdmin: false })
    expect(caps.methods.some(m => m.startsWith('pluginManager.'))).toBe(false)
  })

  it('exposes the terminal domain to ordinary users and never denies it', () => {
    const caps = deriveCapabilities({ username: 'alice', isAdmin: false })
    expect(caps.domains).toContain('terminal')
    expect(isUserDeniedTwoSegment('terminal')).toBe(false)
  })

  it('grants the DSH 0.1.7 additions (job + session pinning) to ordinary users', () => {
    // 0.1.7 job controller (SessionJob moved out of `session`): the
    // reconnect-safe streams plus the human kill, all sessionId-scoped.
    for (const m of ['job.list', 'job.follow', 'job.kill']) {
      expect(USER_ALLOWED.has(m)).toBe(true)
    }
    // 0.1.7 workspace session pinning.
    expect(USER_ALLOWED.has('workspace.pinSession')).toBe(true)
    expect(USER_ALLOWED.has('workspace.unpinSession')).toBe(true)
    const caps = deriveCapabilities({ username: 'alice', isAdmin: false })
    expect(caps.domains).toContain('job')
  })

  it('keeps the account namespace (0.1.7) admin-only across all three layers', () => {
    // Wire guard: absent from the ordinary allow-list, advertised for admins.
    const caps = deriveCapabilities({ username: 'alice', isAdmin: false })
    expect(caps.methods.some(m => m.startsWith('account.'))).toBe(false)
    expect(caps.domains).not.toContain('account')
    const admin = deriveCapabilities({ username: 'root', isAdmin: true })
    expect(admin.methods).toContain('account.startSignIn')
    expect(admin.methods).toContain('account.signOut')
    expect(admin.domains).toContain('account')
    // Two-segment URL layer: /api/account/* is admin-only.
    expect(isUserDeniedTwoSegment('account')).toBe(true)
    // Grace layer: read projections deny quietly (the GUI probes them at
    // boot), writes stay loud 403.
    expect(isReadProbe('account.getState')).toBe(true)
    expect(isReadProbe('account.getProfile')).toBe(true)
    expect(isReadProbe('account.getBalance')).toBe(true)
    expect(isReadProbe('account.signOut')).toBe(false)
    expect(isReadProbe('account.startSignIn')).toBe(false)
  })
})

describe('isReadProbe', () => {
  it('classifies read-verb methods as read probes', () => {
    for (const m of ['session.list', 'llm.providers', 'host.status', 'agentPreset.list', 'ui.plugins']) {
      expect(isReadProbe(m)).toBe(true)
    }
  })

  it('does not classify mutating verbs as read probes', () => {
    for (const m of ['session.create', 'session.delete', 'session.prompt', 'settings.update', 'credentials.set', 'host.open']) {
      expect(isReadProbe(m)).toBe(false)
    }
  })

  it('treats every QUIET_DENY_METHODS entry as a read probe regardless of verb', () => {
    for (const m of QUIET_DENY_METHODS) expect(isReadProbe(m)).toBe(true)
  })

  it('is pure and deterministic', () => {
    expect(isReadProbe('agentPreset.list')).toBe(isReadProbe('agentPreset.list'))
  })
})

describe('isUserDeniedTwoSegment', () => {
  it('denies admin-only/decoration two-segment domains', () => {
    for (const d of ['pet', 'credentials', 'agentPresets', 'plugin-manager', 'task-board', 'doctor', 'pair', 'update', 'dsh-web-ui-settings', 'agents']) {
      expect(isUserDeniedTwoSegment(d)).toBe(true)
    }
  })

  it('never denies user-facing domains (ssh, skill, settings, chat, api)', () => {
    // The deny-list is conservative: any domain an ordinary user could reach
    // (ssh, skill, settings, …) is dispatched as before — a wrong deny here
    // would regress a real user feature, so these must stay open.
    for (const d of ['ssh', 'skill', 'settings', 'session', 'workspace', 'api', 'chat']) {
      expect(isUserDeniedTwoSegment(d)).toBe(false)
    }
  })

  it('has no overlap with the ordinary-user domain surface', () => {
    const user = deriveCapabilities({ username: 'alice', isAdmin: false })
    for (const d of user.domains) expect(isUserDeniedTwoSegment(d)).toBe(false)
    // And the admin-only list is non-trivial (guards against it silently emptying).
    expect(ADMIN_ONLY_TWO_SEGMENT_DOMAINS.size).toBeGreaterThan(10)
  })
})