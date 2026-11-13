import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Functional smoke of the settings-panel client half
 * (src/settings-panel.client.js): the plain-JavaScript factory is evaluated
 * against a stub module table (React + primitives), the returned plugin is
 * applied over a fake Cordis context with a stubbed /api/auth/me fetch, and
 * the registered settings-section component renders an element tree for both
 * the admin and ordinary-user identities.
 *
 * Under option A (DSH ≥ 0.1.5-alpha.1) this half is a standalone dsh.client
 * contribution — it does NOT provide `connection` (the native connection row
 * owns /api), so it declares no hard dependency and registers the settings
 * section in a dependency fiber once slots + locale exist.
 */
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(repoRoot, 'src/settings-panel.client.js'), 'utf8')

/** Evaluate the panel source as a function expression, the way the bundle does. */
const factory = new Function(`return (${source})`)() as (require: (spec: string) => unknown) => {
  name: string
  inject: string[]
  apply: (ctx: unknown) => void
}

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
    throw new Error(`unexpected require: ${spec}`)
  })
}

interface RegisteredSection {
  options: { id: string; order: number; label: () => string }
  render: (props: unknown) => unknown
}

function makeCtx() {
  const sections: RegisteredSection[] = []
  const disposers: Array<() => void> = []
  const stats = { registered: 0, unregistered: 0 }
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
      // The inject factory evaluates a sync() state machine that (de)registers
      // entries live; its return value is the face dispose, not an entry.
      inject: (_slot: string, factory: () => unknown) => {
        void factory()
        return () => {}
      },
      register: (options: RegisteredSection['options'], render: unknown) => {
        const entry = { options, render } as unknown as RegisteredSection
        sections.push(entry)
        stats.registered++
        return () => {
          const index = sections.indexOf(entry)
          if (index >= 0) sections.splice(index, 1)
          stats.unregistered++
        }
      },
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
  return { ctx, sections, stats, disposers }
}

const fetchMock = vi.fn()

/** Drain enough microtask ticks for fetchMe()'s awaits + the .then chain. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

afterEach(() => {
  vi.unstubAllGlobals()
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

  it('aligned header structure is preserved (see layout guards above)', () => {
    // Keeping a lightweight structural assertion so the subgrid layout
    // invariants remain pinned even as the wire provision changes.
    expect(source).toContain('.dshlu-table { display: grid')
    expect(source).toContain('grid-template-columns: subgrid')
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
    const element = (sections[0]!.render as (props: unknown) => unknown)(undefined)
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
    const element = (sections[0]!.render as (props: unknown) => unknown)(undefined)
    expect(element).toBeTypeOf('object')
  })

  it('registers nothing when the identity probe fails', async () => {
    const { ctx, sections } = makeCtx()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'authentication required' }) })
    factory(makeRequire()).apply(ctx)
    await flush()
    expect(sections).toHaveLength(0)
  })
})

/** Expand function-typed component elements in place (the h() stub does not invoke them). */
function deepRender(node: unknown, depth = 0): unknown {
  if (depth > 12 || node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(c => deepRender(c, depth + 1))
  const el = node as { type: unknown; props: Record<string, unknown>; children?: unknown[] }
  const children = Array.isArray(el.children) ? el.children.map(c => deepRender(c, depth + 1)) : el.children
  if (typeof el.type === 'function') {
    const sub = (el.type as (props: unknown) => unknown)(el.props)
    return { type: el.type, props: el.props, children: [deepRender(sub, depth + 1)] }
  }
  return { type: el.type, props: el.props, children }
}

type El = { type: unknown; props: Record<string, unknown>; children?: unknown[] }
function collect(node: unknown, pred: (el: El) => boolean, out: El[] = []): El[] {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const c of node) collect(c, pred, out)
    return out
  }
  const el = node as El
  if (pred(el)) out.push(el)
  if (Array.isArray(el.children)) for (const c of el.children) collect(c, pred, out)
  return out
}

function sidebarInputs(tree: unknown): El[] {
  return collect(tree, el => el.type === 'input' && el.props['data-switch'] === 'sidebar')
}

describe('sidebar visibility toggle (侧边栏显示)', () => {
  it('hides 用户管理 and falls back to the 账户 section when usersSidebarVisible is false', async () => {
    const { ctx, sections } = makeCtx()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ username: 'root', isAdmin: true, usersSidebarVisible: false }) })
    factory(makeRequire()).apply(ctx)
    await flush()
    expect(sections).toHaveLength(1)
    expect(sections[0]!.options.id).toBe('account')
    expect(sections[0]!.options.label()).toBe('account.nav')
    // The admin fallback account panel carries the re-enable switch, initially off.
    const tree = deepRender((sections[0]!.render as (p: unknown) => unknown)(undefined))
    const inputs = sidebarInputs(tree)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.props.checked).toBe(false)
  })

  it('renders the 侧边栏显示 switch inside the admin users panel, never for ordinary users', async () => {
    const { ctx, sections } = makeCtx()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ username: 'root', isAdmin: true }) })
    factory(makeRequire()).apply(ctx)
    await flush()
    expect(sections).toHaveLength(1)
    const tree = deepRender((sections[0]!.render as (p: unknown) => unknown)(undefined))
    const inputs = sidebarInputs(tree)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]!.props.checked).toBe(true)
    // Ordinary users never get the switch.
    const bob = makeCtx()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ username: 'bob', isAdmin: false }) })
    factory(makeRequire()).apply(bob.ctx)
    await flush()
    const bobTree = deepRender((bob.sections[0]!.render as (p: unknown) => unknown)(undefined))
    expect(sidebarInputs(bobTree)).toHaveLength(0)
  })

  it('toggling the switch off unregisters 用户管理 and registers the 账户 fallback', async () => {
    const { ctx, sections, stats } = makeCtx()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockImplementation(async (url: unknown, init?: { method?: string }) => {
      const path = String(url)
      if (path === '/api/auth/me') return { ok: true, json: async () => ({ username: 'root', isAdmin: true }) }
      if (path === '/api/auth/admin/settings/sidebar' && (init?.method ?? 'GET') === 'POST') {
        // api() reads res.text() and parses JSON itself.
        return { ok: true, text: async () => JSON.stringify({ ok: true, enabled: false }) }
      }
      throw new Error('unexpected fetch: ' + path)
    })
    factory(makeRequire()).apply(ctx)
    await flush()
    expect(sections.map(s => s.options.id)).toEqual(['users'])
    const tree = deepRender((sections[0]!.render as (p: unknown) => unknown)(undefined))
    const input = sidebarInputs(tree)[0]!
    ;(input.props.onChange as (e: unknown) => void)({ target: { checked: false } })
    await flush()
    expect(sections.map(s => s.options.id)).toEqual(['account'])
    expect(stats.registered).toBe(2)
    expect(stats.unregistered).toBe(1)
  })
})
