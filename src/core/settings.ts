import { Effect } from 'effect'
import { Kv } from './fx/services'
import type { StorageError } from './fx/errors'
import type { NblmAccount } from './accounts/parse'

const KEY = 'porter/settings'

/**
 * Cross-cutting extension settings: discovered NotebookLM Google accounts
 * to target for ingest.
 */
export interface PorterSettings {
  nblmAuthuser: number
  accounts: NblmAccount[]
  /** Google OAuth Client ID (Chrome Extension type) for Drive backup. */
  driveClientId?: string
}

export const DEFAULT_SETTINGS: PorterSettings = {
  nblmAuthuser: 0,
  accounts: [],
}

export function getSettings(): Effect.Effect<PorterSettings, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    const stored = yield* kv.get<Partial<PorterSettings>>(KEY)
    return { ...DEFAULT_SETTINGS, ...stored }
  })
}

export function updateSettings(
  patch: Partial<PorterSettings>,
): Effect.Effect<PorterSettings, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    const current = yield* getSettings()
    const next: PorterSettings = { ...current, ...patch }
    yield* kv.set(KEY, next)
    return next
  })
}
