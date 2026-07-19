/**
 * Versioned remote Tier-B selector / RPC profile, published from a Convex
 * dashboard so a protocol-drift fix ships without a Web Store release. This
 * module is pure: the validator, the remote-vs-bundled ruling, and the
 * module-level application point the selector and RPC-id lookups consult.
 * Fetch, cache, and scheduling live in remote-profile-loader.ts.
 */
import type { DomSelectorProfile } from './dom/selectors'
import { RPC_IDS } from './rpc/protocol'

export const REMOTE_PROFILE_SCHEMA_VERSION = 1

/** Kv/storage key for the cached remote profile (shared by SW loader and content script). */
export const REMOTE_PROFILE_KEY = 'porter/remote-profile/v1'

export type RpcName = keyof typeof RPC_IDS

export interface RemoteProfile {
  schemaVersion: number
  publishedAt: string
  minExtensionVersion: string
  selectors?: DomSelectorProfile
  rpcOverrides?: Partial<Record<RpcName, string>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSelectorList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
}

const SELECTOR_LIST_FIELDS = [
  'addSourceTriggers',
  'copiedTextChoices',
  'titleInputs',
  'textInputs',
  'submitButtons',
  'sourceListSignals',
] as const

function isDomSelectorProfile(value: unknown): value is DomSelectorProfile {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    SELECTOR_LIST_FIELDS.every((field) => isSelectorList(value[field]))
  )
}

/**
 * Unknown override keys are tolerated (a newer server may publish ids for
 * RPCs this build doesn't know); only the values must be usable id strings.
 */
function isRpcOverrides(value: unknown): boolean {
  return (
    isRecord(value) && Object.values(value).every((id) => typeof id === 'string' && id.length > 0)
  )
}

const VERSION_RE = /^\d+(\.\d+)*$/

export function isRemoteProfile(value: unknown): value is RemoteProfile {
  return (
    isRecord(value) &&
    typeof value.schemaVersion === 'number' &&
    Number.isInteger(value.schemaVersion) &&
    typeof value.publishedAt === 'string' &&
    Number.isFinite(Date.parse(value.publishedAt)) &&
    typeof value.minExtensionVersion === 'string' &&
    VERSION_RE.test(value.minExtensionVersion) &&
    (value.selectors === undefined || isDomSelectorProfile(value.selectors)) &&
    (value.rpcOverrides === undefined || isRpcOverrides(value.rpcOverrides))
  )
}

/** Dotted-numeric compare; missing segments count as 0 (so 1.2 === 1.2.0). */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

/** A remote profile applies only on schemas this build understands and versions at/above its floor. */
export function isVersionCompatible(profile: RemoteProfile, extensionVersion: string): boolean {
  return (
    profile.schemaVersion === REMOTE_PROFILE_SCHEMA_VERSION &&
    compareVersions(extensionVersion, profile.minExtensionVersion) >= 0
  )
}

export type ProfileDecision =
  | { source: 'remote'; profile: RemoteProfile }
  | { source: 'bundled'; reason: 'absent' | 'invalid' | 'incompatible' }

/** The single remote-vs-bundled ruling — anything questionable lands on bundled. */
export function decideProfileSource(remote: unknown, extensionVersion: string): ProfileDecision {
  if (remote === undefined || remote === null) return { source: 'bundled', reason: 'absent' }
  if (!isRemoteProfile(remote)) return { source: 'bundled', reason: 'invalid' }
  if (!isVersionCompatible(remote, extensionVersion)) {
    return { source: 'bundled', reason: 'incompatible' }
  }
  return { source: 'remote', profile: remote }
}

/** Kv cache entry: the raw fetched payload, re-validated on every read. */
export interface CachedRemoteProfile {
  profile: unknown
  fetchedAt: string
}

export function isCachedRemoteProfile(value: unknown): value is CachedRemoteProfile {
  return isRecord(value) && 'profile' in value && typeof value.fetchedAt === 'string'
}

/** Unwraps a cache entry; anything but a valid, compatible profile yields undefined (bundled). */
export function remoteProfileFromCache(
  raw: unknown,
  extensionVersion: string,
): RemoteProfile | undefined {
  if (!isCachedRemoteProfile(raw)) return undefined
  const decision = decideProfileSource(raw.profile, extensionVersion)
  return decision.source === 'remote' ? decision.profile : undefined
}

let activeProfile: RemoteProfile | undefined

/**
 * Context-local application point (SW and the NotebookLM content script each
 * apply from the shared Kv cache). Passing undefined restores bundled-only.
 */
export function applyRemoteProfile(profile: RemoteProfile | undefined): void {
  activeProfile = profile
}

export function activeRemoteProfile(): RemoteProfile | undefined {
  return activeProfile
}

export function activeRemoteSelectorProfile(): DomSelectorProfile | undefined {
  return activeProfile?.selectors
}

/** Remote override for one RPC id when applied, else the bundled constant. */
export function effectiveRpcId(name: RpcName): string {
  return activeProfile?.rpcOverrides?.[name] ?? RPC_IDS[name]
}
