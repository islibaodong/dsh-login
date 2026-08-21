import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Merge-gate guard (Task 6): the dsh-login package must ship a self-sufficient
 * browser bundle so that disabling the shipped `connection` row in
 * cordis.patch.yml does not leave the GUI without its /api wire client.
 * The client-modules scanner discovers browser halves only from a package's
 * own `dsh.client` declaration + built `exports["./client"]` artifact
 * (packages/client/modules/src/index.ts resolveMeta/processOne).
 */
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  exports: Record<string, unknown>
  dsh: { client?: { platform?: string; inject?: string[] } }
}

describe('dsh-login browser client bundle (merge gate, Option A)', () => {
  it('declares dsh.client for the web platform', () => {
    expect(pkg.dsh.client).toBeDefined()
    expect(pkg.dsh.client!.platform).toBe('web')
    expect(Array.isArray(pkg.dsh.client!.inject)).toBe(true)
  })

  it('exports a built ./client bundle', () => {
    const client = pkg.exports['./client']
    expect(typeof client).toBe('string')
    const bundle = readFileSync(join(repoRoot, client as string), 'utf8')
    // Module-loader handoff stamped with dsh-login's package id (the scanner
    // keys boot-graph rows by the entry/package name).
    expect(bundle).toContain('window.__ModuleLoader__.load')
    expect(bundle).toContain('"@islibaodong/dsh-login"')
  })

  it('is self-contained: no cross-plugin require of the shipped connection bundle', () => {
    const client = pkg.exports['./client'] as string
    const bundle = readFileSync(join(repoRoot, client), 'utf8')
    expect(bundle).not.toContain("require('@deepseek-ai/dsh-client-connection")
    expect(bundle).not.toContain('require("@deepseek-ai/dsh-client-connection')
  })

  it('carries the settings-panel wrapper as a second registration', () => {
    const client = pkg.exports['./client'] as string
    const bundle = readFileSync(join(repoRoot, client), 'utf8')
    // Two registrations total: the re-stamped wire half (multi-line banner
    // in the shipped bundle) and the single-line wrapper appended after it.
    expect(bundle.match(/window\.__ModuleLoader__\.load\(/g)).toHaveLength(2)
    // The shipped wire half is re-stamped to the internal id the wrapper
    // materializes through the same-file require.
    expect(bundle).toContain('id: "@islibaodong/dsh-login/connection"')
    // The graph-row registration wraps it and carries the settings panel.
    expect(bundle).toContain('window.__ModuleLoader__.load({ id: "@islibaodong/dsh-login"')
    expect(bundle).toContain("require('@islibaodong/dsh-login/connection')")
    expect(bundle).toContain('settings.section')
    expect(bundle).toContain('/api/auth/admin/users/disable')
    // Theme-following styles: the panel must skin via --dsw-alias-* tokens.
    expect(bundle).toContain('--dsw-alias-label-primary')
    expect(bundle).toContain('--dsw-alias-border-l2')
  })

  it('declares the settings-panel service needs in dsh.client.inject', () => {
    expect(pkg.dsh.client!.inject).toContain('slots')
    expect(pkg.dsh.client!.inject).toContain('locale')
  })
})
