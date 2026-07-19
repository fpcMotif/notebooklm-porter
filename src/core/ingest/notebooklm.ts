import { Effect } from 'effect'
import type { FetchError, HttpStatusError, ProtocolDrift, RpcRefused } from '../fx/errors'
import { DebugLog, Http } from '../fx/services'
import { addTextSource, addYoutubeSource, type NblmSession } from './rpc/client'
import type { IngestUnit } from './units'

/**
 * Typed single-unit RPC delivery primitive: posts one already-planned source
 * mutation via the batchexecute RPC (izAoDd) from the service worker.
 *
 * This is not an orchestrator — it has no ledger access, no retry policy, and
 * no fallback routing. The durable queue (../queue/drain.ts) owns all of
 * that; it calls this function once per job and decides what a typed RPC
 * failure means for that job's receipt.
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
