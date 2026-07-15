import { Context, Effect } from 'effect'
import type { NblmAccount } from './accounts/parse'
import type { CaptureOptions } from './adapters/types'
import type { BackupOutcome } from './backup/client'
import type { DebugEntry } from './debug'
import { IpcError } from './fx/errors'
import type { DomDeliveryRequest } from './ingest/dom/contracts'
import type { ConsoleScan } from './ingest/sources/console'
import type { Capture, SourceDoc } from './model/types'
import type { QueueSnapshot } from './queue/queue'
import type { PorterSettings } from './settings'
import type { WatchView } from './watch/watch'

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
  | { type: 'porter/queue-enqueue'; docIds: string[]; notebookId: string }
  /** Popup reads durable ingest progress. */
  | { type: 'porter/queue-status' }
  /** Popup explicitly retries failed or uncertain queue jobs. */
  | { type: 'porter/queue-retry'; jobIds: string[] }
  /** Popup enables scheduled resync for one captured, background-capturable source. */
  | { type: 'porter/watch-create'; docId: string; notebookId: string }
  /** Popup reads durable automatic-resync bindings. */
  | { type: 'porter/watch-list' }
  /** Popup removes one automatic-resync binding. */
  | { type: 'porter/watch-remove'; watchId: string }
  /** Popup asks the background to list notebooks in the active NBLM account. */
  | { type: 'porter/list-notebooks'; forceRefresh?: true }
  /** Popup asks the background to create a notebook, then re-list. */
  | { type: 'porter/create-notebook'; title: string }
  /** Console: read a notebook's sources and analyze duplicates + failed loads. */
  | { type: 'porter/nblm-scan-console'; notebookId: string }
  /** Console: auto-remove duplicate sources in a notebook, then re-scan. */
  | { type: 'porter/nblm-dedupe'; notebookId: string }
  /** Console: retry one failed source (re-fetch in place), then re-scan. */
  | { type: 'porter/nblm-retry-source'; notebookId: string; sourceId: string }
  /** Popup asks the background to re-scan signed-in NotebookLM accounts. */
  | { type: 'porter/accounts-refresh' }
  /** Popup reads persisted settings. */
  | { type: 'porter/get-settings' }
  /** Popup persists a settings patch. */
  | { type: 'porter/update-settings'; patch: Partial<PorterSettings> }
  /** Popup requests backup of stored docs into the user's Google Drive. */
  | { type: 'porter/backup-drive'; docIds: string[] }
  /** Popup reads the persisted SW debug ring (SW console isn't reachable from the popup). */
  | { type: 'porter/debug-log' }
  /** Popup clears the persisted SW debug ring. */
  | { type: 'porter/debug-clear' }

/** One row of the notebook picker — a NotebookLM notebook's id + title. */
export type NotebookMeta = { id: string; title: string }

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

export function isExtractResponse(value: unknown): value is ExtractResponse {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false
  const ok = (value as { ok: unknown }).ok
  if (typeof ok !== 'boolean') return false
  if (ok) {
    const capture = (value as { capture?: unknown }).capture
    return typeof capture === 'object' && capture !== null
  }
  const error = (value as { error?: unknown }).error
  return typeof error === 'string'
}

export function isPorterMessage(value: unknown): value is PorterMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string' &&
    (value as { type: string }).type.startsWith('porter/')
  )
}

export interface PorterClientShape {
  readonly request: <K extends PorterMessage['type']>(
    msg: Extract<PorterMessage, { type: K }>,
  ) => Effect.Effect<PorterResponseMap[K], IpcError>
}

export class PorterClient extends Context.Service<PorterClient, PorterClientShape>()(
  'porter/PorterClient',
) {}
