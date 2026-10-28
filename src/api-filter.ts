/**
 * Pure physical-layer permission predicates for the dsh-login gateway.
 *
 * In DSH ≥ 0.1.5-alpha.1 dsh-login no longer takes over the `/api` carrier
 * (see docs/adapt-dsh-0.1.5.md, option A): the native `connection` +
 * `api-gateway` transport owns `/api`, and dsh-login composes its login wall
 * and — via the remote/controller layer — its per-user ownership enforcement on
 * top. What remains here is the pure, package-independent predicate surface that
 * `capabilities.ts`, the `/api` bridge wall and the remote guard rely on.
 *
 * ── 0.3.6: the allow-list is now the *real* wire surface ─────────────────────
 * Until 0.3.5 this set still carried the pre-0.1.5 `RpcMethodMap` spellings
 * (`session.history`, `session.models`, `llm.providers`, `skill.list`,
 * `goal.*`, `respond`, `host.describe`, …). Upstream had long since renamed
 * every one of them, so ~20 entries were dead and the live methods they were
 * meant to describe were denied — which is exactly what issue #4 reports
 * (choosing a model, picking a workspace directory, and the settings→models
 * page all landed on a `forbidden` envelope for ordinary users).
 *
 * The lists below are transcribed from the typert wire registry of DSH
 * 0.2.2-alpha.2 (`TypertRemoteMap`, one `'<namespace>/<method>'` key per endpoint,
 * 199 in total — 0.2.1-rc.4's registry stays at 0.2.1's 146 endpoints, a strict
 * subset of this classification, so one list serves both supported lines; the
 * 53 alpha-line additions are the forge panel, liveshare share management,
 * session state/observation, tool-result watch, CUA consent, plugin
 * detail/update and recommendation surfaces). They are a **total, disjoint
 * classification** of that surface:
 *
 *   - {@link USER_ALLOWED}        – per-user, session/agent-scoped features.
 *   - {@link ADMIN_ONLY_METHODS}  – host configuration, credentials, plugin
 *                                   management, admin UI surfaces, host-side
 *                                   code execution.
 *   - {@link HOST_INTERNAL_METHODS} – never browser-initiated (first-use host
 *                                   plumbing); denied to ordinary users and not
 *                                   advertised to admins either.
 *
 * `USER_ALLOWED ∪ ADMIN_ONLY_METHODS ∪ HOST_INTERNAL_METHODS` must equal the
 * registry exactly. tests/wire-surface.spec.ts enforces that against the
 * vendored snapshot (tests/fixtures/wire-surface.json) and, when a harness
 * checkout is reachable, against the live registry — so an upstream rename
 * fails the build instead of silently denying a user feature.
 */

export interface AuthUser { username: string; isAdmin: boolean }

/** DSH release the snapshots in this file were transcribed from. */
export const WIRE_SURFACE_DSH_VERSION = '0.2.2-alpha.2'

/**
 * The user-facing wire surface: every method an ordinary (non-admin) user may
 * call through the `/api` carrier.
 *
 * Rule of thumb: a method belongs here when it acts *within* the caller's own
 * user scope — their sessions, workspaces, goals, terminals, uploads, speech
 * preferences, scheduled runs — or reads a catalog the client needs to render
 * (llm provider/model catalogs, permission presets, skills, slash commands).
 * Anything that reconfigures the instance, exposes operator credentials, or
 * executes host-side code is in {@link ADMIN_ONLY_METHODS} instead.
 *
 * Note: the wall only gates POST (the unary RPC carrier). Stream methods
 * (`*.follow`, `terminal.attach`, `userQuestions.attachWait`, …) travel over
 * the `/api/events.mux` WebSocket, but they are listed here anyway so the
 * remote guard — which denies at the dispatch layer, streams included — stays
 * consistent with the bridge wall.
 */
