import { defineConfig } from 'vitest/config'

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
    alias: {},
  },
})
