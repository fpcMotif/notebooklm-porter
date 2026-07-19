import { Context, Effect } from 'effect'
import type { NblmAccount } from './accounts/parse'
import type { NotebookLmAccountBinding, NotebookTarget } from './accounts/ownership'
import type { CaptureOptions } from './adapters/types'
import type { BackupOutcome } from './backup/client'
import type { DebugEntry } from './debug'
import { IpcError } from './fx/errors'
import type { DomDeliveryRequest } from './ingest/dom/contracts'
import type { ConsoleScan } from './ingest/sources/console'
import { decodeCapture } from './model/codec'
import type { Capture, SourceDoc } from './model/types'
import type { QueueSnapshot } from './queue/queue'
import { decodeSettingsPatch, type PorterSettings, type SettingsPatch } from './settings'
import type { WatchView } from './watch/watch'
import type { NotebookMeta } from './notebooks/model'

/**
 * Every runtime message in the extension, discriminated on `type`.
 * Popup → background drives the whole pipeline; content scripts only
 * ever report captures or execute ingest steps.
 */
export type PorterMessage =
  /** Popup asks: what can the active tab capture, and what's already stored? */
  | { type: 'porter/detect'; url: string }
  /** Popup asks the background to capture the given tab's URL (URL-capturable sites). */
  | { type: 'porter/capture-url'; url: string; tabId: number; options?: CaptureOptions }
  /** Popup asks the X content script (via background relay) to extract the open thread. */
  | { type: 'porter/capture-page'; tabId: number }
  /** A content script delivers an extracted capture. */
  | { type: 'porter/capture-result'; capture: Capture }
  /** Popup asks for all stored docs. */
  | { type: 'porter/list-docs' }
  /** Popup deletes a stored doc. */
  | { type: 'porter/delete-doc'; docId: string }
  /** Popup requests export of stored docs as downloaded files. */
  | { type: 'porter/export'; docIds: string[]; format: 'markdown' | 'jsonl' }
  /** Popup queues stored docs for durable background ingest into a notebook. */
  | { type: 'porter/queue-enqueue'; docIds: string[]; target: NotebookTarget }
  /** Popup reads durable ingest progress. */
  | { type: 'porter/queue-status' }
  /** Popup explicitly retries failed or uncertain queue jobs. */
  | { type: 'porter/queue-retry'; jobIds: string[] }
  /** Popup enables scheduled resync for one captured, background-capturable source. */
  | { type: 'porter/watch-create'; docId: string; target: NotebookTarget }
  /** Popup reads durable automatic-resync bindings. */
  | { type: 'porter/watch-list' }
  /** Popup removes one automatic-resync binding. */
  | { type: 'porter/watch-remove'; watchId: string }
  /** Popup asks the background to list notebooks for an immutable account binding. */
  | { type: 'porter/list-notebooks'; account: NotebookLmAccountBinding; forceRefresh?: true }
  /** Popup asks the background to create a notebook for an immutable account binding, then re-list. */
  | { type: 'porter/create-notebook'; account: NotebookLmAccountBinding; title: string }
  /** Console: read a notebook's sources and analyze duplicates + failed loads. */
  | { type: 'porter/nblm-scan-console'; target: NotebookTarget }
  /** Console: auto-remove duplicate sources in a notebook, then re-scan. */
  | { type: 'porter/nblm-dedupe'; target: NotebookTarget }
  /** Console: retry one failed source (re-fetch in place), then re-scan. */
  | { type: 'porter/nblm-retry-source'; target: NotebookTarget; sourceId: string }
  /** Popup asks the background to re-scan signed-in NotebookLM accounts. */
  | { type: 'porter/accounts-refresh' }
  /** Popup reads persisted settings. */
  | { type: 'porter/get-settings' }
  /** Popup persists a settings patch. */
  | { type: 'porter/update-settings'; patch: SettingsPatch }
  /** Popup requests backup of stored docs into the user's Google Drive. */
  | { type: 'porter/backup-drive'; docIds: string[] }
  /** Popup reads the persisted SW debug ring (SW console isn't reachable from the popup). */
  | { type: 'porter/debug-log' }
  /** Popup clears the persisted SW debug ring. */
  | { type: 'porter/debug-clear' }

