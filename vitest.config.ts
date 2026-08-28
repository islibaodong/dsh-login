import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // Tests import .ts source files directly through tsx; first resolution
    // after a cold cache is slow on some hosts.
    testTimeout: 60_000,
  },
})
