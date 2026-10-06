import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import { orderByModuleGraph, stripClientSuffix } from '@deepseek-ai/dsh-client-modules'
import { filterBootGraph, applyUiGate } from '../src/ui-gate.ts'
import { ADMIN_ONLY_UI_PLUGINS } from '../src/capabilities.ts'
import { SessionStore } from '../src/session.ts'
import { createGatewayHandler } from '../src/gateway.ts'
import type { Config } from '../src/config.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CORE = '@deepseek-ai/dsh-client-modules'
const SHELL = '@deepseek-ai/dsh-web-app'
const CONNECTION = '@deepseek-ai/dsh-client-connection'
const USER_PLUGIN = '@community/dsh-genui'
const ADMIN_A = ADMIN_ONLY_UI_PLUGINS[0] // e.g. the plugin-manager client half
const ADMIN_B = '@linxin666/dsh-pet'

/** A realistic boot graph: bootstrap batch, mixed application batch, and an admin-only batch. */
function fixtureGraph(): Record<string, unknown> {
  return {
    rev: 'graph-rev-1',
    entries: [
      { id: CORE, url: 'combo/core.js', rev: 'r1' },
      { id: SHELL, url: 'combo/shell.js', rev: 'r2', inject: [CORE], external: [`${CONNECTION}/client`] },
      { id: CONNECTION, url: 'combo/connection.js', rev: 'r3' },
      { id: USER_PLUGIN, url: 'combo/genui.js', rev: 'r4' },
      { id: ADMIN_A, url: 'combo/admin-a.js', rev: 'r5', immediately: true },
      { id: ADMIN_B, url: 'combo/pet.js', rev: 'r6' },
    ],
    batches: [
      { phase: 'bootstrap', url: 'combo/bootstrap.js', rev: 'b1', entries: [CORE] },
      { phase: 'application', url: 'combo/app.js', rev: 'b2', entries: [SHELL, CONNECTION, USER_PLUGIN, ADMIN_A] },
      { phase: 'application', url: 'combo/pet.js', rev: 'b3', entries: [ADMIN_B] },
    ],
  }
}

/** The exact markup the upstream renderer produces around the graph global. */
function renderIndexHtml(graph: unknown): string {
  const json = JSON.stringify(graph).replaceAll('<', '\\u003c')
  return [
    '<html><head>',
    '<script>window.__ModuleLoader__={mode:"queue"}</script>',
    '<link rel="preload" as="script" href="combo/app.js">',
    '<script src="combo/bootstrap.js"></script>',
    `<script>globalThis["__DSH_BOOT__"] = ${json}</script>`,
    '</head><body>shell</body></html>',
  ].join('')
}

