import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

// The apiproxy contract layer is not among this checkout's linked DSH
// packages; resolve it straight to the harness checkout (test-only — at
// runtime the harness resolves the specifier through its own workspace).
const apiproxy = join(process.env.DSH_HARNESS_CHECKOUT ?? 'E:/code/deepseek-harness', 'packages/host/apiproxy')

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // Tests import .ts source files directly through tsx; first resolution
    // after a cold cache is slow on some hosts.
    testTimeout: 60_000,
  },
  resolve: {
    // Let DSH workspace packages resolve through their installed locations.
    // When running inside the DSH monorepo, pnpm symlinks make these resolve
    // to source; when standalone, they resolve to node_modules lib.
    alias: [
      { find: /^@deepseek-ai\/dsh-host-apiproxy\/api$/, replacement: join(apiproxy, 'lib/types/api/index.js') },
      { find: /^@deepseek-ai\/dsh-host-apiproxy$/, replacement: join(apiproxy, 'lib/index.js') },
    ],
  },
})