export const USER_ALLOWED: ReadonlySet<string> = new Set([
  // ── session: the conversation surface ─────────────────────────────────────
  // `page` replaced the old `session.history`; `modelCatalog` replaced
  // `session.models`; `initializeDefaultModel`/`selectModel` are the model
  // picker; `canOpenWorkspacePath`/`openWorkspacePath`/
  // `workspacePathApplications` back the "open folder" flow; `control` is the
  // per-session steering stream; `projections` is the timeline projection.
  'session.attachment', 'session.cancel', 'session.canOpenWorkspacePath',
  'session.control', 'session.create', 'session.events', 'session.follow',
  'session.fork', 'session.initializeDefaultModel', 'session.list',
  'session.modelCatalog', 'session.observeEvent', 'session.observeProjections',
  'session.observeState', 'session.openWorkspacePath', 'session.page',
  'session.projections', 'session.prompt', 'session.rename', 'session.search',
  'session.selectModel', 'session.state', 'session.updateQueue', 'session.wait',
  'session.workspacePathApplications',
  // ── workspace: the sidebar tree (read + the user's own mutations) ─────────
  // `follow` is the tree snapshot stream (the old `workspace.list`); every
  // mutation carries ids the guard ownership-checks.
  'workspace.archiveSession', 'workspace.create', 'workspace.delete',
  'workspace.follow', 'workspace.insertBefore', 'workspace.insertSessionBefore',
  'workspace.pinSession', 'workspace.rename', 'workspace.unarchiveSession',
  'workspace.unpinSession',
  // ── goals: per-session goal tracking (renamed from `goal.*`) ──────────────
  'goals.clear', 'goals.complete', 'goals.create', 'goals.edit', 'goals.get',
  'goals.pause', 'goals.resume',
  // ── subagents: the caller's own agent subtree ─────────────────────────────
  'subagents.interruptByParent', 'subagents.prompt',
  // ── actionCards: user actions on in-chat cards ─────────────────────────────
  // `act` applies one verb to one card of the displayed Session; the Gateway
  // resolves `agent` server-side from the Session id, so it reaches only the
  // caller's own conversation (same trust shape as `terminal.*`).
  'actionCards.act',
  // ── forgePanel: the per-session git worktree / change-request panel ────────
  // Every method is Session-scoped (first wire arg `sessionId: SessionId`, a
  // resource the Gateway resolves and the remote guard ownership-checks): it
  // inspects the Session's own checkout, follows or merges the Session's bound
  // change requests, and creates/enters worktrees for that Session — the same
  // trust shape as `terminal.*` (the agent can already run git/shell for the
  // user inside the Session's world). Host-wide secrets are not touched; the
  // sign-in probe reports only the state of the code host of the Session's
  // own checkout.
  'forgePanel.branches', 'forgePanel.cancelWorktree',
  'forgePanel.changeRequestDiff', 'forgePanel.changeRequestStates',
  'forgePanel.changeRequestText', 'forgePanel.continueInProject',
  'forgePanel.dismiss', 'forgePanel.follow', 'forgePanel.localDiff',
  'forgePanel.localText', 'forgePanel.markReady', 'forgePanel.merge',
  'forgePanel.refresh', 'forgePanel.requestWorktree',
  'forgePanel.restoreWorktree', 'forgePanel.retryWorktree',
  'forgePanel.stopCreation', 'forgePanel.track',
  // ── llm: the provider/model catalogs the picker renders ───────────────────
  // (`llm.providers`/`llm.models` never existed on this wire line; these are
  // the real names — discovery is what settings→models failed on in issue #4.)
  'llm.discoverModels', 'llm.listConfigurableProviders', 'llm.listProviders',
  // ── skills: the slash-command skill list (`skills.list`) ──────────────────
  'skills.list',
  // ── job: the background job controller ────────────────────────────────────
  'job.follow', 'job.kill', 'job.list',
  // ── terminal: the sidebar terminal ────────────────────────────────────────
  // Every method is session-agent-scoped by the Gateway (the `agent` argument
  // is supplied server-side, never by the browser), so it stays inside the
  // caller's own agent subtree — the same trust boundary as `session.prompt`
  // (an agent can already run shell for the user). `list`/`retain` address a
  // session explicitly and are ownership-checked. NOTE: since 0.1.6-alpha.2
  // user terminals run with the execution environment's system-user
  // permissions (no Agent sandbox); a stricter deployment subtracts these
  // (docs/adapt-dsh-0.1.6-alpha.2.md §4).
  'terminal.attach', 'terminal.close', 'terminal.create', 'terminal.environment',
  'terminal.list', 'terminal.rename', 'terminal.retain', 'terminal.shells',
  // ── remoteAccess: the client's own grant snapshot stream ──────────────────
  // The gateway always allows it and it answers with only the caller's own
  // grants, so admitting it keeps the mount silent on every page load.
  'remoteAccess.follow',
  // ── document preview: read-only Files surface + Office→PDF ────────────────
  // Each call carries the scoped session identity (workspaceFileScopeId),
  // resolved and ownership-checked by the Gateway. No write method is exposed.
  'workspaceFiles.changes', 'workspaceFiles.list', 'workspaceFiles.read',
  'workspaceFiles.readBytes', 'workspaceFiles.stat',
  'officeToPdf.generation', 'officeToPdf.render',
  // ── speech: per-user dictation preferences + transcription ────────────────
  // `configure` persists the caller's own recognizer settings.
  'speech.cancelPreparation', 'speech.catalog', 'speech.configure',
  'speech.follow', 'speech.prepare', 'speech.transcribe',
  // ── schedule: the user's own scheduled runs ───────────────────────────────
  'schedule.catalog', 'schedule.delete', 'schedule.history', 'schedule.list',
  'schedule.update',
  // ── composer + pickers the GUI calls on ordinary-user pages ───────────────
  // `directoryPicker.*` is the "add workspace" directory chooser
  // (`ui-workspace/src/client/navigation.ts`), i.e. issue #4 symptom 1. It is
  // admitted because the capability class is already open to ordinary users
  // (`terminal.*` runs shell as the same system user), and because the
  // dangerous half — registering the picked directory — stays guarded:
  // `workspace.create` is confined to the caller's sandbox by the workspace
  // mutation guard, so a pick outside it is rejected at that call, not here.
  'commands.execute', 'commands.list',
  'directoryPicker.createDirectory', 'directoryPicker.list', 'directoryPicker.pick',
  // ── attachments, references, feedback, telemetry ──────────────────────────
  'fileReferences.list', 'fileUploads.upload',
  'messageFeedback.delete', 'messageFeedback.list', 'messageFeedback.put',
  'sessionFeedback.record',
  'sessionReferenceResolver.candidates',
  'permissionPresets.catalog',
  'productAnalytics.enabled', 'productAnalytics.report', 'productAnalytics.watchPolicy',
  // ── chain-of-thought translation (a per-user reading aid) ─────────────────
  'cotTranslation.limits', 'cotTranslation.translate',
  // ── pluginRecommendations: the enable-official-plugin card's text ──────────
  // `describe` reads the catalog text behind one logged card; `agent` is
  // Gateway-resolved and the `callId` must name a live card of that Session,
  // so it is session-scoped like `actionCards.act`.
  'pluginRecommendations.describe',
  // ── the agent's ask-the-user dialog ───────────────────────────────────────
  'userQuestions.answer', 'userQuestions.attachWait',
  // ── toolResults: the Session's own tool-result trajectory stream ──────────
  'toolResults.watch',
])

