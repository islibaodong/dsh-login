import { describe, expect, it } from 'vitest'
import { wrapRemoteGateway, createRemoteIsolation, type RemoteGateway, type RemoteInvokeRequest } from '../src/remote-guard.ts'

function fakeGateway(): RemoteGateway & { calls: RemoteInvokeRequest[] } {
  const calls: RemoteInvokeRequest[] = []
  return {
    calls,
    async invoke(request) { calls.push(request); return { invoked: `${request.namespace}.${request.method}` } },
    async *stream(request) { calls.push(request); yield { stream: `${request.namespace}.${request.method}` } },
  }
}

const alice = { username: 'alice', isAdmin: false }
const root = { username: 'root', isAdmin: true }
const owned = new Set(['s-1', 'w-1'])

describe('wrapRemoteGateway (option A isolation glue)', () => {
  it('passes an admin user through unfiltered', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => root)
    const res = await wrapped.invoke({ namespace: 'credentials', method: 'list', args: {} })
    expect(res).toEqual({ invoked: 'credentials.list' })
    expect(g.calls).toHaveLength(1)
  })

  it('denies admin-only namespaces for an ordinary user', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => alice, id => owned.has(id))
    await expect(wrapped.invoke({ namespace: 'credentials', method: 'list', args: {} }))
      .rejects.toThrow(/forbidden/)
    await expect(wrapped.invoke({ namespace: 'settings', method: 'get', args: {} }))
      .rejects.toThrow(/forbidden/)
    expect(g.calls).toHaveLength(0)
  })

  it('denies an ordinary user a method outside the allowed surface', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => alice, id => owned.has(id))
    await expect(wrapped.invoke({ namespace: 'host', method: 'pickDirectory', args: {} }))
      .rejects.toThrow(/forbidden/)
    expect(g.calls).toHaveLength(0)
  })

  it('passes an allowed, id-free call for an ordinary user', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => alice, id => owned.has(id))
    const res = await wrapped.invoke({ namespace: 'session', method: 'list', args: {} })
    expect(res).toEqual({ invoked: 'session.list' })
    expect(g.calls).toHaveLength(1)
  })

  it('grants the DSH 0.1.6 additions (terminal + workspace.unarchiveSession) to an ordinary user', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => alice, id => owned.has(id))
    // The 0.1.6 sidebar terminal is agent-scoped by the Gateway (the browser
    // never supplies `agent`), so create/follow are id-free calls.
    await expect(wrapped.invoke({ namespace: 'terminal', method: 'create', args: { id: 'main', cols: 80, rows: 24 } }))
      .resolves.toEqual({ invoked: 'terminal.create' })
    await expect(wrapped.invoke({ namespace: 'terminal', method: 'write', args: { id: 'main', attachmentId: 'a-1', data: 'ls' } }))
      .resolves.toEqual({ invoked: 'terminal.write' })
    // Restore an archived Session (0.1.6), paired with archiveSession.
    await expect(wrapped.invoke({ namespace: 'workspace', method: 'unarchiveSession', args: { sessionId: 's-1' } }))
      .resolves.toEqual({ invoked: 'workspace.unarchiveSession' })
    // terminal.list addresses a session explicitly: an owned id passes.
    await expect(wrapped.invoke({ namespace: 'terminal', method: 'list', args: { sessionId: 's-1' } }))
      .resolves.toEqual({ invoked: 'terminal.list' })
    // ...and a foreign sessionId is still denied (ownership guard).
    await expect(wrapped.invoke({ namespace: 'terminal', method: 'list', args: { sessionId: 's-foreign' } }))
      .rejects.toThrow(/forbidden/)
    expect(g.calls).toHaveLength(4)
  })

  it('grants the DSH 0.1.6-alpha.2 document-preview surface scoped to owned sessions', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => alice, id => owned.has(id))
    // terminal.retain (0.1.6-alpha.2 retention): explicit sessionId.
    await expect(wrapped.invoke({ namespace: 'terminal', method: 'retain', args: { sessionId: 's-1', id: 'main' } }))
      .resolves.toEqual({ invoked: 'terminal.retain' })
    // The document preview reads ride the scoped session identity
    // (`workspaceFileScopeId` on the wire): an owned id passes.
    await expect(wrapped.invoke({ namespace: 'workspaceFiles', method: 'readAll', args: { workspaceFileScopeId: 's-1', path: 'report.md' } }))
      .resolves.toEqual({ invoked: 'workspaceFiles.readAll' })
    await expect(wrapped.invoke({ namespace: 'officeToPdf', method: 'render', args: { workspaceFileScopeId: 's-1', path: 'report.docx', priority: 'foreground' } }))
      .resolves.toEqual({ invoked: 'officeToPdf.render' })
    // ...and a foreign scoped identity is denied (the document preview can
    // not be used to read another user's session files).
    await expect(wrapped.invoke({ namespace: 'workspaceFiles', method: 'read', args: { workspaceFileScopeId: 's-foreign', path: 'secret.md' } }))
      .rejects.toThrow(/forbidden/)
    await expect(wrapped.invoke({ namespace: 'officeToPdf', method: 'render', args: { workspaceFileScopeId: 's-foreign', path: 'secret.docx', priority: 'foreground' } }))
      .rejects.toThrow(/forbidden/)
    expect(g.calls).toHaveLength(3)
  })

  it('denies the native plugin manager (0.1.6-alpha.2) for an ordinary user but passes admins', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => alice, id => owned.has(id))
    // Installing/removing bundles is strictly admin-only.
    for (const method of ['listPlugins', 'installBundle', 'removeBundle', 'setBundleEnabled']) {
      await expect(wrapped.invoke({ namespace: 'pluginManager', method, args: {} }))
        .rejects.toThrow(/forbidden/)
    }
    expect(g.calls).toHaveLength(0)
    // Admins keep full plugin management.
    const adminWrapped = wrapRemoteGateway(g, () => root)
    await expect(adminWrapped.invoke({ namespace: 'pluginManager', method: 'listPlugins', args: {} }))
      .resolves.toEqual({ invoked: 'pluginManager.listPlugins' })
  })

  it('grants the DSH 0.1.7 additions (job + session pinning) scoped to owned sessions', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => alice, id => owned.has(id))
    // job.list / job.follow (0.1.7 job controller, SessionJob moved out of
    // `session`): reconnect-safe streams whose request carries `sessionId`.
    await expect(wrapped.invoke({ namespace: 'job', method: 'list', args: { sessionId: 's-1' } }))
      .resolves.toEqual({ invoked: 'job.list' })
    // job.kill is the human stop button — allowed on the user's own session.
    await expect(wrapped.invoke({ namespace: 'job', method: 'kill', args: { sessionId: 's-1', jobId: 'j-1' } }))
      .resolves.toEqual({ invoked: 'job.kill' })
    // ...and a foreign sessionId is denied (ownership guard; `jobId` is
    // deliberately NOT a guarded field — only the session scope is).
    await expect(wrapped.invoke({ namespace: 'job', method: 'kill', args: { sessionId: 's-foreign', jobId: 'j-1' } }))
      .rejects.toThrow(/forbidden/)
    // Session pinning (0.1.7 workspace additions) on the user's own tree.
    await expect(wrapped.invoke({ namespace: 'workspace', method: 'pinSession', args: { sessionId: 's-1' } }))
      .resolves.toEqual({ invoked: 'workspace.pinSession' })
    // Three calls reached the gateway; the foreign kill was denied upstream.
    expect(g.calls).toHaveLength(3)
  })

  it('denies the whole account namespace (0.1.7) for ordinary users but passes admins', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => alice, id => owned.has(id))
    // signOut/startSignIn rebind or revoke THE instance's upstream Platform
    // grant; even the read projections leak the operator's profile/balance.
    for (const method of ['signOut', 'startSignIn', 'cancelSignIn', 'getState', 'getProfile', 'getBalance']) {
      await expect(wrapped.invoke({ namespace: 'account', method, args: {} }))
        .rejects.toThrow(/forbidden/)
    }
    expect(g.calls).toHaveLength(0)
    // Admins manage the instance account.
    const adminWrapped = wrapRemoteGateway(g, () => root)
    await expect(adminWrapped.invoke({ namespace: 'account', method: 'getState', args: {} }))
      .resolves.toEqual({ invoked: 'account.getState' })
    await expect(adminWrapped.invoke({ namespace: 'account', method: 'signOut', args: {} }))
      .resolves.toEqual({ invoked: 'account.signOut' })
  })

  it('rejects a call addressing a session outside the owned set', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => alice, id => owned.has(id))
    await expect(wrapped.invoke({ namespace: 'session', method: 'history', args: { sessionId: 's-foreign' } }))
      .rejects.toThrow(/forbidden/)
    await expect(wrapped.invoke({ namespace: 'workspace', method: 'rename', args: { workspaceId: 'w-foreign' } }))
      .rejects.toThrow(/forbidden/)
    expect(g.calls).toHaveLength(0)
  })

  it('rejects an array-valued id arg containing a foreign id (sessionIds: [...])', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => alice, id => owned.has(id))
    // All owned → allowed.
    await expect(wrapped.invoke({ namespace: 'workspace', method: 'insertBefore', args: { sessionIds: ['s-1'] } }))
      .resolves.toEqual({ invoked: 'workspace.insertBefore' })
    // One foreign id → denied.
    await expect(wrapped.invoke({ namespace: 'workspace', method: 'insertBefore', args: { sessionIds: ['s-1', 's-foreign'] } }))
      .rejects.toThrow(/forbidden/)
    expect(g.calls).toHaveLength(1) // only the all-owned call reached the gateway
  })

  it('rejects an array of nested {id} records containing a foreign id', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => alice, id => owned.has(id))
    await expect(wrapped.invoke({ namespace: 'session', method: 'prompt', args: { parentSessionIds: [{ id: 's-foreign' }] } }))
      .rejects.toThrow(/forbidden/)
    await expect(wrapped.invoke({ namespace: 'session', method: 'prompt', args: { parentSessionIds: [{ id: 's-1' }] } }))
      .resolves.toEqual({ invoked: 'session.prompt' })
    expect(g.calls).toHaveLength(1)
  })

  it('rejects a nested-object sessionId (e.g. under a wrapper key)', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => alice, id => owned.has(id))
    await expect(wrapped.invoke({ namespace: 'subagent', method: 'prompt', args: { agentId: { id: 's-foreign' } } }))
      .rejects.toThrow(/forbidden/)
    await expect(wrapped.invoke({ namespace: 'subagent', method: 'prompt', args: { agentId: { id: 's-1' } } }))
      .resolves.toEqual({ invoked: 'subagent.prompt' })
    expect(g.calls).toHaveLength(1)
  })

  it('passes a call addressing an owned id', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => alice, id => owned.has(id))
    const res = await wrapped.invoke({ namespace: 'session', method: 'history', args: { sessionId: 's-1' } })
    expect(res).toEqual({ invoked: 'session.history' })
  })

  it('guards the stream path identically', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => alice, id => owned.has(id))
    await expect(wrapped.invoke({ namespace: 'goal', method: 'get', args: { sessionId: 's-foreign' } }))
      .rejects.toThrow(/forbidden/)
    const stream = wrapped.stream({ namespace: 'session', method: 'list', args: {} })
    for await (const _ of (await stream)) { /* yields */ }
    expect(g.calls).toHaveLength(1)
  })

  it('denies when the resolver returns undefined (fail closed)', async () => {
    const g = fakeGateway()
    const wrapped = wrapRemoteGateway(g, () => undefined, () => true)
    await expect(wrapped.invoke({ namespace: 'session', method: 'list', args: {} }))
      .rejects.toThrow(/forbidden/)
    expect(g.calls).toHaveLength(0)
  })
})

