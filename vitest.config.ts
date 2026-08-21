import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

const checkout = process.env.DSH_HARNESS_CHECKOUT ?? 'E:/code/deepseek-harness'
// The apiproxy contract layer is not among this checkout's linked DSH
// packages; resolve it straight to the harness checkout (test-only - at
// runtime the harness resolves the specifier through its own workspace).
const apiproxy = join(checkout, 'packages/host/apiproxy')
// Same treatment for the client connection carrier (bridge, trust fence,
// WebSocket downlinks): not linked into this checkout's node_modules.
const connection = join(checkout, 'packages/client/connection')
// Webserver + frontend-static ARE linked into node_modules, but the link
// resolves through package exports to their built lib/ - which can lag the
// checkout's sources after a git pull (e.g. 0.1.1-rc.1 sources with
// 0.1.0-rc.8 libs). The gateway's index-rendering behavior differs between
// those two versions, so tests must run against the real current sources,
// same as tsconfig.json's paths.
const webserver = join(checkout, 'packages/host/webserver')
const frontendStatic = join(checkout, 'packages/host/frontend-static')

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
      { find: /^@deepseek-ai\/dsh-client-connection\/src$/, replacement: join(connection, 'src/index.ts') },
      { find: /^@deepseek-ai\/dsh-client-connection\/src\/(.+)$/, replacement: join(connection, 'src') + '/$1' },
      { find: /^@deepseek-ai\/dsh-host-webserver$/, replacement: join(webserver, 'src/index.ts') },
      { find: /^@deepseek-ai\/dsh-host-frontend-static$/, replacement: join(frontendStatic, 'src/index.ts') },
    ],
  },
})
