import { Effect } from 'effect'
import { DebugLog } from '../../fx/services'
import type { DomDeliveryRequest, DomDeliveryResult } from './contracts'
import { DomTabs } from './driver'

/**
 * The queue's single DOM seam. Tab lifecycle and content-script transport
 * remain behind `DomTabs`; queue code only sees an auditable outcome.
 */
export function deliverViaDom(
  request: DomDeliveryRequest,
): Effect.Effect<DomDeliveryResult, never, DomTabs | DebugLog> {
  return Effect.gen(function* () {
    const domTabs = yield* DomTabs
    const debugLog = yield* DebugLog
    const run = request.unit.id
    // Paired start/finish: an MV3 worker death between them proves Tier B was reached.
    yield* debugLog.log(
      'ingest-dom',
      'deliver attempt',
      { notebookId: request.notebookId, kind: request.unit.kind },
      { run },
    )
    const result = yield* domTabs.deliver(request)
    const reason = 'reason' in result ? result.reason : undefined
    yield* debugLog.log(
      'ingest-dom',
      `deliver ${result.status}`,
      reason !== undefined ? { reason } : {},
      { run, ...(result.status !== 'sent' ? { level: 'warn' as const } : {}) },
    )
    return result
  })
}
