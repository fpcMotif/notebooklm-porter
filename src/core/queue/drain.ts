import { Effect, Result } from 'effect'
import {
  authenticateBoundAccount,
  type BoundAccountAuthentication,
  type NotebookLmAccountBinding,
} from '../accounts/ownership'
import {
  FetchError,
  HttpStatusError,
  NotLoggedIn,
  ProtocolDrift,
  RpcRefused,
  type AlarmError,
  type StorageError,
} from '../fx/errors'
import { Alarms, DebugLog, DomTabs, Http, Kv } from '../fx/services'
import { deliverViaDom } from '../ingest/dom/delivery'
import { sendIngestUnit } from '../ingest/notebooklm'
import { listNotebooks } from '../ingest/rpc/client'
import {
  degradeForPreflightDrift,
  loadTierState,
  recoverAfterHealthyPreflight,
  routeForTierA,
  saveTierState,
} from '../ingest/tier-state'
import { isUnitSynced, loadLedger, recordSynced, saveLedger, type Ledger } from '../store/ledger'
import {
  QUEUE_ALARM,
  markInFlight,
  nextDueAt,
  pickNext,
  reapInterrupted,
  removeJob,
  settleRetryableFailure,
  settleTerminalFailure,
  settleUncertain,
  type QueueJob,
  type QueueState,
} from './queue'
import { loadQueue, saveQueue } from './store'

export type QueueFailure = FetchError | HttpStatusError | NotLoggedIn | ProtocolDrift | RpcRefused

export type QueueFailureDisposition =
  | { status: 'uncertain'; error: string }
  | { status: 'failed'; error: string }
  | { status: 'blocked'; error: string }

export type DrainResult =
  | { status: 'idle' }
  | { status: 'sent'; jobId: string }
  | { status: 'retrying'; jobId: string }
  | { status: 'uncertain'; jobId: string }
  | { status: 'failed'; jobId: string }
  | { status: 'blocked'; jobId: string }

function accountBindingKey(binding: NotebookLmAccountBinding): string {
  return JSON.stringify([binding.authuser, binding.accountEmail])
}

/** Maps only known typed transport failures into the queue's durable states. */
export function classifyQueueFailure(failure: QueueFailure): QueueFailureDisposition {
  if (failure instanceof NotLoggedIn) {
    return {
      status: 'blocked',
      error: `Not signed in to NotebookLM account ${failure.authuser}`,
    }
  }
  if (failure instanceof ProtocolDrift) {
    return {
      status: 'uncertain',
      error: `NotebookLM source result is unknown after protocol drift: ${failure.snippet}`,
    }
  }
  if (failure instanceof RpcRefused) {
    return { status: 'failed', error: `NotebookLM refused the source: ${failure.code}` }
  }
  if (failure instanceof HttpStatusError) {
    return failure.status >= 500 || failure.status === 429
      ? { status: 'uncertain', error: `NotebookLM result is unknown (${failure.status})` }
      : { status: 'failed', error: `NotebookLM request failed (${failure.status})` }
  }
  return { status: 'uncertain', error: 'NotebookLM result is unknown after a network failure' }
}

function removeReceiptedJobs(queue: QueueState, ledger: Ledger): QueueState {
  let next = queue
  for (const job of queue.jobs) {
    if (isUnitSynced(ledger, job.target, job.unit)) {
      next = removeJob(next, job.id)
    }
  }
  return next
}

function armNextDrain(queue: QueueState, now: string): Effect.Effect<void, AlarmError, Alarms> {
  return Effect.gen(function* () {
    const alarms = yield* Alarms
    const due = nextDueAt(queue, now)
    if (due === undefined) {
      yield* alarms.clear(QUEUE_ALARM)
      return
    }
    yield* alarms.schedule(QUEUE_ALARM, Date.parse(due))
  })
}

function settleFailure(
  queue: QueueState,
  job: QueueJob,
  failure: QueueFailure,
  now: string,
): { queue: QueueState; status: QueueFailureDisposition['status'] } {
  const disposition = classifyQueueFailure(failure)
  return {
    queue:
      disposition.status === 'uncertain'
        ? settleUncertain(queue, job.id, disposition.error, now)
        : settleTerminalFailure(queue, job.id, disposition.error, now, disposition.status),
    status: disposition.status,
  }
}

