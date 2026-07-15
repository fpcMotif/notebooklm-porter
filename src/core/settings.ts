import { Effect } from 'effect'
import type { NblmAccount } from './accounts/parse'
import type { StorageError } from './fx/errors'
import { kvSlot } from './fx/kv-slot'
import { Kv } from './fx/services'
import type { SiteId } from './model/types'

const KEY = 'porter/settings'

/** The last successful NotebookLM destination for each captured source site. */
export type NotebookTargets = Partial<Record<SiteId, string>>

/**
 * Cross-cutting extension settings: discovered NotebookLM Google accounts
 * to target for ingest.
 */
export interface PorterSettings {
  nblmAuthuser: number
  accounts: NblmAccount[]
  /** Remembered destination IDs. The popup validates each against the active account's fresh list. */
  notebookTargets: NotebookTargets
  /** Google OAuth Client ID (Chrome Extension type) for Drive backup. */
  driveClientId?: string
}

export const DEFAULT_SETTINGS: PorterSettings = {
  nblmAuthuser: 0,
  accounts: [],
  notebookTargets: {},
}

/**
 * Keeps a manual choice when it belongs to the freshly listed account;
 * otherwise uses a remembered destination only when every captured site
 * agrees on the same valid target, then falls back to the first currently
 * listed notebook. Stored IDs are never trusted on their own, so a target
 * from another account cannot leak into an ingest.
 */
export function resolveNotebookTarget(
  notebooks: readonly { id: string }[],
  docs: readonly { site: SiteId }[],
  targets: NotebookTargets,
  currentId = '',
): string {
  if (notebooks.some((notebook) => notebook.id === currentId)) return currentId

  const remembered: string[] = []
  for (const doc of docs) {
    const target = targets[doc.site]
    if (target === undefined || !notebooks.some((notebook) => notebook.id === target)) break
    remembered.push(target)
  }
  if (remembered.length === docs.length && new Set(remembered).size === 1)
    return remembered[0] ?? ''

  return notebooks[0]?.id ?? ''
}

/** Returns a patch that records one notebook as the successful destination for each site. */
export function notebookTargetPatch(
  current: NotebookTargets,
  sites: readonly SiteId[],
  notebookId: string,
): NotebookTargets {
  const next = { ...current }
  for (const site of sites) next[site] = notebookId
  return next
}

const settingsSlot = kvSlot<PorterSettings>(
  KEY,
  () => ({ ...DEFAULT_SETTINGS }),
  (stored) => ({ ...DEFAULT_SETTINGS, ...(stored as Partial<PorterSettings>) }),
)

export function getSettings(): Effect.Effect<PorterSettings, StorageError, Kv> {
  return settingsSlot.load()
}

export function updateSettings(
  patch: Partial<PorterSettings>,
): Effect.Effect<PorterSettings, StorageError, Kv> {
  return Effect.gen(function* () {
    const current = yield* getSettings()
    const next: PorterSettings = { ...current, ...patch }
    yield* settingsSlot.save(next)
    return next
  })
}
