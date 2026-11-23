import { describe, expect, it, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { createRootRouteListener, isRootRequest } from '../src/root-route.ts'

/**
 * DSH 0.2.3-alpha.1+ gives remote-connection an exact `/` route, which wins
 * over the fallback seat: anonymous browsers get the core pairing card instead
 * of the login wall, and logged-in browsers are delegated to
 * `readResource('index.html')`, which 404s against a handler-owned fallback.
 * These cases pin the hook that keeps the gateway on the bare root.
 */

const response = {} as ServerResponse

/** A gateway stand-in that records whether it owned the response. */
function gatewaySpy(): { calls: number; handler: () => Promise<void> } {
  const state = { calls: 0, handler: async (): Promise<void> => { state.calls += 1 } }
  return state
}

describe('isRootRequest()', () => {
  it('claims GET and HEAD on exactly the root path', () => {
    expect(isRootRequest({ method: 'GET', url: '/' })).toBe(true)
    expect(isRootRequest({ method: 'HEAD', url: '/' })).toBe(true)
    expect(isRootRequest({ method: 'GET', url: '/?x=1' })).toBe(true)
  })

  it('leaves every other path, method, and the launch-token handshake alone', () => {
    expect(isRootRequest({ method: 'GET', url: '/index.html' })).toBe(false)
    expect(isRootRequest({ method: 'GET', url: '/login' })).toBe(false)
    expect(isRootRequest({ method: 'GET', url: '/settings/workspaces' })).toBe(false)
    expect(isRootRequest({ method: 'POST', url: '/' })).toBe(false)
    expect(isRootRequest({ method: 'GET', url: '/?token=abc' })).toBe(false)
    expect(isRootRequest({ method: 'GET', url: '/?token=' })).toBe(false)
  })
})

describe('createRootRouteListener()', () => {
  it('answers `/` with the gateway and never reaches the core route', async () => {
    const gateway = gatewaySpy()
    const next = vi.fn(async () => {})
    await createRootRouteListener(gateway.handler)({ method: 'GET', url: '/' } as never, response, next)
    expect(gateway.calls).toBe(1)
    expect(next).not.toHaveBeenCalled()
  })

  it('dispatches non-root requests to the named routes unchanged', async () => {
    const gateway = gatewaySpy()
    const next = vi.fn(async () => {})
    const listener = createRootRouteListener(gateway.handler)
    await listener({ method: 'GET', url: '/index.html' } as never, response, next)
    await listener({ method: 'POST', url: '/' } as never, response, next)
    await listener({ method: 'GET', url: '/?token=tok-1' } as never, response, next)
    expect(gateway.calls).toBe(0)
    expect(next).toHaveBeenCalledTimes(3)
  })
})