function settlePreflightFailure(
  queue: QueueState,
  job: QueueJob,
  failure: FetchError | HttpStatusError | NotLoggedIn,
  now: string,
): { queue: QueueState; status: 'retrying' | 'failed' | 'blocked' } {
  if (failure instanceof NotLoggedIn) {
    return {
      queue: settleTerminalFailure(
        queue,
        job.id,
        'Not signed in to the queued NotebookLM account',
        now,
        'blocked',
      ),
      status: 'blocked',
    }
  }
  const settledQueue = settleRetryableFailure(
    queue,
    job.id,
    'Could not establish the queued NotebookLM session',
    now,
  )
  const settledJob = settledQueue.jobs.find((candidate) => candidate.id === job.id)
  return { queue: settledQueue, status: settledJob?.status === 'retrying' ? 'retrying' : 'failed' }
}

/**
 * Drains every currently-due job in one pass. Identity (session) and the
 * read-only tier-A canary (listNotebooks) are fetched ONCE per account and
 * reused across the burst — the earlier one-preflight-per-unit design spent
 * ~1.8s of session+list overhead on every send and, in production, was throttled
 * to one unit per alarm tick. Durability is unchanged: each unit is still
 * persisted inFlight → mutated → receipted → removed before the next, so a
 * worker killed mid-burst loses at most the single in-flight unit.
 *
 * Returns the last processed job's disposition (or `idle`), so a single-job
 * queue behaves exactly as the previous one-step function did.
 */
