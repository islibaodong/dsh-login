import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_HOST_LENGTH, canonicalAuthority, isBareAuthority, TrustedHosts } from '../src/hosts.ts'

const dirs: string[] = []
let fileCounter = 0

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-login-hosts-'))
  dirs.push(dir)
  fileCounter += 1
  return join(dir, 'hosts-' + String(fileCounter) + '.json')
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { }
  }
})

describe('TrustedHosts', () => {
  it('learn canonicalizes, is idempotent, and skips loopback/invalid', async () => {
    const hosts = new TrustedHosts(tmpFile())
    expect(hosts.learn('MyPub.Example.com')).toBe(true)
    expect(hosts.learn('mypub.example.com')).toBe(false)
    expect(hosts.learn('pub.example.com:3080')).toBe(true)
    expect(hosts.learn('127.0.0.1')).toBe(false)
    expect(hosts.learn('localhost')).toBe(false)
    expect(hosts.learn('not a host name with spaces')).toBe(false)
    expect(hosts.list().sort()).toEqual(['mypub.example.com', 'pub.example.com:3080'])
    await hosts.flush()
  })

  it('add/remove manage manual entries and remove is idempotent', async () => {
    const hosts = new TrustedHosts(tmpFile())
    expect(hosts.add('app.internal')).toBe(true)
    expect(hosts.add('app.internal')).toBe(false)
    expect(hosts.has('APP.Internal')).toBe(true)
    expect(hosts.add('127.0.0.1')).toBe(false) // loopback is always trusted; redundant
    expect(hosts.add('localhost')).toBe(false)
    expect(hosts.remove('app.internal')).toBe(true)
    expect(hosts.has('app.internal')).toBe(false)
    expect(hosts.remove('app.internal')).toBe(false)
    await hosts.flush()
  })

  it('persists learned hosts across a reload after flush', async () => {
    const file = tmpFile()
    const hosts = new TrustedHosts(file)
    hosts.learn('pub.example.com')
    expect(hosts.list()).toEqual(['pub.example.com'])
    await hosts.flush()
    const reloaded = new TrustedHosts(file)
    expect(reloaded.list()).toEqual(['pub.example.com'])
  })

  it('loads a corrupt or missing file as empty without throwing', async () => {
    const corrupt = tmpFile()
    writeFileSync(corrupt, '{ not valid json')
    expect(new TrustedHosts(corrupt).list()).toEqual([])
    const missing = new TrustedHosts(join(tmpdir(), 'definitely-missing-dir-x', 'x.json'))
    expect(missing.list()).toEqual([])
  })

  it('rejects non-bare inputs instead of silently broadening the grant', async () => {
    const hosts = new TrustedHosts(tmpFile())
    // Path / userinfo / query / password-style inputs must be REJECTED, not
    // silently re-written to the bare hostname (review #2).
    expect(hosts.learn('evil.com/path')).toBe(false)
    expect(hosts.learn('user@evil.com')).toBe(false)
    expect(hosts.learn('evil.com?query=1')).toBe(false)
    expect(hosts.add('evil.com/')).toBe(false)
    expect(hosts.add('user@evil.com')).toBe(false)
    expect(hosts.learn(' 127.0.0.1 ')).toBe(false)
    expect(hosts.list()).toEqual([])
    // isBareAuthority mirrors that judgement for the raw string.
    expect(isBareAuthority('evil.com/path')).toBe(false)
    expect(isBareAuthority('user@evil.com')).toBe(false)
    expect(isBareAuthority('Example.COM')).toBe(true)
  })

  it('learns and stores IPv6 authorities in canonical bracketed form', async () => {
    const hosts = new TrustedHosts(tmpFile())
    expect(hosts.learn('[2001:db8::1]')).toBe(true)
    expect(hosts.learn('[2001:db8::1]:8080')).toBe(true)
    expect(hosts.has('[2001:DB8::1]')).toBe(true)
    expect(hosts.list().sort()).toEqual(['[2001:db8::1]', '[2001:db8::1]:8080'])
    await hosts.flush()
  })

  it('enforces a maximum host length and does not trust overlong input', async () => {
    const hosts = new TrustedHosts(tmpFile())
    const long = 'a'.repeat(MAX_HOST_LENGTH + 1) + '.example.com'
    expect(isBareAuthority(long)).toBe(false)
    expect(hosts.learn(long)).toBe(false)
  })

  it('canonicalAuthority stays consistent with isTrustedApiRequest normalization', () => {
    // No port → bare lowercased hostname; any EXPLICIT port is kept verbatim
    // (hostname:port) — identical to the upstream api-request-trust normalizer,
    // so a learned entry matches the fence comparison exactly.
    expect(canonicalAuthority('Example.COM')).toBe('example.com')
    expect(canonicalAuthority('example.com:80')).toBe('example.com:80')
    expect(canonicalAuthority('example.com:443')).toBe('example.com:443')
    expect(canonicalAuthority('example.com:8080')).toBe('example.com:8080')
    expect(canonicalAuthority('MY.HOST:3080')).toBe('my.host:3080')
    expect(canonicalAuthority('example.com/path')).toBe('example.com')
    // ...which is exactly why isBareAuthority rejects the non-bare raw form.
    expect(isBareAuthority('example.com/path')).toBe(false)
  })
})
