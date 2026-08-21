import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Functional smoke of the settings-panel client half
 * (src/settings-panel.client.js): the plain-JavaScript factory is evaluated
 * against a stub module table (React + primitives + the internal connection
 * half), the returned plugin is applied over a fake Cordis context with a
 * stubbed /api/auth/me fetch, and the registered settings-section component
 * renders an element tree for both the admin and ordinary-user identities.
 */
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(repoRoot, 'src/settings-panel.client.js'), 'utf8')

/** Evaluate the panel source as a function expression, the way the bundle does. */
const factory = new Function(`return (${source})`)() as (require: (spec: string) => unknown) => {
  name: string
  inject: string[]
  apply: (ctx: unknown) => Promise<void>
}

const innerApply = vi.fn()

function makeRequire() {
  const primitives = {
    Button: 'Button', Input: 'Input', Modal: 'Modal', RiskConfirmation: 'RiskConfirmation',
  }
  const React = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    Fragment: 'Fragment',
    useState: (v: unknown) => [typeof v === 'function' ? (v as () => unknown)() : v, () => {}],
    useEffect: () => {},
    useCallback: (fn: unknown) => fn,
  }
  return vi.fn((spec: string) => {
    if (spec === 'react') return React
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    if (spec === '@islibaodong/dsh-login/connection') return { inject: [], apply: innerApply }
    throw new Error(`unexpected require: ${spec}`)
  })
}

interface RegisteredSection {
  options: { id: string; order: number; label: () => string }
  component: (props: unknown) => { type: unknown }
}

function makeCtx() {
  const sections: RegisteredSection[] = []
  const disposers: Array<() => void> = []
  const ctx = {
    effect(fn: () => (() => void) | undefined): (() => void) | undefined {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (_slot: string, register: () => unknown) => {
        const entry = register() as { options: RegisteredSection['options']; render: unknown }
        sections.push({ options: entry.options, component: entry as never })
        return () => {}
      },
      register: (options: RegisteredSection['options'], render: unknown) => ({ options, render }),
    },
  }
  return { ctx, sections, disposers }
}

const fetchMock = vi.fn()

afterEach(() => {
  vi.unstubAllGlobals()
  innerApply.mockClear()
  fetchMock.mockReset()
})

describe('settings-panel client factory', () => {
  it('returns the dsh-login plugin waiting on slots and locale', () => {
    const plugin = factory(makeRequire())
    expect(plugin.name).toBe('dsh-login')
    expect(plugin.inject).toEqual(['slots', 'locale'])
  })

  it('applies the internal connection client verbatim', async () => {
    const { ctx } = makeCtx()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ username: 'root', isAdmin: true }) })
    await factory(makeRequire()).apply(ctx)
    expect(innerApply).toHaveBeenCalledTimes(1)
  })

  it('registers the admin 用户管理 section for admins', async () => {
    const { ctx, sections } = makeCtx()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ username: 'root', isAdmin: true }) })
    await factory(makeRequire()).apply(ctx)
    expect(sections).toHaveLength(1)
    expect(sections[0]!.options.id).toBe('users')
    expect(sections[0]!.options.order).toBe(25)
    expect(sections[0]!.options.label()).toBe('users.nav')
    // The wrapped component renders an element tree without throwing.
    const element = (sections[0]!.component as unknown as { render: (props: unknown) => unknown }).render(undefined)
    expect(element).toBeTypeOf('object')
  })

  it('registers the ordinary-user 账户 section for non-admins', async () => {
    const { ctx, sections } = makeCtx()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ username: 'bob', isAdmin: false }) })
    await factory(makeRequire()).apply(ctx)
    expect(sections).toHaveLength(1)
    expect(sections[0]!.options.id).toBe('account')
    expect(sections[0]!.options.label()).toBe('account.nav')
    const element = (sections[0]!.component as unknown as { render: (props: unknown) => unknown }).render(undefined)
    expect(element).toBeTypeOf('object')
  })

  it('registers nothing when the identity probe fails', async () => {
    const { ctx, sections } = makeCtx()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'authentication required' }) })
    await factory(makeRequire()).apply(ctx)
    expect(sections).toHaveLength(0)
    // The connection client still applied — the wire half must not depend
    // on the identity probe.
    expect(innerApply).toHaveBeenCalledTimes(1)
  })
})
