/**
 * Effect-based service-worker wrapper around the pure builders in
 * ./protocol.ts. Owns everything protocol.ts deliberately doesn't: fetch,
 * credentials, retry/timeout policy, and distinguishing not-logged-in from a
 * bad HTTP response or a drifted wire protocol (design §4).
 */
import { Duration, Effect, Result, Schedule } from 'effect'
import { parseNblmHome } from '../../accounts/parse'
import { redact } from '../../debug'
import {
  FetchError,
  HttpStatusError,
  NotLoggedIn,
  ProtocolDrift,
  RpcRefused,
} from '../../fx/errors'
import { DebugLog, Http, withHttpTimeout } from '../../fx/services'
import type { NotebookSource } from '../sources/model'
import {
  addTextSourceParams,
  addUrlSourceParams,
  addYoutubeSourceParams,
  buildEnvelope,
  buildRpcUrl,
  createNotebookParams,
  deleteSourceParams,
  getNotebookParams,
  homeUrl,
  listNotebooksParams,
  parseBatchexecuteResponse,
  parseNotebookList,
  parseNotebookSources,
  refreshSourceParams,
  RPC_IDS,
} from './protocol'

export interface NblmSession {
  csrfToken: string
  fSid?: string
  email?: string
}

function notebookSourcePath(notebookId: string): string {
  return `/notebook/${encodeURIComponent(notebookId)}`
}

export const fetchSession = (
  authuser: number,
): Effect.Effect<NblmSession, FetchError | HttpStatusError | NotLoggedIn, Http | DebugLog> =>
  Effect.gen(function* () {
    const http = yield* Http
    const debugLog = yield* DebugLog
    const url = homeUrl(authuser)
    const [elapsed, html] = yield* Effect.timed(
      withHttpTimeout(http.text(url, { credentials: 'include' }), url),
    )
    const parsed = parseNblmHome(html)
    const loggedIn = parsed.loggedIn && parsed.csrfToken !== undefined
    yield* debugLog.log(
      'rpc',
      'session',
      {
        authuser,
        loggedIn: parsed.loggedIn,
        hasCsrf: parsed.csrfToken !== undefined,
        hasFsid: parsed.fSid !== undefined,
        hasEmail: parsed.email !== undefined,
      },
      { elapsedMs: Math.round(Duration.toMillis(elapsed)), ...(loggedIn ? {} : { level: 'warn' }) },
    )
    if (!parsed.loggedIn || parsed.csrfToken === undefined) {
      return yield* Effect.fail(new NotLoggedIn({ authuser }))
    }
    return {
      csrfToken: parsed.csrfToken,
      ...(parsed.fSid !== undefined ? { fSid: parsed.fSid } : {}),
      ...(parsed.email !== undefined ? { email: parsed.email } : {}),
    }
  })

/** Lifts protocol.ts's throwing parser into the typed error channel. */
function parseResponse(
  text: string,
  rpcId: string,
): Effect.Effect<unknown, ProtocolDrift | RpcRefused> {
  return Effect.try({
    try: () => parseBatchexecuteResponse(text, rpcId),
    catch: (cause) => {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (message.startsWith('rpc-error:')) {
        return new RpcRefused({ rpcId, code: message.slice('rpc-error:'.length).trim() })
      }
      return new ProtocolDrift({ rpcId, snippet: message.slice(0, 300) })
    },
  })
}

function isRetryable(err: FetchError | HttpStatusError): boolean {
  return !('status' in err) || err.status >= 500 || err.status === 429
}

const rpcRetrySchedule = Schedule.both(
  Schedule.exponential('200 millis').pipe(Schedule.jittered),
  Schedule.recurs(2),
)

export function rpcCall(
  rpcId: string,
  params: unknown,
  session: NblmSession,
  authuser: number,
  sourcePath?: string,
  opts: { retry?: boolean } = {},
): Effect.Effect<
  unknown,
  FetchError | HttpStatusError | ProtocolDrift | RpcRefused,
  Http | DebugLog
> {
  const url = buildRpcUrl({
    rpcId,
    authuser,
    ...(session.fSid !== undefined ? { fSid: session.fSid } : {}),
    ...(sourcePath !== undefined ? { sourcePath } : {}),
  })

  const attempt = Effect.gen(function* () {
    const http = yield* Http
    const debugLog = yield* DebugLog

    const [elapsed, textResult] = yield* Effect.timed(
      Effect.result(
        http.text(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: buildEnvelope(rpcId, params, session.csrfToken),
        }),
      ),
    )
    const elapsedMs = Math.round(Duration.toMillis(elapsed))
    if (Result.isFailure(textResult)) {
      yield* debugLog.log(
        'rpc',
        `${rpcId} failed`,
        { error: String(textResult.failure) },
        { level: 'warn', elapsedMs },
      )
      return yield* Effect.fail(textResult.failure)
    }
    const text = textResult.success

    const parseResult = yield* Effect.result(parseResponse(text, rpcId))
    if (Result.isFailure(parseResult)) {
      yield* debugLog.log(
        'rpc',
        rpcId,
        {
          url: redact(url),
          resultKind: 'placeholder-null',
          responseHead: text.slice(0, 300),
        },
        { elapsedMs },
      )
      yield* debugLog.log(
        'rpc',
        `${rpcId} failed`,
        { error: String(parseResult.failure) },
        { level: 'warn', elapsedMs },
      )
      return yield* Effect.fail(parseResult.failure)
    }
    const result = parseResult.success

    yield* debugLog.log(
      'rpc',
      rpcId,
      {
        url: redact(url),
        resultKind: result === null ? 'placeholder-null' : 'payload',
      },
      { elapsedMs },
    )
    return result
  })

  const request =
    opts.retry === false
      ? attempt
      : Effect.retry(attempt, {
          schedule: rpcRetrySchedule,
          while: (err) =>
            err instanceof ProtocolDrift || err instanceof RpcRefused ? false : isRetryable(err),
        })

  return withHttpTimeout(request, url)
}

