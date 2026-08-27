import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DefaultWorkspaceSetting } from '../src/workspace-setting.ts'

const dirs: string[] = []
let fileCounter = 0

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-login-setting-'))
  dirs.push(dir)
  fileCounter += 1
  return join(dir, 'settings-' + String(fileCounter) + '.json')
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch { }
  }
})

describe('DefaultWorkspaceSetting', () => {
  it('starts from the initial/config default when no file exists', () => {
    expect(new DefaultWorkspaceSetting(tmpFile(), true).get()).toBe(true)
    expect(new DefaultWorkspaceSetting(tmpFile(), false).get()).toBe(false)
  })

  it('set updates the live value and set returns the new value', () => {
    const s = new DefaultWorkspaceSetting(tmpFile(), true)
    expect(s.set(false)).toBe(false)
    expect(s.get()).toBe(false)
    expect(s.set(true)).toBe(true)
  })

  it('persists the flag across a reload after flush', async () => {
    const file = tmpFile()
    const s = new DefaultWorkspaceSetting(file, true)
    s.set(false)
    await s.flush()
    expect(new DefaultWorkspaceSetting(file, true).get()).toBe(false)
  })

  it('loads a corrupt file by falling back to the initial default', () => {
    const corrupt = tmpFile()
    writeFileSync(corrupt, '{ not valid json')
    expect(new DefaultWorkspaceSetting(corrupt, true).get()).toBe(true)
  })

  it('ignores a non-boolean persisted value and keeps the initial default', () => {
    const file = tmpFile()
    writeFileSync(file, JSON.stringify({ enabled: 'yes' }))
    expect(new DefaultWorkspaceSetting(file, true).get()).toBe(true)
  })
})