import { Effect, Result } from 'effect'
import type {
  FetchError,
  HttpStatusError,
  NotLoggedIn,
  ProtocolDrift,
  RpcRefused,
  StorageError,
} from '../fx/errors'
import { DebugLog, Http, Kv } from '../fx/services'
import { listDocs } from '../store'
import { diffAgainstLedger, loadLedger, recordSynced, saveLedger } from '../store/ledger'
import { addTextSource, addYoutubeSource, fetchSession, type NblmSession } from './rpc/client'
import { planIngestUnits, type IngestUnit } from './units'

/**
 * Direct RPC delivery helper retained for legacy callers and tests:
 *
 *   Tier A  batchexecute RPC (izAoDd) from the service worker  — primary
 *   Tier B  DOM automation on an open notebooklm.google.com tab — fallback
 *   Tier C  file export (see ./export.ts)                       — floor
 *
 * The durable queue owns fallback routing, target validation, and receipts.
 * Do not add a second DOM-fallback policy here: a failed mutating RPC is not
 * proof that the source was not created.
 */
export type IngestTier = 'rpc' | 'dom' | 'file'
export type IngestStatus = 'sent' | 'skipped' | 'failed'

export interface IngestOutcome {
  docId: string
  unitId: string
  ok: boolean
  status: IngestStatus
  tier: IngestTier
  error?: string
}

/**
 * Executes one already-planned source mutation. The queue owns the durable
 * receipt and retry policy around this operation; this function deliberately
 * exposes the typed RPC failure so callers can make that decision.
 */
export function sendIngestUnit(
  unit: IngestUnit,
  notebookId: string,
  session: NblmSession,
  authuser: number,
): Effect.Effect<void, FetchError | HttpStatusError | ProtocolDrift | RpcRefused, Http | DebugLog> {
  return Effect.gen(function* () {
    const debugLog = yield* DebugLog

    yield* debugLog.log('ingest', unit.id, { kind: unit.kind, docId: unit.docId })
    yield* unit.kind === 'text'
      ? addTextSource(notebookId, unit.title, unit.markdown, session, authuser)
      : addYoutubeSource(notebookId, unit.url, session, authuser)
  })
}

function ingestOneUnit(
  unit: IngestUnit,
  notebookId: string,
  session: NblmSession,
  authuser: number,
): Effect.Effect<IngestOutcome, never, Http | DebugLog> {
  return Effect.gen(function* () {
    const debugLog = yield* DebugLog
    const result = yield* Effect.result(sendIngestUnit(unit, notebookId, session, authuser))
    if (Result.isFailure(result)) {
      const message = String(result.failure)
      yield* debugLog.log('ingest', `${unit.id} failed`, { error: message })
      return {
        docId: unit.docId,
        unitId: unit.id,
        ok: false,
        status: 'failed',
        tier: 'rpc' as const,
        error: message,
      }
    }
    return { docId: unit.docId, unitId: unit.id, ok: true, status: 'sent', tier: 'rpc' as const }
  })
}

export function ingestIntoNotebook(
  docIds: string[],
  opts: { authuser?: number; notebookId: string },
): Effect.Effect<
  IngestOutcome[],
  FetchError | HttpStatusError | NotLoggedIn | ProtocolDrift | RpcRefused | StorageError,
  Http | Kv | DebugLog
> {
  return Effect.gen(function* () {
    const authuser = opts.authuser ?? 0

    // Session/store failures propagate untouched so background.ts's
    // toFriendlyError (NotLoggedIn, ProtocolDrift, etc.) can map them —
    // only per-unit RPC failures below get stringified into IngestOutcome.
    const session = yield* fetchSession(authuser)
    const docs = yield* listDocs()
    const byId = new Map(docs.map((doc) => [doc.id, doc]))
    let ledger = yield* loadLedger()

    const outcomes: IngestOutcome[] = []
    for (const docId of docIds) {
      const doc = byId.get(docId)
      if (doc === undefined) {
        outcomes.push({
          docId,
          unitId: docId,
          ok: false,
          status: 'failed',
          tier: 'rpc',
          error: 'Doc not found',
        })
        continue
      }
      for (const unit of planIngestUnits(doc)) {
        const diff = diffAgainstLedger(ledger, opts.notebookId, [unit])
        if (diff.unchanged.length > 0) {
          outcomes.push({
            docId: unit.docId,
            unitId: unit.id,
            ok: true,
            status: 'skipped',
            tier: 'rpc',
          })
          continue
        }

        // Sequential by necessity: NotebookLM source mutations against one
        // notebook must not be concurrent. Persist each success before moving
        // to the next unit so an MV3 interruption never loses known progress.
        const outcome = yield* ingestOneUnit(unit, opts.notebookId, session, authuser)
        outcomes.push(outcome)
        if (!outcome.ok) continue

        ledger = recordSynced(ledger, opts.notebookId, [
          { id: unit.id, contentHash: unit.contentHash, now: new Date().toISOString() },
        ])
        yield* saveLedger(ledger)
      }
    }
    return outcomes
  })
}
