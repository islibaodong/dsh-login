// Compatibility entry point for the canonical HTTP integration tests.
// Run `npm ci` first. DSH dependencies resolve from the lockfile rather than
// a moving harness checkout; the multi-user API has one set of test cases.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const result = spawnSync(process.execPath, [
  vitest,
  'run',
  'tests/gateway.spec.ts',
  'tests/login-api.spec.ts',
  'tests/plugin-entry.spec.ts',
], { cwd: repoRoot, stdio: 'inherit' })

if (result.error !== undefined) throw result.error
process.exit(result.status ?? 1)
