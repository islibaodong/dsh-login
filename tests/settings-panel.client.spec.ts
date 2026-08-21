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
 *
 * The plugin is the boot graph's only `connection` provider, so the wire
 * discipline is asserted too: inject stays empty (a hard slots/locale wait
 * would deadlock — locale itself waits on connection) and the internal
 * connection client applies synchronously, before any identity probing.
 */
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(repoRoot, 'src/settings-panel.client.js'), 'utf8')

/** Evaluate the panel source as a function expression, the way the bundle does. */
const factory = new Function(`return (${source})`)() as (require: (spec: string) => unknown) => {
  name: string
  inject: string[]
  apply: (ctx: unknown) => void
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
  const base = {
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
  // Cordis dependency-fiber shape: ctx.inject(deps, callback) starts the
  // callback once the services exist. The stub resolves it immediately and
  // hands the same face to the callback.
  const ctx = {
    ...base,
    inject: (deps: string[], callback: (sub: typeof base) => void) => {
      expect(deps).toEqual(['slots', 'locale'])
      callback(base)
      return Promise.resolve()
    },
  }
  return { ctx, sections, disposers }
}

const fetchMock = vi.fn()

/** Drain enough microtask ticks for fetchMe()'s awaits + the .then chain. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

afterEach(() => {
  vi.unstubAllGlobals()
  innerApply.mockClear()
  fetchMock.mockReset()
})

describe('settings-panel client factory', () => {
  it('returns the wire-root dsh-login plugin with no hard dependencies', () => {
    const plugin = factory(makeRequire())
    expect(plugin.name).toBe('dsh-login')
    // Deadlock guard: this fiber provides `connection`; a hard inject on
    // anything (locale waits on connection transitively) stalls the whole
    // boot graph — exactly the 59-pending-entries failure mode.
    expect(plugin.inject).toEqual([])
  })

  it('aligns header with rows: one shared grid (subgrid), flexible tracks, no fixed widths, last-login replaces created', () => {
    // Layout guards for the 用户管理 table:
    // - header and rows must share ONE grid: .dshlu-table owns the column
    //   template and head/rows are subgrids spanning it. Per-row grids
    //   were the misalignment bug — max-content tracks (状态/操作) sized
    //   to each container's own content (~30px labels vs ~250px buttons),
    //   so the header columns landed nowhere near the body's;
    // - only status + actions may be content-sized (max-content tracks);
    //   name and last-login are flexible (minmax(0, …)) so a row can
    //   never overflow the panel;
    // - the actions cell must not wrap and no cell may span columns;
    // - the redundant role column is gone and the audit column is last
    //   login, never creation.
    expect(source).toContain('.dshlu-table { display: grid')
    expect(source).toContain('grid-template-columns: subgrid')
    expect(source).toContain('grid-column: 1 / -1')
    // The 1/-1 span belongs to the subgridded head/row — never to a cell.
    expect(source.match(/dshlu-cell[^}]*grid-column/)).toBeNull()
    expect(source).toContain('grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) max-content max-content')
    // No px-valued grid tracks anywhere in the stylesheet.
    expect(source.match(/grid-template-columns:[^;]*\d+px[^;]*;/)).toBeNull()
    expect(source).toContain('.dshlu-cell--actions { display: flex; flex-wrap: nowrap;')
    expect(source).toContain("'col.lastLogin'")
    expect(source).toContain("'status.never'")
    expect(source).not.toContain("'col.created'")
    expect(source).not.toContain("'col.role'")
    expect(source).not.toContain('u.createdAt')
    // Narrow viewports drop the last-login column instead of squeezing.
    expect(source).toContain('@media (max-width: 620px)')
  })

  it('applies the internal connection client synchronously, before any probe', () => {
    const { ctx } = makeCtx()
    vi.stubGlobal('fetch', fetchMock)
    // A stalled identity probe (never resolving) must not delay connection.
    fetchMock.mockReturnValue(new Promise(() => {}))
    factory(makeRequire()).apply(ctx)
    expect(innerApply).toHaveBeenCalledTimes(1)
  })

  it('registers the admin 用户管理 section for admins', async () => {
    const { ctx, sections } = makeCtx()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ username: 'root', isAdmin: true }) })
    factory(makeRequire()).apply(ctx)
    await flush()
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
    factory(makeRequire()).apply(ctx)
    await flush()
    expect(sections).toHaveLength(1)
    expect(sections[0]!.options.id).toBe('account')
    expect(sections[0]!.options.label()).toBe('account.nav')
    const element = (sections[0]!.component as unknown as { render: (props: unknown) => unknown }).render(undefined)
    expect(element).toBeTypeOf('object')
  })

  it('registers nothing when the identity probe fails (connection still applied)', async () => {
    const { ctx, sections } = makeCtx()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'authentication required' }) })
    factory(makeRequire()).apply(ctx)
    await flush()
    expect(sections).toHaveLength(0)
    // The connection client still applied — the wire half must not depend
    // on the identity probe.
    expect(innerApply).toHaveBeenCalledTimes(1)
  })
})