/** Extract the JSON carried by the served `__DSH_BOOT__` global. */
function servedGraph(html: string): Record<string, unknown> {
  const marker = '<script>globalThis["__DSH_BOOT__"] = '
  const start = html.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const end = html.indexOf('</script>', start)
  return JSON.parse(html.slice(start + marker.length, end)) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// filterBootGraph (pure)
// ---------------------------------------------------------------------------

describe('filterBootGraph', () => {
  it('removes denied entries, patches batches, drops emptied batches, keeps rev', () => {
    const graph = fixtureGraph()
    const out = filterBootGraph(graph)
    expect(out).not.toBeNull()
    expect(out!.rev).toBe('graph-rev-1')
    const ids = (out!.entries as { id: string }[]).map(row => row.id)
    expect(ids).toEqual([CORE, SHELL, CONNECTION, USER_PLUGIN])
    expect(ids).not.toContain(ADMIN_A)
    expect(ids).not.toContain(ADMIN_B)
    const batches = out!.batches as { phase: string; url: string; rev: string; entries: string[] }[]
    expect(batches).toHaveLength(2) // the admin-only pet batch is gone
    expect(batches[0]).toEqual({ phase: 'bootstrap', url: 'combo/bootstrap.js', rev: 'b1', entries: [CORE] })
    expect(batches[1].entries).toEqual([SHELL, CONNECTION, USER_PLUGIN])
    expect(batches[1].url).toBe('combo/app.js')
    expect(batches[1].rev).toBe('b2')
  })

  it('accepts the filtered graph with the upstream module-graph orderer', () => {
    const graph = fixtureGraph()
    const out = filterBootGraph(graph)!
    // NOTE: the shipped @deepseek-ai/dsh-client-modules 0.2.1-alpha.1 lib does
    // NOT export parseBootManifest (lib/index.js export list omits it despite
    // lib/types/index.d.ts:19 promising it) — so the closest shipped runtime
    // acceptance is orderByModuleGraph: it throws on dependency cycles and on
    // external rows referencing packages absent from the graph.
    const ordered = orderByModuleGraph(out.entries as { id: string; external?: string[] }[])
    // SHELL depends on CONNECTION via its `external` row, so the orderer sinks
    // it behind CONNECTION; only membership matters for the gate.
    expect(new Set(ordered.map(row => row.id))).toEqual(new Set([CORE, SHELL, CONNECTION, USER_PLUGIN]))
    expect(() => orderByModuleGraph(graph.entries as { id: string; external?: string[] }[])).not.toThrow()
  })

  it('returns the same object when nothing is denied', () => {
    const graph = fixtureGraph()
    const admin = {
      ...graph,
      entries: (graph.entries as unknown[]).map(row => ({ ...(row as object), id: `x-${(row as { id: string }).id}` })),
    }
    // Nothing matches the deny-list after renaming → no-op.
    expect(filterBootGraph(admin)).toBe(admin)
  })

  it('keeps a fully-removed batch out but preserves the graph shape (idempotent)', () => {
    const graph = fixtureGraph()
    const once = filterBootGraph(graph)!
    const twice = filterBootGraph(once)!
    expect(twice).toEqual(once)
  })

  it('fails open (null) when the graph is not the verified shape', () => {
    expect(filterBootGraph(undefined)).toBeNull()
    expect(filterBootGraph('nope')).toBeNull()
    expect(filterBootGraph({})).toBeNull()
    expect(filterBootGraph({ rev: 7, entries: [], batches: [] })).toBeNull()
    expect(filterBootGraph({ rev: 'r', entries: 'nope', batches: [] })).toBeNull()
    expect(filterBootGraph({ rev: 'r', entries: [null], batches: [] })).toBeNull()
    expect(filterBootGraph({ rev: 'r', entries: [{ id: 5 }], batches: [] })).toBeNull()
    expect(filterBootGraph({ rev: 'r', entries: [], batches: [null] })).toBeNull()
    expect(filterBootGraph({ rev: 'r', entries: [], batches: [{ entries: 'nope' }] })).toBeNull()
    expect(filterBootGraph({ rev: 'r', entries: [], batches: [{ entries: [7] }] })).toBeNull()
  })

  it('fails open when a kept bundle still depends on a gated one', () => {
    const graph = {
      rev: 'r',
      entries: [
        { id: SHELL, url: 'a.js', rev: '1', inject: [ADMIN_B] },
        { id: ADMIN_B, url: 'b.js', rev: '2' },
      ],
      batches: [{ phase: 'application', url: 'c.js', rev: '3', entries: [SHELL, ADMIN_B] }],
    }
    expect(filterBootGraph(graph)).toBeNull()
  })

  it('matches the `<pkg>/client` external alias of a gated package', () => {
    const graph = {
      rev: 'r',
      entries: [
        { id: SHELL, url: 'a.js', rev: '1', external: [`${ADMIN_B}/client`] },
        { id: ADMIN_B, url: 'b.js', rev: '2' },
      ],
      batches: [{ phase: 'application', url: 'c.js', rev: '3', entries: [SHELL, ADMIN_B] }],
    }
    expect(filterBootGraph(graph)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// applyUiGate (HTML round-trip)
// ---------------------------------------------------------------------------

describe('applyUiGate', () => {
  it('rewrites only the boot-graph global inside the rendered index', () => {
    const html = renderIndexHtml(fixtureGraph())
    const out = applyUiGate(html)
    expect(out).not.toBe(html)
    expect(out).toContain('<link rel="preload" as="script" href="combo/app.js">')
    expect(out).toContain('<script src="combo/bootstrap.js"></script>')
    expect(out).toContain('<body>shell</body>')
    const served = servedGraph(out)
    const ids = (served.entries as { id: string }[]).map(row => row.id)
    expect(ids).toEqual([CORE, SHELL, CONNECTION, USER_PLUGIN])
    expect(out).not.toContain(`"${ADMIN_B}"`)
  })

  it('leaves HTML without the marker untouched', () => {
    const html = '<html><body>plain</body></html>'
    expect(applyUiGate(html)).toBe(html)
  })

  it('fails open on malformed or foreign graph payloads', () => {
    const malformed = '<html><head><script>globalThis["__DSH_BOOT__"] = {not json</script></head></html>'
    expect(applyUiGate(malformed)).toBe(malformed)
    const foreign = renderIndexHtml({ marker: true })
    expect(applyUiGate(foreign)).toBe(foreign)
    const unterminated = '<html><head><script>globalThis["__DSH_BOOT__"] = {"rev":"r"'
    expect(applyUiGate(unterminated)).toBe(unterminated)
  })

  it('is idempotent over an already-gated page', () => {
    const once = applyUiGate(renderIndexHtml(fixtureGraph()))
    expect(applyUiGate(once)).toBe(once)
  })

  it('re-escapes `<` in the rebuilt JSON exactly like the upstream renderer', () => {
    const graph = {
      rev: 'r',
      entries: [{ id: SHELL, url: 'a<b.js', rev: '1' }],
      batches: [{ phase: 'application', url: 'a<b.js', rev: '2', entries: [SHELL] }],
    }
    const out = applyUiGate(renderIndexHtml(graph))
    expect(out).not.toContain('</scr' + 'ipt>globalThis') // structural sanity
    expect(out).toContain('\\u003cb.js')
    expect(out).not.toContain('<b.js')
    // And the served value still parses back to the original strings.
    const served = servedGraph(out)
    expect((served.entries as { url: string }[])[0].url).toBe('a<b.js')
  })
})

// ---------------------------------------------------------------------------
// Gateway integration: the served index for an ordinary user is gated
// ---------------------------------------------------------------------------

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function bootGateway(indexHtml: string, config: Config): Promise<{ port: number; store: SessionStore }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-ui-gate-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['@deepseek-ai/dsh-host-webserver', HttpServer]])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  const dist = join(root, 'dist')
  await mkdir(dist, { recursive: true })
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, indexHtml)
  const store = new SessionStore(3600)
  const handler = createGatewayHandler(context, { ...config, distIndex }, store)
  context.effect(() => context!.webServer.registerFallback(handler), 'gateway')
  return { port: context.webServer.port, store }
}

async function request(port: number, path: string, cookie?: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    redirect: 'manual',
    headers: cookie === undefined ? {} : { Cookie: `dsh_session=${cookie}` },
  })
  return { status: response.status, body: await response.text() }
}