/** Per-message success payloads — the single source of truth for both sides of the wire. */
export interface PorterResponseMap {
  'porter/detect': { capturable?: string; canEnrichTranscripts?: true }
  'porter/capture-url': { docs: SourceDoc[] }
  'porter/capture-page': { docs: SourceDoc[] }
  'porter/capture-result': { docs: SourceDoc[] }
  'porter/list-docs': { docs: SourceDoc[] }
  'porter/delete-doc': {}
  'porter/export': {}
  'porter/queue-enqueue': { queue: QueueSnapshot }
  'porter/queue-status': { queue: QueueSnapshot }
  'porter/queue-retry': { queue: QueueSnapshot }
  'porter/watch-create': { watches: WatchView[] }
  'porter/watch-list': { watches: WatchView[] }
  'porter/watch-remove': { watches: WatchView[] }
  'porter/list-notebooks': { notebooks: NotebookMeta[] }
  'porter/create-notebook': { notebooks: NotebookMeta[]; created: NotebookMeta }
  'porter/nblm-scan-console': { scan: ConsoleScan }
  'porter/nblm-dedupe': { scan: ConsoleScan; removedIds: string[] }
  'porter/nblm-retry-source': { scan: ConsoleScan }
  'porter/accounts-refresh': { accounts: NblmAccount[] }
  'porter/get-settings': { settings: PorterSettings }
  'porter/update-settings': { settings: PorterSettings }
  'porter/backup-drive': { backup: BackupOutcome[] }
  'porter/debug-log': { debugLog: DebugEntry[] }
  'porter/debug-clear': {}
}

export type PorterFail = { ok: false; error: string }
export type PorterReply<K extends PorterMessage['type']> =
  | ({ ok: true } & PorterResponseMap[K])
  | PorterFail

/** Background → content-script requests. */
export type ContentRequest =
  | { type: 'porter/extract-thread' }
  | { type: 'porter/dom-deliver'; request: DomDeliveryRequest }

export type ExtractResponse = { ok: true; capture: Capture } | { ok: false; error: string }

export function hasMessageType<T extends string>(value: unknown, type: T): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (value as { type: unknown }).type === type
  )
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function decodeNonnegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function decodeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined
  return [...value]
}

function hasOnlyKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key))
}

function decodeAccountBinding(value: unknown): NotebookLmAccountBinding | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['authuser', 'accountEmail'])) return undefined
  const authuser = decodeNonnegativeSafeInteger(value.authuser)
  if (
    authuser === undefined ||
    typeof value.accountEmail !== 'string' ||
    !value.accountEmail.trim()
  )
    return undefined
  return { authuser, accountEmail: value.accountEmail }
}

function decodeNotebookTarget(value: unknown): NotebookTarget | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['authuser', 'accountEmail', 'notebookId']))
    return undefined
  const authuser = decodeNonnegativeSafeInteger(value.authuser)
  if (
    authuser === undefined ||
    typeof value.accountEmail !== 'string' ||
    !value.accountEmail.trim() ||
    typeof value.notebookId !== 'string' ||
    !value.notebookId.trim()
  )
    return undefined
  return { authuser, accountEmail: value.accountEmail, notebookId: value.notebookId }
}

function decodeCaptureOptions(value: unknown): CaptureOptions | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['enrichTranscripts'])) return undefined
  if (Object.hasOwn(value, 'enrichTranscripts') && value.enrichTranscripts !== true)
    return undefined
  return Object.hasOwn(value, 'enrichTranscripts') ? { enrichTranscripts: true } : {}
}

function decodeOptionalCaptureOptions(value: UnknownRecord): CaptureOptions | undefined | null {
  if (!Object.hasOwn(value, 'options')) return undefined
  return decodeCaptureOptions(value.options) ?? null
}

function decodeOptionalForceRefresh(value: UnknownRecord): true | undefined | null {
  if (!Object.hasOwn(value, 'forceRefresh')) return undefined
  return value.forceRefresh === true ? true : null
}

/** Decodes a content-script extract reply into a canonical value. */
export function decodeExtractResponse(value: unknown): ExtractResponse | undefined {
  if (!isRecord(value)) return undefined
  if (value.ok === true) {
    const capture = decodeCapture(value.capture)
    return capture === undefined ? undefined : { ok: true, capture }
  }
  return value.ok === false && typeof value.error === 'string'
    ? { ok: false, error: value.error }
    : undefined
}