export function drainQueue(
  opts: { now?: string } = {},
): Effect.Effect<DrainResult, StorageError | AlarmError, Http | Kv | DebugLog | DomTabs | Alarms> {
  return Effect.gen(function* () {
    const now = opts.now ?? new Date().toISOString()
    const debugLog = yield* DebugLog
    // Read once per pass: while no live-verified DOM driver exists, Tier B is
    // never routed to, so a read-only preflight drift stays recoverable.
    const domAvailable = (yield* DomTabs).available
    const initial = yield* loadQueue()
    let ledger = yield* loadLedger()
    const withoutReceipts = removeReceiptedJobs(initial, ledger)
    const interrupted = withoutReceipts.jobs.filter((job) => job.status === 'inFlight')
    let queue = interrupted.length > 0 ? reapInterrupted(withoutReceipts, now) : withoutReceipts
    if (interrupted.length > 0) {
      // A worker killed mid-send silently flips inFlight → uncertain; this is
      // the only trace of that recovery, the exact case the durable queue exists for.
      yield* debugLog.log(
        'queue',
        'reap-interrupted',
        { reapedCount: interrupted.length, unitIds: interrupted.map((job) => job.unit.id) },
        { level: 'warn' },
      )
    }

    if (queue !== initial) yield* saveQueue(queue)

    // Burst-scoped preflight caches — valid only within this single wake, so
    // the account-slot-reassignment window stays bounded to one drain pass.
    const authenticationByBinding = new Map<string, BoundAccountAuthentication>()
    const notebooksByAccount = new Map<string, { id: string; title: string }[]>()
    let tierState = yield* loadTierState(Date.parse(now))
    let lastResult: DrainResult = { status: 'idle' }

    // Each iteration removes a job or renders it non-due, so the due set
    // strictly shrinks; the bound is a defensive guard against a logic slip.
    const maxSteps = queue.jobs.length + 1
    for (let step = 0; step < maxSteps; step++) {
      const job = pickNext(queue, now)
      if (job === undefined) break
      const run = job.unit.id
      yield* debugLog.log(
        'queue',
        'drain',
        {
          unitId: job.unit.id,
          kind: job.unit.kind,
          notebookId: job.target.notebookId,
          attempts: job.attempts,
          pending: queue.jobs.length,
        },
        { run },
      )

      // --- Identity (fetched once per immutable account binding) ---
      const bindingKey = accountBindingKey(job.target)
      let authentication = authenticationByBinding.get(bindingKey)
      if (authentication === undefined) {
        const accountResult = yield* Effect.result(authenticateBoundAccount(job.target))
        if (Result.isFailure(accountResult)) {
          const settled = settlePreflightFailure(queue, job, accountResult.failure, now)
          yield* debugLog.log(
            'queue',
            'session preflight failed',
            { disposition: settled.status, error: String(accountResult.failure) },
            { run, level: settled.status === 'retrying' ? 'warn' : 'error' },
          )
          queue = settled.queue
          yield* saveQueue(queue)
          lastResult = { status: settled.status, jobId: job.id }
          break // session unreachable applies to every remaining job — stop the burst
        }
        authentication = accountResult.success
        authenticationByBinding.set(bindingKey, authentication)
      }
      if (authentication.status === 'account-changed') {
        queue = settleTerminalFailure(
          queue,
          job.id,
          'NotebookLM account changed; choose the target again before retrying',
          now,
          'blocked',
        )
        // Deliberately no email values — parity with the privacy norm elsewhere.
        yield* debugLog.log('queue', 'account changed → blocked', {}, { run, level: 'error' })
        yield* saveQueue(queue)
        lastResult = { status: 'blocked', jobId: job.id }
        continue
      }
      const account = authentication.account
      const session = account.session

      // --- Tier routing + read-only canary (list fetched once per account) ---
      // Never route to DOM without a driver, even from persisted degraded state.
      let useDom = domAvailable && routeForTierA(tierState, job.target.accountEmail, now) === 'dom'
      const degradedUntil = tierState.tierADegradedUntilByAccount[job.target.accountEmail]
      yield* debugLog.log(
        'queue',
        'route',
        {
          tier: useDom ? 'dom' : 'rpc',
          ...(degradedUntil !== undefined ? { tierADegradedUntil: degradedUntil } : {}),
        },
        { run },
      )

      if (!useDom) {
        let notebooks = notebooksByAccount.get(job.target.accountEmail)
        if (notebooks === undefined) {
          // The only safe automatic fallback point: listNotebooks is read-only,
          // so a ProtocolDrift here proves no source was mutated.
          const notebooksResult = yield* Effect.result(listNotebooks(session, job.target.authuser))
          if (Result.isFailure(notebooksResult)) {
            if (notebooksResult.failure instanceof ProtocolDrift && domAvailable) {
              yield* debugLog.log(
                'queue',
                'tier-a preflight drift → dom fallback',
                { snippet: notebooksResult.failure.snippet },
                { run, level: 'warn' },
              )
              tierState = degradeForPreflightDrift(tierState, job.target.accountEmail, now)
              yield* saveTierState(tierState)
              useDom = true
            } else if (notebooksResult.failure instanceof ProtocolDrift) {
              // Read-only listing drift proves NO source was mutated. With no
              // verified DOM driver there is no fallback that can succeed, so
              // park the job as blocked (recoverable via re-enqueue/retry)
              // instead of routing it into a dead Tier B that would mark it
              // in-flight and terminally fail — and without persisting a
              // cooldown that would strand the whole account.
              queue = settleTerminalFailure(
                queue,
                job.id,
                'NotebookLM changed its notebook listing and no verified fallback is available yet',
                now,
                'blocked',
              )
              yield* debugLog.log(
                'queue',
                'tier-a preflight drift → blocked (no dom driver)',
                { snippet: notebooksResult.failure.snippet },
                { run, level: 'warn' },
              )
              yield* saveQueue(queue)
              lastResult = { status: 'blocked', jobId: job.id }
              continue
            } else {
              const isNetwork =
                notebooksResult.failure instanceof FetchError ||
                notebooksResult.failure instanceof HttpStatusError
              const settled = isNetwork
                ? settlePreflightFailure(queue, job, notebooksResult.failure, now)
                : settleFailure(queue, job, notebooksResult.failure, now)
              yield* debugLog.log(
                'queue',
                'preflight list failed',
                { disposition: settled.status, error: String(notebooksResult.failure) },
                {
                  run,
                  level:
                    settled.status === 'retrying' || settled.status === 'uncertain'
                      ? 'warn'
                      : 'error',
                },
              )
              queue = settled.queue
              yield* saveQueue(queue)
              lastResult = { status: settled.status, jobId: job.id }
              if (isNetwork) break // list unreachable applies to the whole account
              continue
            }
          } else {
            notebooks = notebooksResult.success
            notebooksByAccount.set(job.target.accountEmail, notebooks)
            if (tierState.tierADegradedUntilByAccount[job.target.accountEmail] !== undefined) {
              yield* debugLog.log('queue', 'tier-a recovered after healthy preflight', {}, { run })
              tierState = recoverAfterHealthyPreflight(tierState, job.target.accountEmail)
              yield* saveTierState(tierState)
            }
          }
        }
        // Validate this job's target against the (cached) authenticated listing.
        // A target id is only meaningful inside the account that owns it.
        if (
          !useDom &&
          notebooks !== undefined &&
          !notebooks.some((notebook) => notebook.id === job.target.notebookId)
        ) {
          queue = settleTerminalFailure(
            queue,
            job.id,
            'Notebook target is no longer available; choose the target again before retrying',
            now,
            'blocked',
          )
          yield* debugLog.log(
            'queue',
            'target notebook unavailable → blocked',
            { notebookCount: notebooks.length },
            { run, level: 'error' },
          )
          yield* saveQueue(queue)
          lastResult = { status: 'blocked', jobId: job.id }
          continue
        }
      }

      // Dedup insurance: if this unit was receipted since the burst began (or a
      // stale re-enqueue slipped past removeReceiptedJobs), drop it unsent so a
      // succeeded source is never created twice.
      if (isUnitSynced(ledger, job.target, job.unit)) {
        queue = removeJob(queue, job.id)
        yield* saveQueue(queue)
        yield* debugLog.log('queue', 'skip already-synced', {}, { run })
        lastResult = { status: 'sent', jobId: job.id }
        continue
      }

      // Point of no return: a worker killed after this write is recovered as
      // explicit uncertainty, never resent automatically.
      yield* debugLog.log('queue', 'in-flight', { tier: useDom ? 'dom' : 'rpc' }, { run })
      queue = markInFlight(queue, job.id, now)
      yield* saveQueue(queue)

      if (useDom) {
        const domResult = yield* deliverViaDom({
          notebookId: job.target.notebookId,
          authuser: job.target.authuser,
          unit: job.unit,
        })
        if (domResult.status !== 'sent') {
          const settled =
            domResult.status === 'uncertain'
              ? {
                  queue: settleUncertain(queue, job.id, domResult.reason, now),
                  status: 'uncertain' as const,
                }
              : {
                  queue: settleTerminalFailure(queue, job.id, domResult.reason, now),
                  status: 'failed' as const,
                }
          yield* debugLog.log(
            'queue',
            `dom delivery ${settled.status}`,
            { domStatus: domResult.status, reason: domResult.reason },
            { run, level: settled.status === 'uncertain' ? 'warn' : 'error' },
          )
          queue = settled.queue
          yield* saveQueue(queue)
          lastResult = { status: settled.status, jobId: job.id }
          continue
        }
      } else {
        const deliveryResult = yield* Effect.result(
          sendIngestUnit(job.unit, job.target.notebookId, session, job.target.authuser),
        )
        if (Result.isFailure(deliveryResult)) {
          const settled = settleFailure(queue, job, deliveryResult.failure, now)
          yield* debugLog.log(
            'queue',
            `rpc delivery ${settled.status}`,
            { error: String(deliveryResult.failure) },
            { run, level: settled.status === 'uncertain' ? 'warn' : 'error' },
          )
          queue = settled.queue
          yield* saveQueue(queue)
          lastResult = { status: settled.status, jobId: job.id }
          continue
        }
      }

      ledger = recordSynced(ledger, job.target, [
        { id: job.unit.id, contentHash: job.unit.contentHash, now },
      ])
      yield* saveLedger(ledger)
      queue = removeJob(queue, job.id)
      yield* saveQueue(queue)
      yield* debugLog.log('queue', 'sent', { tier: useDom ? 'dom' : 'rpc' }, { run })
      lastResult = { status: 'sent', jobId: job.id }
    }

    yield* armNextDrain(queue, now)
    return lastResult
  })
}