describe('createRemoteIsolation (deployment glue: agent→user + owned set)', () => {
  const ownership = { s1: 'alice', s2: 'bob', w1: 'alice' }

  it('resolves the user from the current session id via the ownership sidecar', () => {
    const { resolveUser } = createRemoteIsolation({
      currentSessionId: () => 's1',
      ownership: { lookup: (id) => ownership[id as keyof typeof ownership] },
      isAdmin: () => false,
    })
    expect(resolveUser()).toEqual({ username: 'alice', isAdmin: false })
  })

  it('owns exactly the sessions/workspaces recorded to the resolved user', () => {
    const { resolveUser, owns } = createRemoteIsolation({
      currentSessionId: () => 's1',
      ownership: { lookup: (id) => ownership[id as keyof typeof ownership] },
      isAdmin: (username) => username === 'root',
    })
    // alice's own session and workspace are owned...
    expect(owns('s1')).toBe(true)
    expect(owns('w1')).toBe(true)
    // ...bob's session is not.
    expect(owns('s2')).toBe(false)
    // The owns set used by the guard is keyed to presence in the sidecar (a
    // deployment hands the user-scoped lookup); unowned ids stay fail-closed.
    expect((resolveUser()?.username)).toBe('alice')
  })

  it('applies the admin callback to a username', () => {
    const { resolveUser } = createRemoteIsolation({
      currentSessionId: () => 'r1',
      ownership: { lookup: (id) => ownership[id as keyof typeof ownership] ?? 'root' },
      isAdmin: (username) => username === 'root',
    })
    expect(resolveUser()).toEqual({ username: 'root', isAdmin: true })
  })

  it('resolves an admin session without an ownership record via isAdminSession', () => {
    const { resolveUser, owns } = createRemoteIsolation({
      currentSessionId: () => 'admin-sess',
      ownership: { lookup: () => undefined }, // admin has no record
      isAdmin: (username) => username === 'root',
      isAdminSession: (sid) => (sid === 'admin-sess' ? 'root' : undefined),
    })
    expect(resolveUser()).toEqual({ username: 'root', isAdmin: true })
    expect(owns('anything')).toBe(true) // admin passes the ownership test
  })

  it('does not invent admin identity when isAdminSession says no (fail closed)', () => {
    const { resolveUser } = createRemoteIsolation({
      currentSessionId: () => 's1',
      ownership: { lookup: () => undefined },
      isAdminSession: () => undefined,
      isAdmin: () => false,
    })
    expect(resolveUser()).toBeUndefined()
  })

  it('fails closed when there is no current session id', () => {
    const { resolveUser } = createRemoteIsolation({
      currentSessionId: () => undefined,
      ownership: { lookup: () => 'alice' },
      isAdmin: () => false,
    })
    expect(resolveUser()).toBeUndefined()
  })

  it('fails closed when the session id has no ownership record', () => {
    const { resolveUser } = createRemoteIsolation({
      currentSessionId: () => 's-unknown',
      ownership: { lookup: () => undefined },
      isAdmin: () => false,
    })
    expect(resolveUser()).toBeUndefined()
  })
})

