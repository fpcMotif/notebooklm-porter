import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { afterEach } from 'vitest'
import type { DebugEntry } from '../debug'
import { Kv } from '../fx/services'
import { alarmsTest, debugLogTest, httpTest } from '../fx/testing'
import {
  activeRemoteProfile,
  applyRemoteProfile,
  REMOTE_PROFILE_KEY,
  REMOTE_PROFILE_SCHEMA_VERSION,
  type RemoteProfile,
} from './remote-profile'
import {
  REMOTE_PROFILE_ALARM,
  REMOTE_PROFILE_REFRESH_MS,
  refreshRemoteProfile,
} from './remote-profile-loader'

const CONVEX_URL = 'https://demo.convex.cloud'
const QUERY_URL = `${CONVEX_URL}/api/query`
const NOW = Date.parse('2026-07-19T12:00:00.000Z')
const VERSION = '0.1.0'

const remoteProfile: RemoteProfile = {
  schemaVersion: REMOTE_PROFILE_SCHEMA_VERSION,
  publishedAt: '2026-07-18T00:00:00.000Z',
  minExtensionVersion: '0.1.0',
  rpcOverrides: { addSource: 'freshId' },
}

function kvLayer(seed: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(seed))
  const layer = Layer.succeed(
    Kv,
    Kv.of({
      get: <T>(key: string) => Effect.sync(() => store.get(key) as T | undefined),
      set: (key, value) => Effect.sync(() => void store.set(key, value)),
    }),
  )
  return { layer, store }
}

function successBody(value: unknown): string {
  return JSON.stringify({ status: 'success', value })
}

afterEach(() => {
  applyRemoteProfile(undefined)
})

