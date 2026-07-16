/**
 * Background message router (design §4) — moved out of background.ts so the
 * dispatch table is unit-testable against in-memory Layers instead of only
 * exercisable through the real extension. `background.ts` is now just the
 * `runtime.onMessage` listener glue over `handlePorterMessage`.
 */
import { Effect } from 'effect'
import { discoverAccounts } from './accounts/discover'
import { accountBindingFor, sameAccountBinding, verifyNotebookTarget } from './accounts/ownership'
import { captureSource, captureViaContentScript } from './adapters/capture'
import { resolveCapturable } from './adapters/registry'
import { backupDocsToDrive } from './backup/client'
import type { PorterError } from './fx/errors'
import { Alarms, DebugLog, type Http, type Identity, type Kv, type Tabs } from './fx/services'
import { formatCapture } from './format/format'
import { exportDocs } from './ingest/export'
import {
  removeSourceDuplicates,
  retryNotebookSource,
  scanSourceConsole,
} from './ingest/sources/console'
import { planIngestUnits } from './ingest/units'
import { type PorterMessage, type PorterReply } from './messaging'
import type { Capture } from './model/types'
import {
  createCatalogNotebook,
  readNotebookCatalog,
  refreshNotebookCatalog,
} from './notebooks/catalog'
import { getSettings, notebookTargetPatch, updateSettings } from './settings'
import { QUEUE_ALARM, enqueueUnits, queueSnapshot, retryJob } from './queue/queue'
import { loadQueue, saveQueue } from './queue/store'
import { deleteDoc, listDocs, storeCapturedDoc } from './store'
import { loadLedger, partitionSynced } from './store/ledger'
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
 * Storage consistency footprints used by background.ts for serialization.
 * Mutators declare every written domain. Consistency-sensitive reads declare
 * the lane whose committed state they must observe. Unrelated reads declare
 * []. Exhaustive over PorterMessage: a new message needs an explicit policy.
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
  'porter/get-settings': ['settings'],
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

/** Formats and persists a fresh capture, then replies with the stored doc. */
function storeAndReply(capture: Capture) {
  return Effect.gen(function* () {
    const doc = formatCapture(capture)
    yield* storeCapturedDoc(doc)
    return { ok: true as const, docs: [doc] }
  })
}

const handlers: Handlers = {
  'porter/detect': (msg) => {
    const capturable = resolveCapturable(msg.url)?.capturable
    return Effect.succeed({
      ok: true as const,
      ...(capturable ? { capturable: capturable.label } : {}),
      ...(capturable?.canEnrichTranscripts === true ? { canEnrichTranscripts: true as const } : {}),
    })
  },
  'porter/capture-url': (msg) => {
    const resolved = resolveCapturable(msg.url)
    if (resolved === undefined) {
      return Effect.succeed({ ok: false as const, error: 'Nothing capturable on this page' })
    }
    return captureSource(resolved, {
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
      const { target } = yield* verifyNotebookTarget(msg.target)
      const docs = yield* listDocs()
      const requested = new Set(msg.docIds)
      const selectedDocs = docs.filter((doc) => requested.has(doc.id))
      const units = selectedDocs.flatMap(planIngestUnits)
      // Skip units already receipted for this notebook so a re-ingest can't
      // create a second copy of an unchanged source. The logged breakdown also
      // exposes whether the ledger actually remembers a prior run.
      const ledger = yield* loadLedger()
      const { pending: pendingUnits, synced, changed } = partitionSynced(ledger, target, units)
      const queue = yield* loadQueue()
      const next = enqueueUnits(queue, target, pendingUnits, new Date().toISOString())
      yield* saveQueue(next)
      const debugLog = yield* DebugLog
      yield* debugLog.log('queue', 'enqueue', {
        notebookId: target.notebookId,
        requestedDocs: selectedDocs.length,
        plannedUnits: units.length,
        alreadySynced: synced.length,
        changed,
        enqueued: pendingUnits.length,
        pending: next.jobs.length,
      })
      const sites = Array.from(new Set(selectedDocs.map((doc) => doc.site)))
      if (sites.length > 0) {
        const settings = yield* getSettings()
        const currentBinding = accountBindingFor(settings)
        if (currentBinding !== undefined && sameAccountBinding(currentBinding, target)) {
          yield* updateSettings({
            notebookTargets: notebookTargetPatch(
              settings.notebookTargets,
              sites,
              target.notebookId,
            ),
          })
        }
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
      const { target } = yield* verifyNotebookTarget(msg.target)

      const doc = (yield* listDocs()).find((candidate) => candidate.id === msg.docId)
      if (doc === undefined) {
        return { ok: false as const, error: 'The captured source no longer exists' }
      }
      if (!canWatchSource(doc)) {
        return { ok: false as const, error: 'This source cannot be resynced in the background yet' }
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
      const notebooks = yield* msg.forceRefresh === true
        ? refreshNotebookCatalog(msg.account)
        : readNotebookCatalog(msg.account)
      return { ok: true as const, notebooks }
    }),
  'porter/create-notebook': (msg) =>
    Effect.gen(function* () {
      const result = yield* createCatalogNotebook(msg.account, msg.title)
      return { ok: true as const, ...result }
    }),
  'porter/nblm-scan-console': (msg) =>
    Effect.gen(function* () {
      const scan = yield* scanSourceConsole(msg.target)
      return { ok: true as const, scan }
    }),
  'porter/nblm-dedupe': (msg) =>
    Effect.gen(function* () {
      const result = yield* removeSourceDuplicates(msg.target)
      return { ok: true as const, ...result }
    }),
  'porter/nblm-retry-source': (msg) =>
    Effect.gen(function* () {
      const scan = yield* retryNotebookSource(msg.target, msg.sourceId)
      return { ok: true as const, scan }
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
      NotebookCreationUncertain: () =>
        Effect.succeed({
          ok: false as const,
          error: 'Notebook creation may have succeeded. Refresh notebooks before retrying.',
        }),
      NotebookTitleInvalid: () =>
        Effect.succeed({ ok: false as const, error: 'Enter a notebook title' }),
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