export function listNotebooks(
  session: NblmSession,
  authuser: number,
): Effect.Effect<
  { id: string; title: string }[],
  FetchError | HttpStatusError | ProtocolDrift | RpcRefused,
  Http | DebugLog
> {
  return rpcCall(RPC_IDS.listNotebooks, listNotebooksParams(), session, authuser, '/').pipe(
    Effect.map(parseNotebookList),
  )
}

export function createNotebook(
  title: string,
  session: NblmSession,
  authuser: number,
): Effect.Effect<
  unknown,
  FetchError | HttpStatusError | ProtocolDrift | RpcRefused,
  Http | DebugLog
> {
  return rpcCall(RPC_IDS.createNotebook, createNotebookParams(title), session, authuser, '/', {
    retry: false,
  })
}

export function addYoutubeSource(
  notebookId: string,
  url: string,
  session: NblmSession,
  authuser: number,
): Effect.Effect<
  unknown,
  FetchError | HttpStatusError | ProtocolDrift | RpcRefused,
  Http | DebugLog
> {
  return rpcCall(
    RPC_IDS.addSource,
    addYoutubeSourceParams(notebookId, url),
    session,
    authuser,
    notebookSourcePath(notebookId),
    { retry: false },
  )
}

export function addUrlSource(
  notebookId: string,
  url: string,
  session: NblmSession,
  authuser: number,
): Effect.Effect<
  unknown,
  FetchError | HttpStatusError | ProtocolDrift | RpcRefused,
  Http | DebugLog
> {
  return rpcCall(
    RPC_IDS.addSource,
    addUrlSourceParams(notebookId, url),
    session,
    authuser,
    notebookSourcePath(notebookId),
    { retry: false },
  )
}

export function addTextSource(
  notebookId: string,
  title: string,
  content: string,
  session: NblmSession,
  authuser: number,
): Effect.Effect<
  unknown,
  FetchError | HttpStatusError | ProtocolDrift | RpcRefused,
  Http | DebugLog
> {
  return rpcCall(
    RPC_IDS.addSource,
    addTextSourceParams(notebookId, title, content),
    session,
    authuser,
    notebookSourcePath(notebookId),
    { retry: false },
  )
}

/** Lists the source rows inside one notebook (GET_NOTEBOOK), decoded to the domain model. */
export function listSources(
  notebookId: string,
  session: NblmSession,
  authuser: number,
  opts: { retry?: boolean } = {},
): Effect.Effect<
  NotebookSource[],
  FetchError | HttpStatusError | ProtocolDrift | RpcRefused,
  Http | DebugLog
> {
  return rpcCall(
    RPC_IDS.getNotebook,
    getNotebookParams(notebookId),
    session,
    authuser,
    notebookSourcePath(notebookId),
    opts,
  ).pipe(Effect.map(parseNotebookSources))
}

/**
 * Removes one source from a notebook (DELETE_SOURCE). Idempotent server-side —
 * deleting an already-absent source succeeds — so the default 5xx/429 retry is
 * left on; a placeholder-null response is the accepted success shape.
 */
export function deleteSource(
  notebookId: string,
  sourceId: string,
  session: NblmSession,
  authuser: number,
): Effect.Effect<
  unknown,
  FetchError | HttpStatusError | ProtocolDrift | RpcRefused,
  Http | DebugLog
> {
  return rpcCall(
    RPC_IDS.deleteSource,
    deleteSourceParams(sourceId),
    session,
    authuser,
    notebookSourcePath(notebookId),
  )
}

/** Re-fetches one URL/Drive source in place (REFRESH_SOURCE) — the console's retry. */
export function refreshSource(
  notebookId: string,
  sourceId: string,
  session: NblmSession,
  authuser: number,
): Effect.Effect<
  unknown,
  FetchError | HttpStatusError | ProtocolDrift | RpcRefused,
  Http | DebugLog
> {
  return rpcCall(
    RPC_IDS.refreshSource,
    refreshSourceParams(sourceId),
    session,
    authuser,
    notebookSourcePath(notebookId),
    { retry: false },
  )
}
