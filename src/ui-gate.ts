/**
 * Whole-UI per-role gating: filter the rendered index's boot graph so an
 * ordinary user's shell never activates admin-only client bundles.
 *
 * Mechanism (verified against DSH 0.2.1-alpha.1, see
 * docs/adapt-dsh-0.2.0-rc.2.md §6 and docs/adapt-dsh-0.2.1-alpha.1.md):
 *
 *  1. The harness composes `window.__DSH_BOOT__` (WebBootGraph: { rev,
 *     entries: WebBootEntry[], batches: WebBootBatch[] }) and serves it as a
 *     structured injection row — `<script>globalThis["__DSH_BOOT__"] = <json
 *     with `<` escaped as \u003c></script>` (packages/host/webserver/src/
 *     injections.ts renderRow). dsh-login's gateway holds that rendered HTML
 *     per request, so the graph is ours to edit before it ships.
 *  2. The browser parses the graph with parseBootManifest and the page
 *     controller creates exactly one cordis entry per `entries` row
 *     (packages/client/modules/src/client/entries.ts start(): `desired.plugins
 *     .map(({id}) => create(loader, id))`), removing managed entries absent
 *     from the roster. Activation roster == graph.entries. No bypass.
 *  3. Therefore dropping a bundle's row from `entries` — and, because
 *     parseBootManifest requires every batch entry to name a known graph
 *     entry with non-empty batch entry lists, patching the owning batch's
 *     `entries` and dropping batches that become empty — prevents that
 *     plugin's UI from ever activating in the user's session.
 *
 * Boundaries (deliberate):
 *  - Presentation only. The combo scripts referenced by batch rows still
 *    download and register factories (harmless: registration is lazy and
 *    nothing materializes an un-manifested module). The security boundary
 *    stays the /api allow-list (apiBridgeAuth + USER_ALLOWED) and the remote
 *    isolation guard; an ordinary user who hand-crafts /api calls gains no
 *    method this gate removed from the page.
 *  - Per-package granularity. Hiding one slot/section inside an allowed
 *    bundle is out of scope (that needs dsh-login's own client half to wrap
 *    the slot registry).
 *  - Dev-mode caveat: a dev rebuild pushes a full `{type:'graph'}` HMR frame
 *    and the page re-syncs the complete roster (gate bypasses itself in
 *    `pnpm run dev:web` sessions only).
 *
 * Failure posture is fail-open on the PAGE (serve the unfiltered graph) but
 * never on the API: if the embedded graph is missing, malformed, or not the
 * expected shape, the original HTML is served unchanged and upstream
 * validation behaves exactly as before. The gate must never be the thing
 * that breaks a boot.
 */

import { ADMIN_ONLY_UI_PLUGINS } from './capabilities.ts'

/**
 * The exact marker the webserver renders for the boot-graph global row
 * (packages/host/webserver/src/injections.ts): `globalThis[<json-quoted
 * name>] = <json value>` inside a `<script>` element. `JSON.stringify`
 * never emits a literal `<` here because upstream escapes `<` to `\u003c`
 * inside the value and the name carries none.
 */
const BOOT_MARKER = '<script>globalThis["__DSH_BOOT__"] = '

/** Structural minimum the filter understands (mirrors WebBootGraph). */
interface GraphShape {
  rev: unknown
  entries: unknown
  batches: unknown
}

interface EntryShape {
  id: unknown
  inject?: unknown
  external?: unknown
}

interface BatchShape {
  entries: unknown
}

/**
 * Client bundle ids an ordinary user must not activate. The deny-list, not an
 * allow-list: everything not listed stays mounted, so user-facing community
 * plugins keep working and only the known admin-only surfaces are gated.
 */
const DENIED_IDS: ReadonlySet<string> = new Set(ADMIN_ONLY_UI_PLUGINS)

/**
 * Filter a decoded WebBootGraph down to the entries an ordinary user may
 * activate. Pure function over the decoded JSON — unit tests exercise this
 * directly, without HTML.
 *
 * @param graph - the JSON-decoded `window.__DSH_BOOT__` value.
 * @returns the filtered graph (same field order, extra fields preserved),
 *   or `null` when the value is not a graph this module understands — the
 *   caller then serves the original HTML unchanged.
 */
