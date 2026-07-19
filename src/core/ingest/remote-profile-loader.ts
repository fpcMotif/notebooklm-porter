/**
 * Remote profile loader — protocol drift is the #1 breakage, so on SW start
 * and every ~6h this pulls the latest published profile from the configured
 * Convex deployment, validates it, caches it in Kv, and applies it to the
 * lookup points in remote-profile.ts. Every failure path falls back to the
 * cached-then-bundled profile: a bad remote can never brick ingest, and with
 * no Convex URL configured it does nothing at all.
 */
import { Effect, Result } from 'effect'
import { convexQueryRequest, parseConvexResult } from '../convex/api'
import { Alarms, DebugLog, Http, Kv, withHttpTimeout } from '../fx/services'
import { convexUrlFromSettings, getSettings } from '../settings'
import {
  applyRemoteProfile,
  decideProfileSource,
  isCachedRemoteProfile,
  REMOTE_PROFILE_KEY,
  remoteProfileFromCache,
} from './remote-profile'

export const REMOTE_PROFILE_ALARM = 'porter/remote-profile-refresh'
export const REMOTE_PROFILE_REFRESH_MS = 6 * 60 * 60 * 1_000
export const REMOTE_PROFILE_QUERY = 'profiles:getLatestProfile'

export type RemoteProfileRefresh =
  | { status: 'disabled' }
  | { status: 'cached'; fetchedAt: string }
  | { status: 'applied'; publishedAt: string }
  | { status: 'fallback'; reason: string }

function currentExtensionVersion(): string {
  try {
    return browser.runtime.getManifest().version
  } catch {
    return '0.0.0'
  }
}

/**
 * One refresh pass. Never fails: storage, network, and alarm errors are
 * logged to the debug ring and reported in the returned status instead.
 */
export function refreshRemoteProfile(
  opts: { now?: number; extensionVersion?: string } = {},
): Effect.Effect<RemoteProfileRefresh, never, Kv | Http | DebugLog | Alarms> {
  return Effect.gen(function* () {
    const version = opts.extensionVersion ?? currentExtensionVersion()
    const now = opts.now ?? Date.now()
    const kv = yield* Kv
    const debugLog = yield* DebugLog
    const alarms = yield* Alarms

    const settingsResult = yield* Effect.result(getSettings())
    if (Result.isFailure(settingsResult)) {
      yield* debugLog.log(
        'remote-profile',
        'settings unreadable — bundled profile stays active',
        { error: String(settingsResult.failure) },
        { level: 'warn' },
      )
      return { status: 'fallback' as const, reason: 'settings-unreadable' }
    }
    const url = convexUrlFromSettings(settingsResult.success)
    if (url === undefined) {
      applyRemoteProfile(undefined)
      yield* Effect.result(kv.set(REMOTE_PROFILE_KEY, null))
      yield* Effect.result(alarms.clear(REMOTE_PROFILE_ALARM))
      return { status: 'disabled' as const }
    }

    const cachedResult = yield* Effect.result(kv.get<unknown>(REMOTE_PROFILE_KEY))
    const cached = Result.isSuccess(cachedResult) ? cachedResult.success : undefined

    // A fresh cache short-circuits the fetch: MV3 restarts the SW constantly
    // and the ~6h cadence belongs to the alarm, not to worker lifetimes.
    if (isCachedRemoteProfile(cached)) {
      const fetchedAtMs = Date.parse(cached.fetchedAt)
      if (Number.isFinite(fetchedAtMs) && now - fetchedAtMs < REMOTE_PROFILE_REFRESH_MS) {
        const kept = remoteProfileFromCache(cached, version)
        applyRemoteProfile(kept)
        if (kept === undefined) {
          yield* debugLog.log(
            'remote-profile',
            'cached remote profile rejected — bundled profile active',
            {},
            { level: 'warn' },
          )
        }
        yield* Effect.result(
          alarms.schedule(REMOTE_PROFILE_ALARM, fetchedAtMs + REMOTE_PROFILE_REFRESH_MS),
        )
        return { status: 'cached' as const, fetchedAt: cached.fetchedAt }
      }
    }

    // Arm the next cycle before fetching so one bad fetch can't stop the cadence.
    yield* Effect.result(alarms.schedule(REMOTE_PROFILE_ALARM, now + REMOTE_PROFILE_REFRESH_MS))

    const http = yield* Http
    const request = convexQueryRequest(url, REMOTE_PROFILE_QUERY, {})
    const fetched = yield* Effect.result(
      withHttpTimeout(http.json(request.url, request.init), request.url),
    )

    const keepCached = (reason: string, detail: unknown) =>
      Effect.gen(function* () {
        const kept = remoteProfileFromCache(cached, version)
        applyRemoteProfile(kept)
        yield* debugLog.log(
          'remote-profile',
          `${reason} — ${kept !== undefined ? 'cached' : 'bundled'} profile stays active`,
          { detail },
          { level: 'warn' },
        )
        return { status: 'fallback' as const, reason }
      })

    if (Result.isFailure(fetched)) {
      return yield* keepCached('fetch-failed', String(fetched.failure))
    }
    const decoded = parseConvexResult(fetched.success)
    if (!decoded.ok) {
      return yield* keepCached('convex-error', decoded.error)
    }

    const decision = decideProfileSource(decoded.value, version)
    if (decision.source === 'bundled') {
      if (decision.reason === 'absent') {
        applyRemoteProfile(undefined)
        yield* Effect.result(kv.set(REMOTE_PROFILE_KEY, null))
        yield* debugLog.log(
          'remote-profile',
          'no remote profile published — bundled profile active',
        )
        return { status: 'fallback' as const, reason: 'absent' }
      }
      return yield* keepCached(decision.reason, decoded.value)
    }

    yield* Effect.result(
      kv.set(REMOTE_PROFILE_KEY, {
        profile: decoded.value,
        fetchedAt: new Date(now).toISOString(),
      }),
    )
    applyRemoteProfile(decision.profile)
    yield* debugLog.log('remote-profile', 'remote profile applied', {
      publishedAt: decision.profile.publishedAt,
      hasSelectors: decision.profile.selectors !== undefined,
      rpcOverrides: Object.keys(decision.profile.rpcOverrides ?? {}),
    })
    return { status: 'applied' as const, publishedAt: decision.profile.publishedAt }
  })
}
