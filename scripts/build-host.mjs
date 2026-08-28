#!/usr/bin/env node

import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entries = [
  ['src/index.ts', 'dist/index.js'],
  ['src/connection.ts', 'dist/connection.js'],
  ['src/connection.client.ts', 'dist/connection-client.js'],
]

await mkdir(resolve(repoRoot, 'dist'), { recursive: true })

for (const [, output] of entries) {
  await rm(resolve(repoRoot, output), { force: true })
  await rm(resolve(repoRoot, `${output}.map`), { force: true })
}

for (const [entry, output] of entries) {
  await build({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    outfile: output,
    bundle: true,
    external: ['@deepseek-ai/*', 'ws'],
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: true,
    legalComments: 'none',
    logLevel: 'info',
  })
}
