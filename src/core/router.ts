/**
 * Background message router (design §4) — moved out of background.ts so the
 * dispatch table is unit-testable against in-memory Layers instead of only
 * exercisable through the real extension. `background.ts` is now just the
 * `runtime.onMessage` listener glue over `handlePorterMessage`.
 */
import { Effect } from 'effect'
import { discoverAccounts } from './accounts/discover'
import { captureSource, captureViaContentScript } from './adapters/capture'
import { adapterForUrl } from './adapters/registry'
import { backupDocsToDrive } from './backup/client'
import { IpcError, NotLoggedIn, ProtocolDrift, type PorterError } from './fx/errors'
import { Alarms, DebugLog, type Http, type Identity, type Kv, type Tabs } from './fx/services'
import { formatCapture } from './format/format'
import { exportDocs } from './ingest/export'
import {
  createNotebook,
  deleteSource,
  fetchSession,
  listNotebooks,
  listSources,
  refreshSource,
  type NblmSession,
} from './ingest/rpc/client'
import { RPC_IDS } from './ingest/rpc/protocol'
import { scanSources } from './ingest/sources/console'
import { duplicateRemovalIds, findDuplicateGroups } from './ingest/sources/dedup'
import { planIngestUnits } from './ingest/units'
import { type NotebookMeta, type PorterMessage, type PorterReply } from './messaging'
import type { Capture, SourceDoc } from './model/types'
import { getSettings, notebookTargetPatch, updateSettings, type PorterSettings } from './settings'
import { QUEUE_ALARM, enqueueUnits, queueSnapshot, retryJob, type QueueTarget } from './queue/queue'
import { loadQueue, saveQueue } from './queue/store'
import { deleteDoc, listDocs, upsertDoc } from './store'
import { diffAgainstLedger, loadLedger } from './store/ledger'
import {
  cacheNotebooks,
  loadNotebookCache,
  readCachedNotebooks,
  saveNotebookCache,
} from './store/notebooks-cache'
import { canWatchSource } from './watch/eligibility'
import { armNextWatch } from './watch/resync'
import { loadWatches, saveWatches } from './watch/store'
import { removeWatch, removeWatchesForSourceDoc, upsertWatch, watchSnapshot } from './watch/watch'

export type PorterServices = Http | Kv | Identity | DebugLog | Tabs | Alarms

type Handlers = {
  [K in PorterMessage['type']]: (
    msg: Extract<PorterMessage, { type: K }>,
  ) => Effect.Effect<PorterReply<K>, PorterError, PorterServices>
}

export type StorageDomain = 'docs' | 'watches' | 'queue' | 'settings'

/** Fixed global lane-acquisition order; multi-domain work always acquires in this order so the composition stays deadlock-free. */
export const LANE_ORDER: readonly StorageDomain[] = ['docs', 'watches', 'queue', 'settings']

/**
 * Which storage domains each message's handler MUTATES — the serialization
 * contract background.ts derives its lanes from. Exhaustive over
 * PorterMessage['type']: adding a message type without declaring its
 * footprint is a compile error. Read-only handlers declare [] and run
 * unserialized (readers may see a snapshot mid-write; all writes go through
 * a lane).
 */
export const MESSAGE_DOMAINS: { [K in PorterMessage['type']]: readonly StorageDomain[] } = {
  'porter/detect': [],
  'porter/capture-url': ['docs'],
  'porter/capture-page': ['docs'],
  'porter/capture-result': ['docs'],
  'porter/list-docs': [],
  'porter/delete-doc': ['docs', 'watches'],
  'porter/export': [],
  'porter/queue-enqueue': ['queue', 'settings'],
  'porter/queue-status': ['queue'],
  'porter/queue-retry': ['queue'],
  'porter/watch-create': ['watches'],
  'porter/watch-list': ['watches'],
  'porter/watch-remove': ['watches'],
  // Writes the notebooks-cache (a read-modify-write on its own Kv key), but
  // the cache is browse-only, so a lost cache update is harmless — runs unserialized.
  'porter/list-notebooks': [],
  'porter/create-notebook': [],
  'porter/nblm-scan-console': [],
  'porter/nblm-dedupe': [],
  'porter/nblm-retry-source': [],
  'porter/accounts-refresh': ['settings'],
  'porter/get-settings': [],
  'porter/update-settings': ['settings'],
  // Remote Drive upload + local reads only; no local Kv key is mutated.
  'porter/backup-drive': [],
  'porter/debug-log': [],
  'porter/debug-clear': [],
}

