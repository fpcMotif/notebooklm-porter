/**
 * Owns bound-account notebook browsing and creation: fresh authentication,
 * browse cache policy, create reconciliation, and local serialization.
 */
import { Effect, Result, Semaphore } from 'effect'
import { authenticateBoundAccount, type NotebookLmAccountBinding } from '../accounts/ownership'
import {
  FetchError,
  HttpStatusError,
  NotebookCreationUncertain,
  NotebookTitleInvalid,
  NotLoggedIn,
  ProtocolDrift,
  RpcRefused,
} from '../fx/errors'
import { DebugLog, type Http, type Kv } from '../fx/services'
import { createNotebook, listNotebooks, type NblmSession } from '../ingest/rpc/client'
import type { CreateNotebookAck } from '../ingest/rpc/protocol'
import {
  cacheNotebooks,
  loadNotebookCache,
  readCachedNotebooks,
  saveNotebookCache,
} from '../store/notebooks-cache'
import type { NotebookMeta } from './model'

export interface CreatedCatalogNotebook {
  readonly notebooks: NotebookMeta[]
  readonly created: NotebookMeta
}

export type NotebookCatalogError =
  | FetchError
  | HttpStatusError
  | NotebookCreationUncertain
  | NotebookTitleInvalid
  | NotLoggedIn
  | ProtocolDrift
  | RpcRefused

export type NotebookCatalogDeps = Http | Kv | DebugLog

interface ActiveCatalog {
  readonly authuser: number
  readonly accountEmail: string
  readonly session: NblmSession
}

type RpcError = FetchError | HttpStatusError | ProtocolDrift | RpcRefused
type UncertainStage = NotebookCreationUncertain['stage']

const catalogPermit = Semaphore.makeUnsafe(1)
const CREATE_RELIST_RETRIES = 2
const CREATE_RELIST_DELAY = '400 millis'

function activeCatalog(
  binding: NotebookLmAccountBinding,
): Effect.Effect<ActiveCatalog, NotebookCatalogError, NotebookCatalogDeps> {
  return Effect.gen(function* () {
    const authentication = yield* authenticateBoundAccount(binding)
    if (authentication.status === 'account-changed') {
      return yield* Effect.fail(new NotLoggedIn({ authuser: binding.authuser }))
    }
    return {
      authuser: authentication.account.authuser,
      accountEmail: authentication.account.email,
      session: authentication.account.session,
    }
  })
}

function readCache(active: ActiveCatalog) {
  return Effect.gen(function* () {
    const debugLog = yield* DebugLog
    const loaded = yield* Effect.result(loadNotebookCache())
    if (Result.isFailure(loaded)) {
      yield* debugLog.log(
        'catalog',
        'cache-failed',
        { authuser: active.authuser, operation: 'read' },
        { level: 'warn' },
      )
      return undefined
    }
    return readCachedNotebooks(loaded.success, active.authuser, active.accountEmail)
  })
}

function writeCache(active: ActiveCatalog, notebooks: readonly NotebookMeta[]) {
  return Effect.gen(function* () {
    const debugLog = yield* DebugLog
    const written = yield* Effect.result(
      Effect.gen(function* () {
        const cache = yield* loadNotebookCache()
        yield* saveNotebookCache(
          cacheNotebooks(cache, {
            authuser: active.authuser,
            email: active.accountEmail,
            notebooks,
            refreshedAt: new Date().toISOString(),
          }),
        )
      }),
    )
    if (Result.isFailure(written)) {
      yield* debugLog.log(
        'catalog',
        'cache-failed',
        { authuser: active.authuser, operation: 'write' },
        { level: 'warn' },
      )
    }
  })
}

function readUnlocked(binding: NotebookLmAccountBinding, useCache: boolean) {
  return Effect.gen(function* () {
    const active = yield* activeCatalog(binding)
    const debugLog = yield* DebugLog
    if (useCache) {
      const cached = yield* readCache(active)
      if (cached !== undefined) {
        yield* debugLog.log('catalog', 'list', {
          authuser: active.authuser,
          source: 'cache',
          count: cached.length,
        })
        return cached
      }
    }
    const notebooks = yield* listNotebooks(active.session, active.authuser)
    yield* debugLog.log('catalog', 'list', {
      authuser: active.authuser,
      source: 'remote',
      count: notebooks.length,
    })
    yield* writeCache(active, notebooks)
    return notebooks
  })
}

export function readNotebookCatalog(
  binding: NotebookLmAccountBinding,
): Effect.Effect<NotebookMeta[], NotebookCatalogError, NotebookCatalogDeps> {
  return catalogPermit.withPermit(readUnlocked(binding, true))
}