/**
 * Instance-level wire surface: never reachable by an ordinary user.
 *
 * Grouped by why:
 *  - `account`              – the process-wide upstream DeepSeek Platform grant
 *                             (sign-in/out, balance, profile): operator data.
 *  - `credentials`          – secret storage describe/set/unset.
 *  - `settings`             – host configuration documents.
 *  - `agentPresets`         – preset definitions (system prompts + plugin
 *                             composition) get injected into new sessions; they
 *                             are authoring surface, kept admin-only even
 *                             though the client half reads/selects them.
 *  - `pluginManager` / `pluginMarket` / `pluginInventory` /
 *    `pluginRegistryProbe`  – install/enable/remove bundles, rewrite the
 *                             instance-wide market index list, enumerate the
 *                             host's plugin tree.
 *  - `liveshareShares`      – publishing sessions to external viewers through
 *                             the Liveshare server, the host's relay
 *                             connection and owner identity, and the share
 *                             audit trail (upstream declares the whole surface
 *                             "owner-only").
 *  - `dynamicCordisRunner`  – runs arbitrary host-side plugin code.
 */
export const ADMIN_ONLY_METHODS: ReadonlySet<string> = new Set([
  'account.ackBonusNotified', 'account.cancelSignIn', 'account.getBalance',
  'account.getProfile', 'account.getState', 'account.getUnnotifiedBonuses',
  'account.hasRunningAccountTasks', 'account.signOut', 'account.startSignIn',
  'account.watch', 'account.watchExpiry',
  'agentPresets.list', 'agentPresets.read', 'agentPresets.select',
  'claudeCodeMods.pressBand', 'claudeCodeMods.watchBand',
  'credentials.describe', 'credentials.set', 'credentials.unset',
  'dynamicCordisRunner.getClientCode', 'dynamicCordisRunner.inventory',
  'dynamicCordisRunner.invoke', 'dynamicCordisRunner.reportClientGuardFailure',
  'dynamicCordisRunner.reportRenderFailure',
  'dynamicCordisRunner.resolveInspectQuery',
  'dynamicCordisRunner.resolveRequestRun', 'dynamicCordisRunner.runHostHalf',
  'dynamicCordisRunner.settleUserRun', 'dynamicCordisRunner.stopFromPanel',
  'dynamicCordisRunner.syncInspectManifest', 'dynamicCordisRunner.undefineFromPanel',
  'pluginInventory.list',
  'pluginManager.cancelInstall', 'pluginManager.inspect',
  'pluginManager.installBundle', 'pluginManager.listBundles',
  'pluginManager.listPlugins', 'pluginManager.listVersionExemptions',
  'pluginManager.listVersions', 'pluginManager.readBundleDetail',
  'pluginManager.registries', 'pluginManager.removeBundle',
  'pluginManager.setBundleEnabled', 'pluginManager.setPluginEnabled',
  'pluginManager.setVersionExemption', 'pluginManager.updateBundle', 'pluginManager.waitForInstall',
  'pluginMarket.listIndexes', 'pluginMarket.readEntryDetail', 'pluginMarket.search', 'pluginMarket.setIndexes',
  'pluginRegistryProbe.fastest',
  // ── cuaAccess: host-native permission and application consent controls ────
  // The whole surface drives the HOST machine (macOS privacy prompts through
  // the native helper, the shared application-consent store, and the
  // host-wide PTC profile edit behind `enablePersistentPtc`), so it stays
  // operator territory even though the client page lives in a Session.
  'cuaAccess.applicationIcons', 'cuaAccess.applications',
  'cuaAccess.enablePersistentPtc', 'cuaAccess.openSettings',
  'cuaAccess.ptcConfiguration', 'cuaAccess.requestPermission',
  'cuaAccess.retryApproval', 'cuaAccess.revoke', 'cuaAccess.systemStatus',
  // ── liveshareShares: the host's share publishing and relay management ──────
  // Upstream declares the whole surface the "Owner-only Remote surface over
  // the share-management operations": publishing Sessions to external viewers
  // through the Liveshare server, the host's relay connection, its owner
  // identity and the share audit trail. That is operator territory in a
  // multi-user deployment (external exposure + host-wide state), so the whole
  // namespace stays admin-side; a future user-scoped subset would need
  // per-share ownership checks dsh-login does not model yet.
  'liveshareShares.audit', 'liveshareShares.capabilities',
  'liveshareShares.create', 'liveshareShares.identity',
  'liveshareShares.list', 'liveshareShares.relay',
  'liveshareShares.setCapabilities', 'liveshareShares.setRelay',
  'liveshareShares.stop', 'liveshareShares.testPublish',
  'liveshareShares.testRelay', 'liveshareShares.updatePermissions',
  // `deleteInactive` sweeps every ended task across the whole Host domain
  // (no Session scope on the wire), so it is an operator action even though
  // the rest of `schedule.*` is the caller's own surface.
  'schedule.deleteInactive',
  'settings.describe', 'settings.mutate', 'settings.openSettingsDocument',
  'settings.replace', 'settings.update',
])

