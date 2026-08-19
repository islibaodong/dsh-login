#!/usr/bin/env node
/**
 * Build the dsh-login browser client bundle (merge-gate Option A).
 *
 * The client-modules scanner discovers browser halves only from a package's
 * own `dsh.client` declaration + built `exports["./client"]` artifact, and
 * plugin bundles must be self-contained `window.__ModuleLoader__.load(...)`
 * closures (cross-plugin value imports are forbidden). Since
 * `src/connection.client.ts` re-exports the shipped connection client
 * verbatim (the takeover changes only the host-side carrier), the correct
 * browser bundle IS the shipped `@deepseek-ai/dsh-client-connection`
 * client bundle with the module-loader handoff id re-stamped to this
 * package — exactly what this script produces into dist/client.js.
 *
 * Bundle sources, in order:
 *   1. node_modules/@deepseek-ai/dsh-client-connection/lib/client.js (a real install)
 *   2. $DSH_HARNESS_CHECKOUT/packages/client/connection/lib/client.js
 *      (same convention as vitest.config.ts when running beside a checkout)
 *
 * Run after upgrading @deepseek-ai/dsh-client-connection: `node scripts/build-client.mjs`
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ID = '@islibaodong/dsh-login'
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

const source = readFileSync(shippedBundlePath(), 'utf8')

// The handoff id appears exactly once, in the banner:
//   window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-connection", factory: ...
const idPattern = new RegExp(`(window\\.__ModuleLoader__\\.load\\(\\{\\s*id:\\s*)"${SHIPPED_ID.replace(/\//g, '\\/')}"`)
if (!idPattern.test(source)) {
  throw new Error('shipped bundle does not carry the expected module-loader id banner — regenerate manually')
}
let out = source.replace(idPattern, `$1"${PACKAGE_ID}"`)
// The map is not re-stamped/shipped; drop the comment so devtools do not 404.
out = out.replace(/\n?\/\/# sourceMappingURL=client\.js\.map\n?$/, '\n')

const dest = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'client.js')
mkdirSync(dirname(dest), { recursive: true })
writeFileSync(dest, out)
console.log(`wrote ${dest} (${String(out.length)} chars) from ${shippedBundlePath()}`)