/** Domains for one message type, in LANE_ORDER, [] for unknown wire types. */
export function domainsForMessage(type: string): readonly StorageDomain[] {
  const entry = (MESSAGE_DOMAINS as Record<string, readonly StorageDomain[]>)[type]
  if (entry === undefined) return []
  return LANE_ORDER.filter((domain) => entry.includes(domain))
}

/**
 * Persists a freshly captured doc and records a content-free summary in the
 * debug ring — counts and kinds, never titles or bodies — so a copied log
 * shows what capture produced without leaking the captured text.
 */
function storeCapturedDoc(doc: SourceDoc) {
  return Effect.gen(function* () {
    yield* upsertDoc(doc)
    const debugLog = yield* DebugLog
    yield* debugLog.log('capture', 'stored', {
      docId: doc.id,
      site: doc.site,
      kind: doc.kind,
      wordCount: doc.wordCount,
      truncated: doc.truncated,
      ...(doc.videoDocs !== undefined ? { videoTranscripts: doc.videoDocs.length } : {}),
    })
  })
}

/** Formats and persists a fresh capture, then replies with the stored doc. */
function storeAndReply(capture: Capture) {
  return Effect.gen(function* () {
    const doc = formatCapture(capture)
    yield* storeCapturedDoc(doc)
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
 * only ids absent from the PRE-create list are candidates, so a stale hint
 * echoing a pre-existing notebook's id (or a same-titled pre-existing
 * notebook) can never be mistaken for the one we just created — among the
 * new ids, prefer the parsed-id match, then a title match, else the first.
 */
function locateCreatedNotebook(
  before: NotebookMeta[],
  notebooks: NotebookMeta[],
  title: string,
  createResult: unknown,
): NotebookMeta | undefined {
  const priorIds = new Set(before.map((notebook) => notebook.id))
  const newNotebooks = notebooks.filter((notebook) => !priorIds.has(notebook.id))
  if (newNotebooks.length === 0) return undefined
  const parsedId = parseCreatedNotebookId(createResult)
  const byId =
    parsedId !== undefined ? newNotebooks.find((notebook) => notebook.id === parsedId) : undefined
  return byId ?? newNotebooks.find((notebook) => notebook.title === title) ?? newNotebooks[0]
}

/** Read-after-write lag budget for the post-create re-list (design note). */
const CREATE_NOTEBOOK_RELIST_RETRIES = 2
const CREATE_NOTEBOOK_RELIST_DELAY = '400 millis'

/** Cache is browse-only and is written only after a fresh authenticated list succeeds. */
function cacheFreshNotebooks(session: NblmSession, authuser: number, notebooks: NotebookMeta[]) {
  const email = session.email
  if (email === undefined) return Effect.void
  return Effect.gen(function* () {
    const cache = yield* loadNotebookCache()
    yield* saveNotebookCache(
      cacheNotebooks(cache, {
        authuser,
        email,
        notebooks,
        refreshedAt: new Date().toISOString(),
      }),
    )
  })
}

/** Validates a requested notebook against the current authenticated account. */
function verifyTargetNotebook(
  notebookId: string,
): Effect.Effect<
  { settings: PorterSettings; target: QueueTarget },
  PorterError,
  Http | Kv | DebugLog
> {
  return Effect.gen(function* () {
    const settings = yield* getSettings()
    const account = settings.accounts.find(
      (candidate) => candidate.authuser === settings.nblmAuthuser,
    )
    if (account === undefined)
      return yield* Effect.fail(new NotLoggedIn({ authuser: settings.nblmAuthuser }))

    const session = yield* fetchSession(settings.nblmAuthuser)
    if (session.email === undefined || session.email !== account.email) {
      return yield* Effect.fail(new NotLoggedIn({ authuser: settings.nblmAuthuser }))
    }
    const notebooks = yield* listNotebooks(session, settings.nblmAuthuser)
    if (!notebooks.some((notebook) => notebook.id === notebookId)) {
      return yield* Effect.fail(
        new IpcError({ reason: 'Choose a notebook from the current account' }),
      )
    }
    return {
      settings,
      target: {
        notebookId,
        authuser: settings.nblmAuthuser,
        accountEmail: session.email,
      },
    }
  })
}

/**
 * Resolves an authenticated NBLM session for the active account, asserting the
 * signed-in email matches the selected account (same guard as
 * `verifyTargetNotebook`, minus the notebook-existence round-trip — the console
 * only ever targets a notebook the popup already listed for this account).
 */
function authenticatedNblm(): Effect.Effect<
  { session: NblmSession; authuser: number },
  PorterError,
  Http | Kv | DebugLog
> {
  return Effect.gen(function* () {
    const settings = yield* getSettings()
    const account = settings.accounts.find(
      (candidate) => candidate.authuser === settings.nblmAuthuser,
    )
    if (account === undefined) {
      return yield* Effect.fail(new NotLoggedIn({ authuser: settings.nblmAuthuser }))
    }
    const session = yield* fetchSession(settings.nblmAuthuser)
    if (session.email === undefined || session.email !== account.email) {
      return yield* Effect.fail(new NotLoggedIn({ authuser: settings.nblmAuthuser }))
    }
    return { session, authuser: settings.nblmAuthuser }
  })
}

const handlers: Handlers = {
  'porter/detect': (msg) => {
    const capturable = adapterForUrl(msg.url)?.detect(msg.url)
    return Effect.succeed({
      ok: true as const,
      ...(capturable ? { capturable: capturable.label } : {}),
      ...(capturable?.canEnrichTranscripts === true ? { canEnrichTranscripts: true as const } : {}),
    })
  },
  'porter/capture-url': (msg) => {
    const adapter = adapterForUrl(msg.url)
    if (adapter === undefined) {
      return Effect.succeed({ ok: false as const, error: 'Nothing capturable on this page' })
    }
    return captureSource(adapter, msg.url, {
      tabId: msg.tabId,
      ...(msg.options !== undefined ? { options: msg.options } : {}),
    }).pipe(Effect.flatMap(storeAndReply))
  },
  'porter/capture-page': (msg) =>
    captureViaContentScript(msg.tabId).pipe(Effect.flatMap(storeAndReply)),
  'porter/capture-result': (msg) => storeAndReply(msg.capture),
  'porter/list-docs': () =>
    Effect.gen(function* () {
      const docs = yield* listDocs()
      return { ok: true as const, docs }
    }),
  'porter/delete-doc': (msg) =>
    Effect.gen(function* () {
      yield* deleteDoc(msg.docId)
      const watches = yield* loadWatches()
      const next = removeWatchesForSourceDoc(watches, msg.docId)
      yield* saveWatches(next)
      yield* armNextWatch(next)
      return { ok: true as const }
    }),
  'porter/export': (msg) =>
    Effect.gen(function* () {
      yield* exportDocs(msg.docIds, msg.format)
      return { ok: true as const }
    }),
  'porter/queue-enqueue': (msg) =>
    Effect.gen(function* () {
      const { settings, target } = yield* verifyTargetNotebook(msg.notebookId)
      const docs = yield* listDocs()
      const requested = new Set(msg.docIds)
      const selectedDocs = docs.filter((doc) => requested.has(doc.id))
      const units = selectedDocs.flatMap(planIngestUnits)
      // Skip units already receipted for this notebook so a re-ingest can't
      // create a second copy of an unchanged source. The logged breakdown also
      // exposes whether the ledger actually remembers a prior run.
      const ledger = yield* loadLedger()
      const diff = diffAgainstLedger(
        ledger,
        msg.notebookId,
        units.map((unit) => ({ id: unit.id, contentHash: unit.contentHash })),
      )
      const alreadySynced = new Set(diff.unchanged)
      const pendingUnits = units.filter((unit) => !alreadySynced.has(unit.id))
      const queue = yield* loadQueue()
      const next = enqueueUnits(queue, target, pendingUnits, new Date().toISOString())
      yield* saveQueue(next)
      const debugLog = yield* DebugLog
      yield* debugLog.log('queue', 'enqueue', {
        notebookId: msg.notebookId,
        requestedDocs: selectedDocs.length,
        plannedUnits: units.length,
        alreadySynced: diff.unchanged.length,
        changed: diff.changed.length,
        enqueued: pendingUnits.length,
        pending: next.jobs.length,
      })
      const sites = Array.from(new Set(selectedDocs.map((doc) => doc.site)))
      if (sites.length > 0) {
        yield* updateSettings({
          notebookTargets: notebookTargetPatch(settings.notebookTargets, sites, msg.notebookId),
        })
      }
      const alarms = yield* Alarms
      yield* alarms.schedule(QUEUE_ALARM, Date.now())
      return { ok: true as const, queue: queueSnapshot(next) }
    }),
  'porter/queue-status': () =>
    Effect.gen(function* () {
      const queue = yield* loadQueue()
      return { ok: true as const, queue: queueSnapshot(queue) }
    }),
  'porter/queue-retry': (msg) =>
    Effect.gen(function* () {
      let queue = yield* loadQueue()
      const now = new Date().toISOString()
      for (const jobId of msg.jobIds) queue = retryJob(queue, jobId, now)
      yield* saveQueue(queue)
      const alarms = yield* Alarms
      yield* alarms.schedule(QUEUE_ALARM, Date.now())
      return { ok: true as const, queue: queueSnapshot(queue) }
    }),
  'porter/watch-create': (msg) =>
    Effect.gen(function* () {
      const { target } = yield* verifyTargetNotebook(msg.notebookId)

      const doc = (yield* listDocs()).find((candidate) => candidate.id === msg.docId)
      if (doc === undefined) {
        return yield* Effect.fail(new IpcError({ reason: 'The captured source no longer exists' }))
      }
      if (!canWatchSource(doc)) {
        return yield* Effect.fail(
          new IpcError({ reason: 'This source cannot be resynced in the background yet' }),
        )
      }

      const watches = yield* loadWatches()
      const next = upsertWatch(watches, {
        sourceDocId: doc.id,
        sourceUrl: doc.canonicalUrl,
        target,
        ...(doc.videoDocs !== undefined && doc.videoDocs.length > 0
          ? { captureOptions: { enrichTranscripts: true as const } }
          : {}),
        now: new Date().toISOString(),
      })
      yield* saveWatches(next)
      yield* armNextWatch(next)
      return { ok: true as const, watches: watchSnapshot(next) }
    }),
  'porter/watch-list': () =>
    Effect.gen(function* () {
      const watches = yield* loadWatches()
      return { ok: true as const, watches: watchSnapshot(watches) }
    }),
  'porter/watch-remove': (msg) =>
    Effect.gen(function* () {
      const watches = yield* loadWatches()
      const next = removeWatch(watches, msg.watchId)
      yield* saveWatches(next)
      yield* armNextWatch(next)
      return { ok: true as const, watches: watchSnapshot(next) }
    }),
  'porter/list-notebooks': (msg) =>
    Effect.gen(function* () {
      const settings = yield* getSettings()
      const session = yield* fetchSession(settings.nblmAuthuser)
      if (msg.forceRefresh !== true && session.email !== undefined) {
        const cache = yield* loadNotebookCache()
        const cached = readCachedNotebooks(cache, settings.nblmAuthuser, session.email)
        if (cached !== undefined) return { ok: true as const, notebooks: cached }
      }
      const notebooks = yield* listNotebooks(session, settings.nblmAuthuser)
      yield* cacheFreshNotebooks(session, settings.nblmAuthuser, notebooks)
      return { ok: true as const, notebooks }
    }),
  'porter/create-notebook': (msg) =>
    Effect.gen(function* () {
      const settings = yield* getSettings()
      const session = yield* fetchSession(settings.nblmAuthuser)
      const before = yield* listNotebooks(session, settings.nblmAuthuser)
      const createResult = yield* createNotebook(msg.title, session, settings.nblmAuthuser)

      let notebooks = yield* listNotebooks(session, settings.nblmAuthuser)
      let created = locateCreatedNotebook(before, notebooks, msg.title, createResult)
      // Backend read-after-write lag: the re-list can still reflect the
      // pre-create state for a beat, so give it a couple more tries before
      // declaring drift (which would otherwise invite a duplicate create).
      for (let attempt = 0; !created && attempt < CREATE_NOTEBOOK_RELIST_RETRIES; attempt++) {
        yield* Effect.sleep(CREATE_NOTEBOOK_RELIST_DELAY)
        notebooks = yield* listNotebooks(session, settings.nblmAuthuser)
        created = locateCreatedNotebook(before, notebooks, msg.title, createResult)
      }
      if (!created) {
        return yield* Effect.fail(
          new ProtocolDrift({
            rpcId: RPC_IDS.createNotebook,
            snippet: `created notebook "${msg.title}" not found in the re-listed notebooks`,
          }),
        )
      }
      yield* cacheFreshNotebooks(session, settings.nblmAuthuser, notebooks)
      return { ok: true as const, notebooks, created }
    }),
  'porter/nblm-scan-console': (msg) =>
    Effect.gen(function* () {
      const { session, authuser } = yield* authenticatedNblm()
      const sources = yield* listSources(msg.notebookId, session, authuser)
      const scan = scanSources(sources)
      const debugLog = yield* DebugLog
      yield* debugLog.log('console', 'scan', {
        notebookId: msg.notebookId,
        sources: sources.length,
        duplicateGroups: scan.duplicateGroups.length,
        duplicates: scan.duplicateCount,
        failed: scan.failed.length,
      })
      return { ok: true as const, scan }
    }),
  'porter/nblm-dedupe': (msg) =>
    Effect.gen(function* () {
      const { session, authuser } = yield* authenticatedNblm()
      const sources = yield* listSources(msg.notebookId, session, authuser)
      const removalIds = duplicateRemovalIds(findDuplicateGroups(sources))
      const debugLog = yield* DebugLog
      yield* debugLog.log('console', 'dedupe', {
        notebookId: msg.notebookId,
        sources: sources.length,
        removing: removalIds.length,
      })
      // Sequential + idempotent: DELETE_SOURCE succeeds even for an
      // already-absent source, and the post-delete re-list is the source of
      // truth, so a mid-batch failure surfaces without leaving a false count.
      const removedIds: string[] = []
      for (const sourceId of removalIds) {
        yield* deleteSource(msg.notebookId, sourceId, session, authuser)
        removedIds.push(sourceId)
      }
      const fresh = yield* listSources(msg.notebookId, session, authuser)
      return { ok: true as const, scan: scanSources(fresh), removedIds }
    }),
  'porter/nblm-retry-source': (msg) =>
    Effect.gen(function* () {
      const { session, authuser } = yield* authenticatedNblm()
      yield* refreshSource(msg.notebookId, msg.sourceId, session, authuser)
      const debugLog = yield* DebugLog
      yield* debugLog.log('console', 'retry', {
        notebookId: msg.notebookId,
        sourceId: msg.sourceId,
      })
      const fresh = yield* listSources(msg.notebookId, session, authuser)
      return { ok: true as const, scan: scanSources(fresh) }
    }),
  'porter/accounts-refresh': () =>
    Effect.gen(function* () {
      const accounts = yield* discoverAccounts()
      const current = yield* getSettings()
      const currentEmail = current.accounts.find(
        (account) => account.authuser === current.nblmAuthuser,
      )?.email
      const stillValid =
        currentEmail !== undefined &&
        accounts.some(
          (account) => account.authuser === current.nblmAuthuser && account.email === currentEmail,
        )
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
      AlarmError: (e) =>
        Effect.succeed({ ok: false as const, error: `Queue ${e.operation} failed` }),
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
