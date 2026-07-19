/**
 * Owns Source Console workflows: bound-account authentication, remote
 * sequencing, source analysis, post-mutation re-listing, and diagnostic logs.
 */
import { Effect, Semaphore } from 'effect'
import {
  authenticateBoundAccount,
  type AuthenticatedNotebookLmAccount,
  type NotebookTarget,
} from '../../accounts/ownership'
import {
  IpcError,
  NotLoggedIn,
  type FetchError,
  type HttpStatusError,
  type ProtocolDrift,
  type RpcRefused,
} from '../../fx/errors'
import { DebugLog, type Http } from '../../fx/services'
import { deleteSource, listSources, refreshSource } from '../rpc/client'
import { duplicateRemovalIds, findDuplicateGroups, type DuplicateGroup } from './dedup'
import { diagnoseFailedSources, type SourceDiagnosis } from './diagnose'
import type { NotebookSource } from './model'

export interface ConsoleScan {
  sources: NotebookSource[]
  duplicateGroups: DuplicateGroup[]
  failed: SourceDiagnosis[]
  /** Total redundant copies across all groups — the count the console would remove. */
  duplicateCount: number
}

export type SourceConsoleError =
  | FetchError
  | HttpStatusError
  | IpcError
  | NotLoggedIn
  | ProtocolDrift
  | RpcRefused

export type SourceConsoleDeps = Http | DebugLog

const sourceConsolePermit = Semaphore.makeUnsafe(1)

function scanSources(sources: NotebookSource[]): ConsoleScan {
  const duplicateGroups = findDuplicateGroups(sources)
  return {
    sources,
    duplicateGroups,
    failed: diagnoseFailedSources(sources),
    duplicateCount: duplicateRemovalIds(duplicateGroups).length,
  }
}

function authenticateTarget(
  target: NotebookTarget,
): Effect.Effect<
  AuthenticatedNotebookLmAccount,
  FetchError | HttpStatusError | NotLoggedIn,
  Http | DebugLog
> {
  return Effect.gen(function* () {
    const authentication = yield* authenticateBoundAccount(target)
    if (authentication.status === 'account-changed') {
      return yield* Effect.fail(new NotLoggedIn({ authuser: target.authuser }))
    }
    return authentication.account
  })
}

function loadSourceConsole(
  target: NotebookTarget,
): Effect.Effect<
  { readonly account: AuthenticatedNotebookLmAccount; readonly sources: NotebookSource[] },
  SourceConsoleError,
  SourceConsoleDeps
> {
  return Effect.gen(function* () {
    const account = yield* authenticateTarget(target)
    const sources = yield* listSources(target.notebookId, account.session, account.authuser)
    return { account, sources }
  })
}

/** Reads and analyzes the bound account's current sources for one notebook. */
export function scanSourceConsole(
  target: NotebookTarget,
): Effect.Effect<ConsoleScan, SourceConsoleError, SourceConsoleDeps> {
  return sourceConsolePermit.withPermit(
    Effect.gen(function* () {
      const { sources } = yield* loadSourceConsole(target)
      const scan = scanSources(sources)
      const debugLog = yield* DebugLog
      yield* debugLog.log('console', 'scan', {
        notebookId: target.notebookId,
        sources: sources.length,
        duplicateGroups: scan.duplicateGroups.length,
        duplicates: scan.duplicateCount,
        failed: scan.failed.length,
      })
      return scan
    }),
  )
}

/** Removes planned duplicate copies sequentially, then returns the fresh notebook truth. */
export function removeSourceDuplicates(
  target: NotebookTarget,
): Effect.Effect<
  { readonly scan: ConsoleScan; readonly removedIds: string[] },
  SourceConsoleError,
  SourceConsoleDeps
> {
  return sourceConsolePermit.withPermit(
    Effect.gen(function* () {
      const { account, sources } = yield* loadSourceConsole(target)
      const removalIds = duplicateRemovalIds(findDuplicateGroups(sources))
      const debugLog = yield* DebugLog
      yield* debugLog.log('console', 'dedupe', {
        notebookId: target.notebookId,
        sources: sources.length,
        removing: removalIds.length,
      })

      const removedIds: string[] = []
      for (const sourceId of removalIds) {
        yield* deleteSource(target.notebookId, sourceId, account.session, account.authuser)
        removedIds.push(sourceId)
      }

      const fresh = yield* listSources(target.notebookId, account.session, account.authuser)
      return { scan: scanSources(fresh), removedIds }
    }),
  )
}

/** Refreshes one source once, then returns the newly listed notebook truth. */
export function retryNotebookSource(
  target: NotebookTarget,
  sourceId: string,
): Effect.Effect<ConsoleScan, SourceConsoleError, SourceConsoleDeps> {
  return sourceConsolePermit.withPermit(
    Effect.gen(function* () {
      const { account, sources } = yield* loadSourceConsole(target)
      const diagnosis = diagnoseFailedSources(sources).find(
        (candidate) => candidate.source.id === sourceId,
      )
      if (diagnosis?.retry !== 'refresh') {
        return yield* Effect.fail(new IpcError({ reason: 'Source is not eligible for refresh' }))
      }
      yield* refreshSource(target.notebookId, sourceId, account.session, account.authuser)
      const debugLog = yield* DebugLog
      yield* debugLog.log('console', 'retry', { notebookId: target.notebookId, sourceId })
      const fresh = yield* listSources(target.notebookId, account.session, account.authuser)
      return scanSources(fresh)
    }),
  )
}