/**
 * Host-internal methods: neither a user action nor an admin UI action. They
 * exist for first-use host plumbing (`workspace.initializeDefault` derives both
 * the directory name and title server-side), so they are denied to ordinary
 * users and deliberately not advertised anywhere.
 */
export const HOST_INTERNAL_METHODS: ReadonlySet<string> = new Set([
  'workspace.initializeDefault',
])

/**
 * The complete wire surface these buckets classify. Kept as a derived union so
 * the three sets above have one build-time invariant to satisfy and callers
 * have one place to ask "is this a method upstream actually ships?".
 */
export const WIRE_SURFACE: ReadonlySet<string> = new Set([
  ...USER_ALLOWED,
  ...ADMIN_ONLY_METHODS,
  ...HOST_INTERNAL_METHODS,
])

/** How a wire method is classified for an ordinary user. */
export type WireMethodClass = 'user' | 'admin' | 'host-internal' | 'unknown'

/** Classify one wire method against the buckets in this module. */
export function classifyWireMethod(method: string): WireMethodClass {
  if (USER_ALLOWED.has(method)) return 'user'
  if (ADMIN_ONLY_METHODS.has(method)) return 'admin'
  if (HOST_INTERNAL_METHODS.has(method)) return 'host-internal'
  return 'unknown'
}

/**
 * Whether the method is part of the wire surface this build knows about. An
 * `unknown` answer for a real `/api` call usually means upstream renamed a
 * method the allow-list still spells the old way — the exact failure mode issue
 * #4 hit — so the bridge wall reports those for diagnosis.
 */
export function isKnownWireMethod(method: string): boolean {
  return WIRE_SURFACE.has(method)
}

/** May an ordinary (non-admin) user call this wire method? */
export function isUserAllowed(method: string): boolean {
  return USER_ALLOWED.has(method)
}
