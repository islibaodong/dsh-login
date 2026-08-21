#!/usr/bin/env node
/**
 * Build the dsh-login browser client bundle (merge-gate Option A + settings
 * panel).
 *
 * The client-modules scanner discovers browser halves only from a package's
 * own `dsh.client` declaration + built `exports["./client"]` artifact, and
 * plugin bundles must be self-contained `window.__ModuleLoader__.load(...)`
 * closures (cross-plugin value imports are forbidden). Since
 * `src/connection.client.ts` re-exports the shipped connection client
 * verbatim (the takeover changes only the host-side carrier), the wire half
 * of the bundle IS the shipped `@deepseek-ai/dsh-client-connection` client
 * bundle — with the module-loader handoff id re-stamped to the internal id
 * `@islibaodong/dsh-login/connection`.
 *
 * On top of that, the file carries a SECOND registration under the package's
 * graph-row id `@islibaodong/dsh-login`: a wrapper factory that materializes
 * the internal connection half via the same-file require and returns one
 * Cordis plugin applying both the wire client and the 设置-用户管理 settings
 * section (`src/settings-panel.client.js`, appended verbatim — plain
 * JavaScript, no transform). A bundle file may register multiple factories;
 * the module system only requires the graph-row id to be among them.
 *
 * Bundle sources, in order:
 *   1. node_modules/@deepseek-ai/dsh-client-connection/lib/client.js (a real install)
 *   2. $DSH_HARNESS_CHECKOUT/packages/client/connection/lib/client.js
 *      (same convention as vitest.config.ts when running beside a checkout)
 *
 * Run after upgrading @deepseek-ai/dsh-client-connection or editing
 * src/settings-panel.client.js: `npm run build:client`
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ID = '@islibaodong/dsh-login'
const INTERNAL_CONNECTION_ID = `${PACKAGE_ID}/connection`
const SHIPPED_ID = '@deepseek-ai/dsh-client-connection'

function shippedBundlePath() {
  try {
    const require = createRequire(import.meta.url)
    return dirname(require.resolve(`${SHIPPED_ID}/package.json`)).replaceAll('\\', '/') + '/lib/client.js'
  } catch { /* not installed — fall through to the harness checkout */ }
  const checkout = process.env.DSH_HARNESS_CHECKOUT ?? 'E:/code/deepseek-harness'
  const candidate = resolve(checkout, 'packages/client/connection/lib/client.js')
  if (!existsSync(candidate)) throw new Error(`cannot locate the shipped connection bundle (tried node_modules and ${candidate})`)
  return candidate.replaceAll('\\', '/')
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(shippedBundlePath(), 'utf8')

// The handoff id appears exactly once, in the banner:
//   window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-connection", factory: ...
// Re-stamp it to the internal id the wrapper requires (same-file factory).
const idPattern = new RegExp(`(window\\.__ModuleLoader__\\.load\\(\\{\\s*id:\\s*)"${SHIPPED_ID.replace(/\//g, '\\/')}"`)
if (!idPattern.test(source)) {
  throw new Error('shipped bundle does not carry the expected module-loader id banner — regenerate manually')
}
let out = source.replace(idPattern, `$1"${INTERNAL_CONNECTION_ID}"`)
// The map is not re-stamped/shipped; drop the comment so devtools do not 404.
out = out.replace(/\n?\/\/# sourceMappingURL=client\.js\.map\n?$/, '\n')

// The settings-panel wrapper: appended verbatim as a second registration.
// The source file is a bare `function (require) { ... }` expression preceded
// by its header comment; parenthesizing it keeps both valid.
const panelSource = readFileSync(join(repoRoot, 'src/settings-panel.client.js'), 'utf8')
if (!panelSource.includes('settings.section') || !panelSource.includes(`require('${INTERNAL_CONNECTION_ID}')`)) {
  throw new Error('src/settings-panel.client.js does not look like the dsh-login settings panel (missing settings.section or the internal connection require)')
}
out += `\n;window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: function (require) { return (${panelSource})(require); } });\n`

if (!out.includes(`id: ${JSON.stringify(INTERNAL_CONNECTION_ID)}`) || !out.includes(`id: ${JSON.stringify(PACKAGE_ID)}`)) {
  throw new Error('bundle sanity check failed — expected both module registrations present')
}

const dest = resolve(repoRoot, 'dist', 'client.js')
mkdirSync(dirname(dest), { recursive: true })
writeFileSync(dest, out)
console.log(`wrote ${dest} (${String(out.length)} chars) from ${shippedBundlePath()} + src/settings-panel.client.js`)
