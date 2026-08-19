import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OwnershipIndex } from '../src/ownership.ts'

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-login-own-')), 'ownership.json')
}

describe('OwnershipIndex', () => {
  it('records and looks up', () => {
    const idx = new OwnershipIndex(tmpFile())
    idx.record('s1', 'alice')
    expect(idx.lookup('s1')).toBe('alice')
    expect(idx.lookup('s2')).toBeUndefined()
  })

  it('persists through flush and reloads in a new instance', async () => {
    const file = tmpFile()
    const idx = new OwnershipIndex(file)
    idx.record('s1', 'alice')
    await idx.flush()
    const reloaded = new OwnershipIndex(file)
    expect(reloaded.lookup('s1')).toBe('alice')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ s1: 'alice' })
  })

  it('re-record overwrites, corrupt file starts empty', async () => {
    const file = tmpFile()
    const idx = new OwnershipIndex(file)
    idx.record('s1', 'alice')
    idx.record('s1', 'bob')
    await idx.flush()
    expect(new OwnershipIndex(file).lookup('s1')).toBe('bob')
    const corrupt = tmpFile()
    writeFileSync(corrupt, '{not json')
    expect(new OwnershipIndex(corrupt).lookup('x')).toBeUndefined()
  })
})
