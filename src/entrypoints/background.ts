import { Effect } from 'effect'
import { adapterForUrl } from '../core/adapters/registry'
import { discoverAccounts } from '../core/accounts/discover'
import { backupDocsToDrive } from '../core/backup/client'
import { clearDebugLog, dbg, getDebugLog } from '../core/debug'
import type { PorterError } from '../core/fx/errors'
import { porterRuntime } from '../core/fx/runtime'
import type { DebugLog, Http, Identity, Kv } from '../core/fx/services'
import { formatCapture } from '../core/format/format'
import { exportDocs } from '../core/ingest/export'
import { ingestIntoNotebook } from '../core/ingest/notebooklm'
import { fetchSession, listNotebooks } from '../core/ingest/rpc/client'
import { isPorterMessage, type PorterMessage, type PorterResponse } from '../core/messaging'
import { deleteDoc, listDocs, upsertDoc } from '../core/store'
import { getSettings, updateSettings } from '../core/settings'

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isPorterMessage(message)) return
    porterRuntime
      .runPromise(handle(message))
      .then(sendResponse)
      .catch((err: unknown) => {
        const detail = err instanceof Error && err.stack ? err.stack : err
        console.error('[porter]', message.type, detail)
        dbg('bg', `${message.type} failed`, {
          error: String(err),
          ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
        })
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
      })
    return true
  })
})

/**
 * Central seam mapping the tagged error taxonomy (design §4) to friendly,
 * user-facing strings. Every message handler funnels its failure channel
 * through this ONE place so the wire shape (`PorterResponse`) stays a plain
 * `{ ok: false, error: string }` regardless of which service failed.
 */
function toFriendlyError<A, R>(
  effect: Effect.Effect<A, PorterError, R>,
): Effect.Effect<A | { ok: false; error: string }, never, R> {
  return effect.pipe(
    Effect.catchTags({
      NotLoggedIn: (e) =>
        Effect.succeed({
          ok: false as const,
          error: `Not signed in to notebooklm.google.com for account ${e.authuser} — open it and sign in`,
        }),
      ProtocolDrift: (e) =>
        Effect.succeed({
          ok: false as const,
          error: `NotebookLM protocol changed (drift): ${e.snippet}`,
        }),
      RpcRefused: (e) =>
        Effect.succeed({ ok: false as const, error: `NotebookLM refused (${e.code})` }),
      DriveAuthError: (e) =>
        Effect.succeed({ ok: false as const, error: `Drive authorization failed: ${e.reason}` }),
      DriveApiError: (e) =>
        Effect.succeed({
          ok: false as const,
          error: `Drive request failed during ${e.step} (${e.status})`,
        }),
      HttpStatusError: (e) =>
        Effect.succeed({
          ok: false as const,
          error: `Request to ${e.url} failed (${e.status})`,
        }),
      FetchError: (e) =>
        Effect.succeed({ ok: false as const, error: `Network request to ${e.url} failed` }),
      StorageError: (e) =>
        Effect.succeed({ ok: false as const, error: `Storage error on "${e.key}"` }),
      ExtractionError: (e) =>
        Effect.succeed({ ok: false as const, error: `Couldn't read ${e.url}: ${e.reason}` }),
    }),
  )
}

function handle(
  msg: PorterMessage,
): Effect.Effect<PorterResponse, never, Http | Kv | Identity | DebugLog> {
  return toFriendlyError(handleMsg(msg))
}