export function refreshNotebookCatalog(
  binding: NotebookLmAccountBinding,
): Effect.Effect<NotebookMeta[], NotebookCatalogError, NotebookCatalogDeps> {
  return catalogPermit.withPermit(readUnlocked(binding, false))
}

function isAmbiguousCreateFailure(error: RpcError): boolean {
  if (error instanceof FetchError || error instanceof ProtocolDrift) return true
  if (!(error instanceof HttpStatusError)) return false
  return error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500
}

function uncertainty(
  active: ActiveCatalog,
  stage: UncertainStage,
  reason: NotebookCreationUncertain['reason'],
  status?: number,
) {
  return new NotebookCreationUncertain({
    authuser: active.authuser,
    stage,
    reason,
    ...(status !== undefined ? { status } : {}),
  })
}

function uncertaintyFromRpc(
  active: ActiveCatalog,
  stage: UncertainStage,
  error: RpcError,
): NotebookCreationUncertain {
  if (error instanceof FetchError) return uncertainty(active, stage, 'network')
  if (error instanceof HttpStatusError) {
    return uncertainty(active, stage, 'http-status', error.status)
  }
  if (error instanceof ProtocolDrift) return uncertainty(active, stage, 'protocol-drift')
  if (error instanceof RpcRefused) return uncertainty(active, stage, 'rpc-refused')
  return error satisfies never
}

function logUncertainty(error: NotebookCreationUncertain) {
  return Effect.gen(function* () {
    const debugLog = yield* DebugLog
    yield* debugLog.log(
      'catalog',
      'create-uncertain',
      {
        authuser: error.authuser,
        stage: error.stage,
        reason: error.reason,
        ...(error.status !== undefined ? { status: error.status } : {}),
      },
      { level: 'warn' },
    )
  })
}

function reconcileAmbiguousCreate(active: ActiveCatalog, error: RpcError) {
  return Effect.gen(function* () {
    const uncertain = uncertaintyFromRpc(active, 'create-request', error)
    const listed = yield* Effect.result(listNotebooks(active.session, active.authuser))
    yield* logUncertainty(uncertain)
    if (Result.isSuccess(listed)) yield* writeCache(active, listed.success)
    return yield* Effect.fail(uncertain)
  })
}

function locateHintedNotebook(
  beforeIds: ReadonlySet<string>,
  notebooks: readonly NotebookMeta[],
  acknowledgement: CreateNotebookAck,
): NotebookMeta | undefined {
  const hintedId = acknowledgement.hintedId
  if (hintedId === undefined || beforeIds.has(hintedId)) return undefined
  return notebooks.find((notebook) => notebook.id === hintedId)
}

function createUnlocked(binding: NotebookLmAccountBinding, title: string) {
  return Effect.gen(function* () {
    const active = yield* activeCatalog(binding)
    const before = yield* listNotebooks(active.session, active.authuser)
    const beforeIds = new Set(before.map((notebook) => notebook.id))
    const createResult = yield* Effect.result(
      createNotebook(title, active.session, active.authuser),
    )
    if (Result.isFailure(createResult)) {
      if (!isAmbiguousCreateFailure(createResult.failure)) {
        return yield* Effect.fail(createResult.failure)
      }
      return yield* reconcileAmbiguousCreate(active, createResult.failure)
    }

    let notebooks: NotebookMeta[] = []
    for (let attempt = 0; attempt <= CREATE_RELIST_RETRIES; attempt++) {
      if (attempt > 0) yield* Effect.sleep(CREATE_RELIST_DELAY)
      const listed = yield* Effect.result(listNotebooks(active.session, active.authuser))
      if (Result.isFailure(listed)) {
        const uncertain = uncertaintyFromRpc(active, 'post-create-list', listed.failure)
        yield* logUncertainty(uncertain)
        return yield* Effect.fail(uncertain)
      }
      notebooks = listed.success
      const created = locateHintedNotebook(beforeIds, notebooks, createResult.success)
      if (created !== undefined) {
        const debugLog = yield* DebugLog
        yield* debugLog.log('catalog', 'create', {
          authuser: active.authuser,
          notebookId: created.id,
        })
        yield* writeCache(active, notebooks)
        return { notebooks, created }
      }
    }

    const uncertain = uncertainty(active, 'created-notebook', 'missing-id')
    yield* logUncertainty(uncertain)
    yield* writeCache(active, notebooks)
    return yield* Effect.fail(uncertain)
  })
}

export function createCatalogNotebook(
  binding: NotebookLmAccountBinding,
  title: string,
): Effect.Effect<CreatedCatalogNotebook, NotebookCatalogError, NotebookCatalogDeps> {
  const normalizedTitle = title.trim()
  if (normalizedTitle === '') return Effect.fail(new NotebookTitleInvalid())
  return catalogPermit.withPermit(createUnlocked(binding, normalizedTitle))
}
