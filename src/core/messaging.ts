import type { NblmAccount } from './accounts/parse'
import type { BackupOutcome } from './backup/client'
import type { IngestOutcome } from './ingest/notebooklm'
import type { Capture, SourceDoc } from './model/types'
import type { PorterSettings } from './settings'

/**
 * Every runtime message in the extension, discriminated on `type`.
 * Popup → background drives the whole pipeline; content scripts only
 * ever report captures or execute ingest steps.
 */
export type PorterMessage =
  /** Popup asks: what can the active tab capture, and what's already stored? */
  | { type: 'porter/detect'; url: string }
  /** Popup asks the background to capture the given tab's URL (URL-capturable sites). */
  | { type: 'porter/capture-url'; url: string; tabId: number }
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
  /** Popup requests ingest of stored docs into the given NotebookLM notebook. */
  | { type: 'porter/ingest'; docIds: string[]; notebookId: string }
  /** Popup asks the background to list notebooks in the active NBLM account. */
  | { type: 'porter/list-notebooks' }
  /** Popup asks the background to re-scan signed-in NotebookLM accounts. */
  | { type: 'porter/accounts-refresh' }
  /** Popup reads persisted settings. */
  | { type: 'porter/get-settings' }
  /** Popup persists a settings patch. */
  | { type: 'porter/update-settings'; patch: Partial<PorterSettings> }
  /** Popup requests backup of stored docs into the user's Google Drive. */
  | { type: 'porter/backup-drive'; docIds: string[] }

export type PorterResponse =
  | {
      ok: true
      docs?: SourceDoc[]
      capturable?: string
      settings?: PorterSettings
      accounts?: NblmAccount[]
      backup?: BackupOutcome[]
      notebooks?: { id: string; title: string }[]
      ingest?: IngestOutcome[]
    }
  | { ok: false; error: string }

/** Typed wrapper over runtime.sendMessage. */
export function sendMessage(msg: PorterMessage): Promise<PorterResponse> {
  return browser.runtime.sendMessage(msg) as Promise<PorterResponse>
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