function handleMsg(
  msg: PorterMessage,
): Effect.Effect<PorterResponse, PorterError, Http | Kv | Identity | DebugLog> {
  switch (msg.type) {
    case 'porter/detect': {
      const capturable = adapterForUrl(msg.url)?.detect(msg.url)
      return Effect.succeed({ ok: true, ...(capturable ? { capturable: capturable.label } : {}) })
    }
    case 'porter/capture-url': {
      const captureFromUrl = adapterForUrl(msg.url)?.captureFromUrl
      if (!captureFromUrl) {
        return Effect.succeed({ ok: false, error: 'Nothing capturable on this page' })
      }
      return Effect.gen(function* () {
        const capture = yield* captureFromUrl(msg.url)
        const doc = formatCapture(capture)
        yield* upsertDoc(doc)
        return { ok: true, docs: [doc] } satisfies PorterResponse
      })
    }
    case 'porter/capture-page': {
      return Effect.gen(function* () {
        const response: unknown = yield* Effect.promise(() =>
          browser.tabs.sendMessage(msg.tabId, { type: 'porter/extract-thread' }),
        )
        const result = response as { ok: boolean; capture?: unknown; error?: string }
        if (!result.ok || !result.capture) {
          return { ok: false, error: result.error ?? 'Extraction failed' } satisfies PorterResponse
        }
        const doc = formatCapture(result.capture as Parameters<typeof formatCapture>[0])
        yield* upsertDoc(doc)
        return { ok: true, docs: [doc] } satisfies PorterResponse
      })
    }
    case 'porter/capture-result': {
      return Effect.gen(function* () {
        const doc = formatCapture(msg.capture)
        yield* upsertDoc(doc)
        return { ok: true, docs: [doc] } satisfies PorterResponse
      })
    }
    case 'porter/list-docs':
      return Effect.gen(function* () {
        const docs = yield* listDocs()
        return { ok: true, docs } satisfies PorterResponse
      })
    case 'porter/delete-doc':
      return Effect.gen(function* () {
        yield* deleteDoc(msg.docId)
        return { ok: true } satisfies PorterResponse
      })
    case 'porter/export':
      return Effect.gen(function* () {
        yield* exportDocs(msg.docIds, msg.format)
        return { ok: true } satisfies PorterResponse
      })
    case 'porter/ingest':
      return Effect.gen(function* () {
        const settings = yield* getSettings()
        const ingest = yield* ingestIntoNotebook(msg.docIds, {
          authuser: settings.nblmAuthuser,
          notebookId: msg.notebookId,
        })
        return { ok: true, ingest } satisfies PorterResponse
      })
    case 'porter/list-notebooks':
      return Effect.gen(function* () {
        const settings = yield* getSettings()
        const session = yield* fetchSession(settings.nblmAuthuser)
        const notebooks = yield* listNotebooks(session, settings.nblmAuthuser)
        return { ok: true, notebooks } satisfies PorterResponse
      })
    case 'porter/accounts-refresh':
      return Effect.gen(function* () {
        const accounts = yield* discoverAccounts()
        const current = yield* getSettings()
        const stillValid = accounts.some((a) => a.authuser === current.nblmAuthuser)
        const nblmAuthuser = stillValid ? current.nblmAuthuser : (accounts[0]?.authuser ?? 0)
        yield* updateSettings({ accounts, nblmAuthuser })
        return { ok: true, accounts } satisfies PorterResponse
      })
    case 'porter/get-settings':
      return Effect.gen(function* () {
        const settings = yield* getSettings()
        return { ok: true, settings } satisfies PorterResponse
      })
    case 'porter/update-settings':
      return Effect.gen(function* () {
        const settings = yield* updateSettings(msg.patch)
        return { ok: true, settings } satisfies PorterResponse
      })
    case 'porter/backup-drive':
      return Effect.gen(function* () {
        const backup = yield* backupDocsToDrive(msg.docIds)
        return { ok: true, backup } satisfies PorterResponse
      })
    case 'porter/debug-log':
      return Effect.gen(function* () {
        const debugLog = yield* Effect.promise(() => getDebugLog())
        return { ok: true, debugLog } satisfies PorterResponse
      })
    case 'porter/debug-clear':
      return Effect.gen(function* () {
        yield* Effect.promise(() => clearDebugLog())
        return { ok: true } satisfies PorterResponse
      })
  }
}
