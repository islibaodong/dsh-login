import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import snapshot from './fixtures/wire-surface.json'
import {
  ADMIN_ONLY_METHODS,
  HOST_INTERNAL_METHODS,
  USER_ALLOWED,
  WIRE_SURFACE,
  WIRE_SURFACE_DSH_VERSION,
  classifyWireMethod,
  isKnownWireMethod,
  isUserAllowed,
} from '../src/api-filter.ts'
import { enumerateWireSurface } from '../scripts/dump-wire-surface.mjs'

/**
 * Issue #4 regression: the allow-list had drifted a whole DSH wire generation
 * behind, so live methods (`session.modelCatalog`, `llm.listProviders`, …) fell
 * through `USER_ALLOWED` and the bridge wall answered `not permitted for this
 * user` to ordinary users. These tests keep the three buckets a *total,
 * disjoint* classification of the wire surface, so any upstream rename shows up
 * as a failing build instead of a silently broken user feature.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const snapshotMethods: readonly string[] = snapshot.methods

/** A DSH checkout to cross-check against, when one is reachable. */
function liveCheckout(): string | undefined {
  const candidates = [
    process.env.DSH_HARNESS_CHECKOUT,
    join(repoRoot, '..', 'deepseek-harness'),
  ].filter((c): c is string => typeof c === 'string' && c !== '')
  return candidates.find(c => statSync(join(c, 'packages'), { throwIfNoEntry: false })?.isDirectory() === true)
}

describe('wire surface classification', () => {
  it('pins the snapshot to a DSH release', () => {
    expect(snapshot.dshVersion).toBe(WIRE_SURFACE_DSH_VERSION)
    expect(snapshot.count).toBe(snapshotMethods.length)
    expect(new Set(snapshotMethods).size).toBe(snapshotMethods.length)
    expect(snapshotMethods.length).toBeGreaterThan(100)
  })

  it('covers the snapshot exactly — no unclassified wire method', () => {
    const classified = new Set([...USER_ALLOWED, ...ADMIN_ONLY_METHODS, ...HOST_INTERNAL_METHODS])
    const missing = snapshotMethods.filter(m => !classified.has(m))
    expect(missing).toEqual([])
    expect(classified.size).toBe(snapshotMethods.length)
    expect([...WIRE_SURFACE].sort()).toEqual([...snapshotMethods].sort())
  })

  it('has no dead entries — every classified method exists on the wire', () => {
    const live = new Set(snapshotMethods)
    const dead = [...WIRE_SURFACE].filter(m => !live.has(m)).sort()
    expect(dead).toEqual([])
  })

  it('keeps the three buckets disjoint', () => {
    const user = [...USER_ALLOWED]
    const overlapWithAdmin = user.filter(m => ADMIN_ONLY_METHODS.has(m))
    const overlapWithInternal = user.filter(m => HOST_INTERNAL_METHODS.has(m))
    const adminInternal = [...ADMIN_ONLY_METHODS].filter(m => HOST_INTERNAL_METHODS.has(m))
    expect(overlapWithAdmin).toEqual([])
    expect(overlapWithInternal).toEqual([])
    expect(adminInternal).toEqual([])
  })

  it('keeps the bucket sizes deliberate', () => {
    // A silent shrink here means a user feature was demoted without a test
    // change; a silent growth means the admin boundary moved.
    expect(USER_ALLOWED.size).toBe(119)
    expect(ADMIN_ONLY_METHODS.size).toBe(79)
    expect(HOST_INTERNAL_METHODS.size).toBe(1)
  })

  it('cross-checks the live registry when a DSH checkout is reachable', () => {
    const checkout = liveCheckout()
    if (checkout === undefined) {
      // No checkout on this machine: the vendored snapshot is the authority.
      expect(snapshotMethods.length).toBe(199)
      return
    }
    const live = enumerateWireSurface(checkout)
    if (live.length !== snapshotMethods.length) {
      // A checkout of a different wire generation (a dev tree, an older or
      // newer release) is not comparable against this pinned snapshot: the
      // strict total/disjoint checks above stay authoritative, and the next
      // watch re-pins the snapshot. Without this guard the default
      // `../deepseek-harness` dev checkout would fail every test run between
      // watches.
      return
    }
    const unclassified = live.filter(m => !isKnownWireMethod(m)).sort()
    const vanished = snapshotMethods.filter(m => !live.includes(m)).sort()
    expect(unclassified).toEqual([])
    expect(vanished).toEqual([])
  })

  it('grants every method issue #4 reported as denied', () => {
    // The three symptoms: choosing a model, adding a workspace directory, and
    // the settings→models provider catalog.
    for (const method of [
      'session.modelCatalog',
      'session.selectModel',
      'session.initializeDefaultModel',
      'llm.listProviders',
      'llm.listConfigurableProviders',
      'llm.discoverModels',
      'directoryPicker.pick',
      'directoryPicker.list',
      'directoryPicker.createDirectory',
      'workspace.create',
      'workspace.follow',
      'session.page',
      'skills.list',
      'goals.create',
    ]) {
      expect(isUserAllowed(method), `${method} must be user-reachable`).toBe(true)
      expect(classifyWireMethod(method)).toBe('user')
    }
  })

  it('keeps the retired pre-0.1.5 spellings out of the allow-list', () => {
    // These names appeared in dsh-login ≤ 0.3.5 and never existed on this wire
    // line; leaving them in is what made the allow-list look complete.
    for (const method of [
      'session.history', 'session.models', 'subagent.list', 'subagent.history',
      'subagent.prompt', 'subagent.interrupt', 'host.describe', 'workspace.list',
      'workspaceFiles.readAll', 'workspaceFiles.readRelated', 'skill.list',
      'llm.providers', 'llm.models', 'goal.create', 'goal.edit', 'goal.pause',
      'goal.resume', 'goal.complete', 'goal.clear', 'respond',
    ]) {
      expect(isUserAllowed(method), `${method} must not be allow-listed`).toBe(false)
      expect(isKnownWireMethod(method), `${method} is not on the wire`).toBe(false)
    }
  })

  it('denies the admin-only surface to ordinary users', () => {
    for (const method of [
      'credentials.set', 'settings.update', 'agentPresets.select',
      'pluginManager.installBundle', 'pluginMarket.setIndexes',
      'account.startSignIn', 'dynamicCordisRunner.invoke', 'pluginInventory.list',
    ]) {
      expect(isUserAllowed(method)).toBe(false)
      expect(classifyWireMethod(method)).toBe('admin')
    }
  })
})
