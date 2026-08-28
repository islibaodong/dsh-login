import { describe, expect, it, vi } from 'vitest'
import { RemoteWebUiCompat, applyWithRetry, REMOTE_WEB_UI_NAMESPACE } from '../src/remote-web-ui-compat.ts'

/** A minimal fake SettingsProvider.update capturing the namespace + patch. */
function fakeSettings(updateImpl?: (ns: string, patch: unknown) => Promise<void> | void) {
  const calls: Array<{ ns: string; patch: unknown }> = []
  const settings = {
    async update(ns: string, patch: unknown): Promise<void> {
      calls.push({ ns, patch })
      await updateImpl?.(ns, patch)
    },
  }
  return { settings, calls }
}

describe('RemoteWebUiCompat.apply', () => {
  it('writes requirePairingForLan:false for enabled=true into the remote-web-ui namespace', async () => {
    const { settings, calls } = fakeSettings()
    const compat = new RemoteWebUiCompat({ getSettings: () => settings })
    expect(await compat.apply(true)).toBe('ok')
    expect(calls).toEqual([{ ns: REMOTE_WEB_UI_NAMESPACE as unknown as string, patch: { requirePairingForLan: false } }])
  })

  it('writes requirePairingForLan:true for enabled=false', async () => {
    const { settings, calls } = fakeSettings()
    const compat = new RemoteWebUiCompat({ getSettings: () => settings })
    expect(await compat.apply(false)).toBe('ok')
    expect(calls).toEqual([{ ns: REMOTE_WEB_UI_NAMESPACE as unknown as string, patch: { requirePairingForLan: true } }])
  })

  it('returns skipped when there is no settings service', async () => {
    const compat = new RemoteWebUiCompat({ getSettings: () => undefined })
    expect(await compat.apply(true)).toBe('skipped')
  })

  it('returns unregistered when the namespace is not registered (not remote-web-ui)', async () => {
    const { settings } = fakeSettings(() => { throw new Error('settings namespace not registered') })
    const compat = new RemoteWebUiCompat({ getSettings: () => settings })
    expect(await compat.apply(true)).toBe('unregistered')
  })

  it('rethrows unexpected errors (a real failure, not a missing namespace)', async () => {
    const { settings } = fakeSettings(() => { throw new Error('disk full') })
    const compat = new RemoteWebUiCompat({ getSettings: () => settings })
    await expect(compat.apply(true)).rejects.toThrow('disk full')
  })
})

describe('applyWithRetry', () => {
  it('returns ok on the first attempt when the namespace is registered', async () => {
    const { settings } = fakeSettings()
    const compat = new RemoteWebUiCompat({ getSettings: () => settings })
    expect(await applyWithRetry(compat, true, 3, 1)).toBe('ok')
  })

  it('retries until the namespace registers within budget', async () => {
    const { settings } = fakeSettings()
    const spy = vi.spyOn(settings, 'update')
    spy.mockImplementationOnce(() => { throw new Error('settings namespace not registered') })
      .mockImplementationOnce(() => { throw new Error('settings namespace not registered') })
      .mockImplementationOnce(() => { /* noop — registers on the third */ })
    const compat = new RemoteWebUiCompat({ getSettings: () => settings })
    expect(await applyWithRetry(compat, true, 5, 1)).toBe('ok')
    expect(spy).toHaveBeenCalledTimes(3)
  })

  it('gives up with unregistered after exhausting the budget', async () => {
    const { settings } = fakeSettings()
    const spy = vi.spyOn(settings, 'update')
    spy.mockImplementation(() => { throw new Error('settings namespace not registered') })
    const compat = new RemoteWebUiCompat({ getSettings: () => settings })
    expect(await applyWithRetry(compat, true, 2, 1)).toBe('unregistered')
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('retries while the settings service is absent until it appears, then writes', async () => {
    // Settings resolves only after the first two probes — the boot race where
    // dsh-login applies before the settings provider mounts.
    const { settings } = fakeSettings()
    let probes = 0
    const compat = new RemoteWebUiCompat({
      getSettings: () => { probes++; return probes >= 3 ? settings : undefined },
    })
    expect(await applyWithRetry(compat, true, 6, 1)).toBe('ok')
    expect(probes).toBeGreaterThanOrEqual(3)
  })

  it('gives up with skipped when the settings service never appears', async () => {
    const compat = new RemoteWebUiCompat({ getSettings: () => undefined })
    expect(await applyWithRetry(compat, true, 3, 1)).toBe('skipped')
  })
})