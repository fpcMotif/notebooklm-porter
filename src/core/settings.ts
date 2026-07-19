import { Effect } from 'effect'
import type { NblmAccount } from './accounts/parse'
import type { StorageError } from './fx/errors'
import { kvSlot } from './fx/kv-slot'
import { Kv } from './fx/services'
import { isSiteId, type SiteId } from './model/types'

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

export type SettingsPatch = Partial<PorterSettings>

export const DEFAULT_SETTINGS: PorterSettings = {
  nblmAuthuser: 0,
  accounts: [],
  notebookTargets: {},
}

const SETTING_KEYS = new Set<keyof PorterSettings>([
  'nblmAuthuser',
  'accounts',
  'notebookTargets',
  'driveClientId',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && allowed.includes(key))
}

function decodeAuthuser(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function decodeAccount(value: unknown): NblmAccount | undefined {
  if (!isRecord(value)) return undefined
  if (!Object.hasOwn(value, 'authuser') || !Object.hasOwn(value, 'email')) return undefined
  const authuser = decodeAuthuser(value.authuser)
  if (authuser === undefined || typeof value.email !== 'string' || !value.email.trim())
    return undefined
  return { authuser, email: value.email }
}

function decodeAccounts(value: unknown, strict: boolean): NblmAccount[] | undefined {
  if (!Array.isArray(value)) return undefined
  const accounts: NblmAccount[] = []
  for (const candidate of value) {
    if (strict && (!isRecord(candidate) || !hasOnlyKeys(candidate, ['authuser', 'email'])))
      return undefined
    const account = decodeAccount(candidate)
    if (account === undefined) {
      if (strict) return undefined
      continue
    }
    accounts.push(account)
  }
  return accounts
}

function decodeNotebookTargets(value: unknown, strict: boolean): NotebookTargets | undefined {
  if (!isRecord(value)) return undefined
  const targets: NotebookTargets = {}
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      if (strict) return undefined
      continue
    }
    const site = key
    const notebookId = value[site]
    if (!isSiteId(site)) {
      if (strict) return undefined
      continue
    }
    if (typeof notebookId !== 'string' || !notebookId.trim()) {
      if (strict) return undefined
      continue
    }
    targets[site] = notebookId
  }
  return targets
}

function emptySettings(): PorterSettings {
  return { nblmAuthuser: 0, accounts: [], notebookTargets: {} }
}

/** Strictly validates a popup-originated partial settings update. */
export function decodeSettingsPatch(value: unknown): SettingsPatch | undefined {
  if (
    !isRecord(value) ||
    !Reflect.ownKeys(value).every(
      (key) => typeof key === 'string' && SETTING_KEYS.has(key as keyof PorterSettings),
    )
  )
    return undefined

  const patch: SettingsPatch = {}
  if (Object.hasOwn(value, 'nblmAuthuser')) {
    const nblmAuthuser = decodeAuthuser(value.nblmAuthuser)
    if (nblmAuthuser === undefined) return undefined
    patch.nblmAuthuser = nblmAuthuser
  }
  if (Object.hasOwn(value, 'accounts')) {
    const accounts = decodeAccounts(value.accounts, true)
    if (accounts === undefined) return undefined
    patch.accounts = accounts
  }
  if (Object.hasOwn(value, 'notebookTargets')) {
    const notebookTargets = decodeNotebookTargets(value.notebookTargets, true)
    if (notebookTargets === undefined) return undefined
    patch.notebookTargets = notebookTargets
  }
  if (Object.hasOwn(value, 'driveClientId')) {
    if (typeof value.driveClientId !== 'string') return undefined
    patch.driveClientId = value.driveClientId
  }
  return patch
}

/** Recovers valid stored settings fields while discarding legacy junk. */
export function decodeStoredSettings(value: unknown): PorterSettings {
  if (!isRecord(value)) return emptySettings()

  const nblmAuthuser =
    decodeAuthuser(Object.hasOwn(value, 'nblmAuthuser') ? value.nblmAuthuser : undefined) ?? 0
  const accounts =
    decodeAccounts(Object.hasOwn(value, 'accounts') ? value.accounts : undefined, false) ?? []
  const notebookTargets =
    decodeNotebookTargets(
      Object.hasOwn(value, 'notebookTargets') ? value.notebookTargets : undefined,
      false,
    ) ?? {}
  return {
    nblmAuthuser,
    accounts,
    notebookTargets,
    ...(Object.hasOwn(value, 'driveClientId') && typeof value.driveClientId === 'string'
      ? { driveClientId: value.driveClientId }
      : {}),
  }
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

const settingsSlot = kvSlot<PorterSettings>(KEY, emptySettings, decodeStoredSettings)

export function getSettings(): Effect.Effect<PorterSettings, StorageError, Kv> {
  return settingsSlot.load()
}

export function updateSettings(
  patch: SettingsPatch,
): Effect.Effect<PorterSettings, StorageError, Kv> {
  return Effect.gen(function* () {
    const current = yield* getSettings()
    const next: PorterSettings = { ...current, ...patch }
    yield* settingsSlot.save(next)
    return next
  })
}