/** Decodes a runtime message into a canonical, known protocol value. */
export function decodePorterMessage(value: unknown): PorterMessage | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined

  switch (value.type) {
    case 'porter/detect':
      return typeof value.url === 'string' ? { type: value.type, url: value.url } : undefined
    case 'porter/capture-url': {
      const tabId = decodeNonnegativeSafeInteger(value.tabId)
      const options = decodeOptionalCaptureOptions(value)
      return typeof value.url === 'string' && tabId !== undefined && options !== null
        ? { type: value.type, url: value.url, tabId, ...(options !== undefined ? { options } : {}) }
        : undefined
    }
    case 'porter/capture-page': {
      const tabId = decodeNonnegativeSafeInteger(value.tabId)
      return tabId === undefined ? undefined : { type: value.type, tabId }
    }
    case 'porter/capture-result': {
      const capture = decodeCapture(value.capture)
      return capture === undefined ? undefined : { type: value.type, capture }
    }
    case 'porter/list-docs':
    case 'porter/queue-status':
    case 'porter/watch-list':
    case 'porter/accounts-refresh':
    case 'porter/get-settings':
    case 'porter/debug-log':
    case 'porter/debug-clear':
      return { type: value.type }
    case 'porter/delete-doc':
      return typeof value.docId === 'string' ? { type: value.type, docId: value.docId } : undefined
    case 'porter/watch-remove':
      return typeof value.watchId === 'string'
        ? { type: value.type, watchId: value.watchId }
        : undefined
    case 'porter/export': {
      const docIds = decodeStringArray(value.docIds)
      return docIds !== undefined && (value.format === 'markdown' || value.format === 'jsonl')
        ? { type: value.type, docIds, format: value.format }
        : undefined
    }
    case 'porter/queue-enqueue': {
      const docIds = decodeStringArray(value.docIds)
      const target = decodeNotebookTarget(value.target)
      return docIds !== undefined && target !== undefined
        ? { type: value.type, docIds, target }
        : undefined
    }
    case 'porter/queue-retry': {
      const jobIds = decodeStringArray(value.jobIds)
      return jobIds === undefined ? undefined : { type: value.type, jobIds }
    }
    case 'porter/watch-create': {
      const target = decodeNotebookTarget(value.target)
      return typeof value.docId === 'string' && target !== undefined
        ? { type: value.type, docId: value.docId, target }
        : undefined
    }
    case 'porter/list-notebooks': {
      const account = decodeAccountBinding(value.account)
      const forceRefresh = decodeOptionalForceRefresh(value)
      return account !== undefined && forceRefresh !== null
        ? {
            type: value.type,
            account,
            ...(forceRefresh !== undefined ? { forceRefresh } : {}),
          }
        : undefined
    }
    case 'porter/create-notebook': {
      const account = decodeAccountBinding(value.account)
      return account !== undefined && typeof value.title === 'string'
        ? { type: value.type, account, title: value.title }
        : undefined
    }
    case 'porter/nblm-scan-console':
    case 'porter/nblm-dedupe': {
      const target = decodeNotebookTarget(value.target)
      return target === undefined ? undefined : { type: value.type, target }
    }
    case 'porter/nblm-retry-source': {
      const target = decodeNotebookTarget(value.target)
      return target !== undefined && typeof value.sourceId === 'string'
        ? { type: value.type, target, sourceId: value.sourceId }
        : undefined
    }
    case 'porter/update-settings': {
      const patch = decodeSettingsPatch(value.patch)
      return patch === undefined ? undefined : { type: value.type, patch }
    }
    case 'porter/backup-drive': {
      const docIds = decodeStringArray(value.docIds)
      return docIds === undefined ? undefined : { type: value.type, docIds }
    }
    default:
      return undefined
  }
}

export interface PorterClientShape {
  readonly request: <K extends PorterMessage['type']>(
    msg: Extract<PorterMessage, { type: K }>,
  ) => Effect.Effect<PorterResponseMap[K], IpcError>
}

export class PorterClient extends Context.Service<PorterClient, PorterClientShape>()(
  'porter/PorterClient',
) {}

/** Turns a wire-level `PorterReply` into its typed payload or a failure. */
export function unwrapPorterReply<K extends PorterMessage['type']>(
  reply: PorterReply<K>,
): Effect.Effect<PorterResponseMap[K], IpcError> {
  if (!reply.ok) {
    return Effect.fail(new IpcError({ reason: reply.error }))
  }
  const { ok: _ok, ...payload } = reply
  // Documented cast: TS can't carry the `Omit<..., 'ok'>` shape through the
  // generic `K` back to `PorterResponseMap[K]` — this is the only remaining
  // cast on the popup↔background wire (the transport cast in PorterClientLive
  // is the other).
  return Effect.succeed(payload as unknown as PorterResponseMap[K])
}
