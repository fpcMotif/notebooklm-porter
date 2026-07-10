/**
 * Background message router (design §4) — moved out of background.ts so the
 * dispatch table is unit-testable against in-memory Layers instead of only
 * exercisable through the real extension. `background.ts` is now just the
 * `runtime.onMessage` listener glue over `handlePorterMessage`.
 */
import { Effect } from 'effect'
import { discoverAccounts } from './accounts/discover'
import { adapterForUrl } from './adapters/registry'
import { backupDocsToDrive } from './backup/client'
import { ProtocolDrift, type PorterError } from './fx/errors'
import { DebugLog, type Http, type Identity, type Kv, Tabs } from './fx/services'
import { formatCapture } from './format/format'
import { exportDocs } from './ingest/export'
import { ingestIntoNotebook } from './ingest/notebooklm'
import { createNotebook, fetchSession, listNotebooks } from './ingest/rpc/client'
import { RPC_IDS } from './ingest/rpc/protocol'
import {
  isExtractResponse,
  type ContentRequest,
  type NotebookMeta,
  type PorterMessage,
  type PorterReply,
} from './messaging'
import { getSettings, updateSettings } from './settings'
import { deleteDoc, listDocs, upsertDoc } from './store'

export type PorterServices = Http | Kv | Identity | DebugLog | Tabs

type Handlers = {
  [K in PorterMessage['type']]: (
    msg: Extract<PorterMessage, { type: K }>,
  ) => Effect.Effect<PorterReply<K>, PorterError, PorterServices>
}

/**
 * Shared by 'porter/capture-page' and 'porter/capture-url' (for
 * `contentScript: true` adapters, e.g. X): relay an extract request to the
 * tab's content script, then format + store whatever it reports.
 */
function captureViaContentScript(tabId: number) {
  return Effect.gen(function* () {
    const tabs = yield* Tabs
    const response = yield* tabs.sendMessage(tabId, {
      type: 'porter/extract-thread',
    } satisfies ContentRequest)
    if (!isExtractResponse(response)) {
      return { ok: false as const, error: 'Malformed content-script response' }
    }
    if (!response.ok) {
      return { ok: false as const, error: response.error }
    }
    const doc = formatCapture(response.capture)
    yield* upsertDoc(doc)
    return { ok: true as const, docs: [doc] }
  })
}

/**
 * createNotebook's (CCqFvf) response shape is unverified live, so any id we
 * can pull from it is a hint only — probes the row shape listNotebooks uses
 * (title at [0], id at [2]) both flat and one level nested, mirroring how
 * parseNotebookList tolerates both live shapes.
 */
function parseCreatedNotebookId(raw: unknown): string | undefined {
  for (const candidate of [raw, Array.isArray(raw) ? raw[0] : undefined]) {
    if (Array.isArray(candidate) && typeof candidate[2] === 'string') {
      return candidate[2]
    }
  }
  return undefined
}

/**
 * The freshly re-listed notebooks are the source of truth (design note):
 * prefer matching the id parsed from the create response, falling back to
 * the newest (first) notebook with a matching title.
 */
function locateCreatedNotebook(
  notebooks: NotebookMeta[],
  title: string,
  createResult: unknown,
): NotebookMeta | undefined {
  const parsedId = parseCreatedNotebookId(createResult)
  if (parsedId !== undefined) {
    const byId = notebooks.find((n) => n.id === parsedId)
    if (byId) return byId
  }
  return notebooks.find((n) => n.title === title)
}