const baseConfig: Config = {
  password: 'DSH_LOGIN_PASSWORD',
  distIndex: '',
  sessionTtl: 3600,
  enabled: true,
} as unknown as Config

describe('gateway uiRoleGate', () => {
  it('serves a filtered boot graph to an ordinary user', { timeout: 60_000 }, async () => {
    const { port, store } = await bootGateway(renderIndexHtml(fixtureGraph()), { ...baseConfig, uiRoleGate: true })
    const session = store.create('bob', false)
    const res = await request(port, '/', session.token)
    expect(res.status).toBe(200)
    const served = servedGraph(res.body)
    const ids = (served.entries as { id: string }[]).map(row => row.id)
    expect(ids).toEqual([CORE, SHELL, CONNECTION, USER_PLUGIN])
    expect(res.body).not.toContain(`"${ADMIN_B}"`)
  })

  it('serves the full boot graph to an admin', { timeout: 60_000 }, async () => {
    const { port, store } = await bootGateway(renderIndexHtml(fixtureGraph()), { ...baseConfig, uiRoleGate: true })
    const session = store.create('alice', true)
    const res = await request(port, '/', session.token)
    expect(res.status).toBe(200)
    const ids = (servedGraph(res.body).entries as { id: string }[]).map(row => row.id)
    expect(ids).toContain(ADMIN_A)
    expect(ids).toContain(ADMIN_B)
  })

  it('serves the full boot graph when the gate is off', { timeout: 60_000 }, async () => {
    const { port, store } = await bootGateway(renderIndexHtml(fixtureGraph()), { ...baseConfig, uiRoleGate: false })
    const session = store.create('bob', false)
    const res = await request(port, '/', session.token)
    expect(res.status).toBe(200)
    const ids = (servedGraph(res.body).entries as { id: string }[]).map(row => row.id)
    expect(ids).toContain(ADMIN_B)
  })

  it('still redirects an unauthenticated request to /login', { timeout: 60_000 }, async () => {
    const { port } = await bootGateway(renderIndexHtml(fixtureGraph()), { ...baseConfig, uiRoleGate: true })
    const res = await request(port, '/')
    expect(res.status).toBe(302)
  })
})