export function filterBootGraph(graph: unknown): Record<string, unknown> | null {
  if (typeof graph !== 'object' || graph === null) return null
  const shape = graph as GraphShape
  if (typeof shape.rev !== 'string' || !Array.isArray(shape.entries) || !Array.isArray(shape.batches)) {
    return null
  }
  // Fail-open: any row not shaped as expected means the wire changed since
  // verification — serve the original graph rather than guess.
  const kept: Record<string, unknown>[] = []
  const removed = new Set<string>()
  for (const row of shape.entries) {
    if (typeof row !== 'object' || row === null) return null
    const entry = row as EntryShape
    if (typeof entry.id !== 'string') return null
    if (DENIED_IDS.has(entry.id)) {
      removed.add(entry.id)
      continue
    }
    kept.push(row as Record<string, unknown>)
  }
  // Validate every batch row before deciding anything: the no-op fast path
  // below must not skip the shape contract (a malformed batch row is a
  // fail-open signal regardless of whether any entry matched the deny-list).
  const batches: Record<string, unknown>[] = []
  for (const row of shape.batches) {
    if (typeof row !== 'object' || row === null) return null
    const batch = row as BatchShape
    if (!Array.isArray(batch.entries) || batch.entries.some(id => typeof id !== 'string')) return null
  }
  if (removed.size === 0) return graph as Record<string, unknown>
  // A kept bundle must not depend on a gated one: core packages never inject
  // admin-only plugins, but if a future composition does, refuse to guess.
  for (const row of kept) {
    for (const field of ['inject', 'external'] as const) {
      const value = row[field]
      if (value === undefined) continue
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return null
      if (value.some(item => removed.has(item) || removed.has(stripClient(item)))) return null
    }
  }
  for (const row of shape.batches) {
    const batch = row as BatchShape
    const remaining = batch.entries.filter(id => typeof id === 'string' && !removed.has(id))
    // Upstream guarantees every entry sits in exactly one batch; a batch left
    // empty by the filter drops out of the graph entirely. Its HTML script /
    // preload row is left in place — an orphan combo script only registers
    // factories nothing materializes.
    if (remaining.length === 0) continue
    batches.push(
      remaining.length === batch.entries.length
        ? row as Record<string, unknown>
        : { ...(row as Record<string, unknown>), entries: remaining },
    )
  }
  // Spread preserves `rev` and any future top-level fields; entries/batches
  // replace the filtered arrays. Field order matches upstream (rev, entries,
  // batches) because entries/batches already exist in the spread source.
  return { ...(graph as Record<string, unknown>), entries: kept, batches }
}

/** `<pkg>/client` aliases the bare package in `external` specifiers. */
function stripClient(spec: string): string {
  return spec.endsWith('/client') ? spec.slice(0, -'/client'.length) : spec
}

/**
 * Gate the rendered index HTML for an ordinary user: rewrite the
 * `__DSH_BOOT__` global so admin-only client bundles never activate.
 *
 * Every failure mode (marker absent, JSON malformed, unexpected graph shape)
 * returns the input unchanged — the served page is never worse than without
 * the gate.
 *
 * @param html - the fully rendered index HTML (webserver.renderIndex output).
 * @returns the HTML with the boot graph filtered, or the input HTML.
 */
export function applyUiGate(html: string): string {
  const start = html.indexOf(BOOT_MARKER)
  if (start === -1) return html
  const jsonStart = start + BOOT_MARKER.length
  // The JSON value cannot contain a literal `</script>`: upstream escapes
  // every `<` inside the value, so the first closer terminates the element.
  const end = html.indexOf('</script>', jsonStart)
  if (end === -1) return html
  const raw = html.slice(jsonStart, end)
  let graph: unknown
  try {
    graph = JSON.parse(raw)
  } catch {
    return html
  }
  const filtered = filterBootGraph(graph)
  if (filtered === null) return html
  // Re-escape `<` exactly like the upstream renderer so the rebuilt element
  // is byte-compatible with what the webserver would have produced.
  const rebuilt = JSON.stringify(filtered).replaceAll('<', '\\u003c')
  return `${html.slice(0, jsonStart)}${rebuilt}${html.slice(end)}`
}