const handlers: Handlers = {
  'porter/detect': (msg) => {
    const capturable = adapterForUrl(msg.url)?.detect(msg.url)
    return Effect.succeed({
      ok: true as const,
      ...(capturable ? { capturable: capturable.label } : {}),
    })
  },
  'porter/capture-url': (msg) => {
    const adapter = adapterForUrl(msg.url)
    if (adapter?.contentScript) {
      return captureViaContentScript(msg.tabId)
    }
    const captureFromUrl = adapter?.captureFromUrl
    if (!captureFromUrl) {
      return Effect.succeed({ ok: false as const, error: 'Nothing capturable on this page' })
    }
    return Effect.gen(function* () {
      const capture = yield* captureFromUrl(msg.url)
      const doc = formatCapture(capture)
      yield* upsertDoc(doc)
      return { ok: true as const, docs: [doc] }
    })
  },
  'porter/capture-page': (msg) => captureViaContentScript(msg.tabId),
  'porter/capture-result': (msg) =>
    Effect.gen(function* () {
      const doc = formatCapture(msg.capture)
      yield* upsertDoc(doc)
      return { ok: true as const, docs: [doc] }
    }),
  'porter/list-docs': () =>
    Effect.gen(function* () {
      const docs = yield* listDocs()
      return { ok: true as const, docs }
    }),
  'porter/delete-doc': (msg) =>
    Effect.gen(function* () {
      yield* deleteDoc(msg.docId)
      return { ok: true as const }
    }),
  'porter/export': (msg) =>
    Effect.gen(function* () {
      yield* exportDocs(msg.docIds, msg.format)
      return { ok: true as const }
    }),
  'porter/ingest': (msg) =>
    Effect.gen(function* () {
      const settings = yield* getSettings()
      const ingest = yield* ingestIntoNotebook(msg.docIds, {
        authuser: settings.nblmAuthuser,
        notebookId: msg.notebookId,
      })
      return { ok: true as const, ingest }
    }),
  'porter/list-notebooks': () =>
    Effect.gen(function* () {
      const settings = yield* getSettings()
      const session = yield* fetchSession(settings.nblmAuthuser)
      const notebooks = yield* listNotebooks(session, settings.nblmAuthuser)
      return { ok: true as const, notebooks }
    }),
  'porter/create-notebook': (msg) =>
    Effect.gen(function* () {
      const settings = yield* getSettings()
      const session = yield* fetchSession(settings.nblmAuthuser)
      const createResult = yield* createNotebook(msg.title, session, settings.nblmAuthuser)
      const notebooks = yield* listNotebooks(session, settings.nblmAuthuser)
      const created = locateCreatedNotebook(notebooks, msg.title, createResult)
      if (!created) {
        return yield* Effect.fail(
          new ProtocolDrift({
            rpcId: RPC_IDS.createNotebook,
            snippet: `created notebook "${msg.title}" not found in the re-listed notebooks`,
          }),
        )
      }
      return { ok: true as const, notebooks, created }
    }),
  'porter/accounts-refresh': () =>
    Effect.gen(function* () {
      const accounts = yield* discoverAccounts()
      const current = yield* getSettings()
      const stillValid = accounts.some((a) => a.authuser === current.nblmAuthuser)
      const nblmAuthuser = stillValid ? current.nblmAuthuser : (accounts[0]?.authuser ?? 0)
      yield* updateSettings({ accounts, nblmAuthuser })
      return { ok: true as const, accounts }
    }),
  'porter/get-settings': () =>
    Effect.gen(function* () {
      const settings = yield* getSettings()
      return { ok: true as const, settings }
    }),
  'porter/update-settings': (msg) =>
    Effect.gen(function* () {
      const settings = yield* updateSettings(msg.patch)
      return { ok: true as const, settings }
    }),
  'porter/backup-drive': (msg) =>
    Effect.gen(function* () {
      const backup = yield* backupDocsToDrive(msg.docIds)
      return { ok: true as const, backup }
    }),
  'porter/debug-log': () =>
    Effect.gen(function* () {
      const debugLog = yield* DebugLog
      const debugLogEntries = yield* debugLog.entries()
      return { ok: true as const, debugLog: debugLogEntries }
    }),
  'porter/debug-clear': () =>
    Effect.gen(function* () {
      const debugLog = yield* DebugLog
      yield* debugLog.clear()
      return { ok: true as const }
    }),
}

/**
 * Central seam mapping the tagged error taxonomy (design §4) to friendly,
 * user-facing strings. Every message handler funnels its failure channel
 * through this ONE place so the wire shape (`PorterReply`) stays a plain
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
      IpcError: (e) => Effect.succeed({ ok: false as const, error: e.reason }),
    }),
  )
}

/** Single background entrypoint: dispatch + friendly-error flattening. Never fails. */
export function handlePorterMessage(
  msg: PorterMessage,
): Effect.Effect<PorterReply<PorterMessage['type']>, never, PorterServices> {
  // Correlated-union dispatch needs one local cast; the Handlers type above keeps it honest.
  const handler = handlers[msg.type] as (
    m: PorterMessage,
  ) => Effect.Effect<PorterReply<PorterMessage['type']>, PorterError, PorterServices>
  return toFriendlyError(handler(msg))
}
