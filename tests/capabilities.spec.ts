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