describe('refreshRemoteProfile', () => {
  it.effect('is fully disabled without a convex URL: no fetch, cache and alarm cleared', () =>
    Effect.gen(function* () {
      const kv = kvLayer({
        [REMOTE_PROFILE_KEY]: { profile: remoteProfile, fetchedAt: '2026-07-19T11:00:00.000Z' },
      })
      const cleared: string[] = []
      const requests: { url: string }[] = []
      const result = yield* refreshRemoteProfile({ now: NOW, extensionVersion: VERSION }).pipe(
        Effect.provide(
          Layer.mergeAll(
            kv.layer,
            httpTest({}, requests),
            debugLogTest(),
            alarmsTest({
              onClear: (name) => {
                cleared.push(name)
                return true
              },
            }),
          ),
        ),
      )
      assert.deepStrictEqual(result, { status: 'disabled' })
      assert.deepStrictEqual(requests, [])
      assert.strictEqual(kv.store.get(REMOTE_PROFILE_KEY), null)
      assert.deepStrictEqual(cleared, [REMOTE_PROFILE_ALARM])
      assert.strictEqual(activeRemoteProfile(), undefined)
    }),
  )

  it.effect('fetches, validates, caches, and applies a fresh remote profile', () =>
    Effect.gen(function* () {
      const kv = kvLayer({ 'porter/settings': { convexUrl: CONVEX_URL } })
      const scheduled: { name: string; when: number }[] = []
      const result = yield* refreshRemoteProfile({ now: NOW, extensionVersion: VERSION }).pipe(
        Effect.provide(
          Layer.mergeAll(
            kv.layer,
            httpTest({ [QUERY_URL]: successBody(remoteProfile) }),
            debugLogTest(),
            alarmsTest({ onSchedule: (name, when) => void scheduled.push({ name, when }) }),
          ),
        ),
      )
      assert.deepStrictEqual(result, {
        status: 'applied',
        publishedAt: remoteProfile.publishedAt,
      })
      assert.deepStrictEqual(activeRemoteProfile(), remoteProfile)
      assert.deepStrictEqual(kv.store.get(REMOTE_PROFILE_KEY), {
        profile: remoteProfile,
        fetchedAt: new Date(NOW).toISOString(),
      })
      assert.deepStrictEqual(scheduled, [
        { name: REMOTE_PROFILE_ALARM, when: NOW + REMOTE_PROFILE_REFRESH_MS },
      ])
    }),
  )

  it.effect('serves a fresh cache without refetching', () =>
    Effect.gen(function* () {
      const fetchedAt = new Date(NOW - 1_000).toISOString()
      const kv = kvLayer({
        'porter/settings': { convexUrl: CONVEX_URL },
        [REMOTE_PROFILE_KEY]: { profile: remoteProfile, fetchedAt },
      })
      const requests: { url: string }[] = []
      const result = yield* refreshRemoteProfile({ now: NOW, extensionVersion: VERSION }).pipe(
        Effect.provide(
          Layer.mergeAll(kv.layer, httpTest({}, requests), debugLogTest(), alarmsTest()),
        ),
      )
      assert.deepStrictEqual(result, { status: 'cached', fetchedAt })
      assert.deepStrictEqual(requests, [])
      assert.deepStrictEqual(activeRemoteProfile(), remoteProfile)
    }),
  )

  it.effect('rejects a corrupt remote, keeps the valid cache applied, and logs a warning', () =>
    Effect.gen(function* () {
      const staleFetchedAt = new Date(NOW - REMOTE_PROFILE_REFRESH_MS - 1).toISOString()
      const kv = kvLayer({
        'porter/settings': { convexUrl: CONVEX_URL },
        [REMOTE_PROFILE_KEY]: { profile: remoteProfile, fetchedAt: staleFetchedAt },
      })
      const sink: DebugEntry[] = []
      const result = yield* refreshRemoteProfile({ now: NOW, extensionVersion: VERSION }).pipe(
        Effect.provide(
          Layer.mergeAll(
            kv.layer,
            httpTest({ [QUERY_URL]: successBody({ corrupt: true }) }),
            debugLogTest(sink),
            alarmsTest(),
          ),
        ),
      )
      assert.deepStrictEqual(result, { status: 'fallback', reason: 'invalid' })
      assert.deepStrictEqual(activeRemoteProfile(), remoteProfile)
      // The corrupt payload must not overwrite the last good cache.
      assert.deepStrictEqual(kv.store.get(REMOTE_PROFILE_KEY), {
        profile: remoteProfile,
        fetchedAt: staleFetchedAt,
      })
      assert.isTrue(sink.some((entry) => entry.level === 'warn'))
    }),
  )

  it.effect('falls back to bundled on fetch failure with no cache, still arming the alarm', () =>
    Effect.gen(function* () {
      const kv = kvLayer({ 'porter/settings': { convexUrl: CONVEX_URL } })
      const sink: DebugEntry[] = []
      const scheduled: { name: string; when: number }[] = []
      const result = yield* refreshRemoteProfile({ now: NOW, extensionVersion: VERSION }).pipe(
        Effect.provide(
          Layer.mergeAll(
            kv.layer,
            httpTest({}),
            debugLogTest(sink),
            alarmsTest({ onSchedule: (name, when) => void scheduled.push({ name, when }) }),
          ),
        ),
      )
      assert.deepStrictEqual(result, { status: 'fallback', reason: 'fetch-failed' })
      assert.strictEqual(activeRemoteProfile(), undefined)
      assert.deepStrictEqual(scheduled, [
        { name: REMOTE_PROFILE_ALARM, when: NOW + REMOTE_PROFILE_REFRESH_MS },
      ])
      assert.isTrue(sink.some((entry) => entry.level === 'warn'))
    }),
  )

  it.effect('rejects an incompatible remote (extension below the floor)', () =>
    Effect.gen(function* () {
      const kv = kvLayer({ 'porter/settings': { convexUrl: CONVEX_URL } })
      const result = yield* refreshRemoteProfile({ now: NOW, extensionVersion: '0.0.1' }).pipe(
        Effect.provide(
          Layer.mergeAll(
            kv.layer,
            httpTest({ [QUERY_URL]: successBody(remoteProfile) }),
            debugLogTest(),
            alarmsTest(),
          ),
        ),
      )
      assert.deepStrictEqual(result, { status: 'fallback', reason: 'incompatible' })
      assert.strictEqual(activeRemoteProfile(), undefined)
    }),
  )
})