describe('composed seam end-to-end (agents → createRemoteIsolation → wrapRemoteGateway → gateway)', () => {
  // Mirrors the deployment wiring: the current Cordis agent's id is the
  // session id; the ownership sidecar maps it to a username; the guard scopes
  // the owned set to that user.
  function compose() {
    const sidecar: Record<string, string> = { s1: 'alice', s2: 'bob' }
    let currentSessionId: string | undefined = 's1'
    const agents = { currentInitiator: () => (currentSessionId === undefined ? undefined : { id: currentSessionId }) }
    const ownership = { lookup: (id: string) => sidecar[id] }
    const { resolveUser, owns } = createRemoteIsolation({
      currentSessionId: () => agents.currentInitiator()?.id as string | undefined,
      ownership,
      isAdmin: (username) => username === 'root',
      // admin sessions carry no ownership record, but resolve as admin anyway
      isAdminSession: (sid) => (sid === 'admin-session' ? 'root' : undefined),
    })
    const calls: RemoteInvokeRequest[] = []
    const gateway: RemoteGateway = {
      async invoke(request) { calls.push(request); return 'ok' },
      async *stream(request) { calls.push(request); yield 'ok' },
    }
    const wrapped = wrapRemoteGateway(gateway, resolveUser, owns)
    return { wrapped, calls, setCurrent: (id?: string) => { currentSessionId = id } }
  }

  it('allows a user to read their own session and blocks a foreign one', async () => {
    const { wrapped, calls, setCurrent } = compose()
    setCurrent('s1') // alice active
    await expect(wrapped.invoke({ namespace: 'session', method: 'history', args: { sessionId: 's1' } })).resolves.toBe('ok')
    expect(calls).toHaveLength(1)
    await expect(wrapped.invoke({ namespace: 'session', method: 'history', args: { sessionId: 's2' } }))
      .rejects.toThrow(/forbidden/)
    expect(calls).toHaveLength(1) // foreign call never reached the gateway
  })

  it('isolates two users from each other per the active agent', async () => {
    const { wrapped, calls, setCurrent } = compose()
    // bob active — he may read his own session, not alice's.
    setCurrent('s2')
    await expect(wrapped.invoke({ namespace: 'session', method: 'history', args: { sessionId: 's2' } })).resolves.toBe('ok')
    await expect(wrapped.invoke({ namespace: 'session', method: 'history', args: { sessionId: 's1' } }))
      .rejects.toThrow(/forbidden/)
    expect(calls).toHaveLength(1)
  })

  it('admins pass through unfiltered even with no ownership record', async () => {
    const { wrapped, calls, setCurrent } = compose()
    // alice is not admin → admin domains are denied.
    setCurrent('s1')
    await expect(wrapped.invoke({ namespace: 'credentials', method: 'list', args: {} }))
      .rejects.toThrow(/forbidden/)
    expect(calls).toHaveLength(0)
    // An admin session resolves via isAdminSession (no ownership record) and
    // passes everything unfiltered, including admin-only domains + foreign ids.
    calls.length = 0
    setCurrent('admin-session')
    await expect(wrapped.invoke({ namespace: 'credentials', method: 'list', args: {} })).resolves.toBe('ok')
    await expect(wrapped.invoke({ namespace: 'session', method: 'history', args: { sessionId: 's1' } })).resolves.toBe('ok')
    expect(calls).toHaveLength(2)
  })
})