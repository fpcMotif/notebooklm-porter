/**
 * Effect-based service-worker wrapper around the pure builders in
 * ./protocol.ts. Owns everything protocol.ts deliberately doesn't: fetch,
 * credentials, retry/timeout policy, and distinguishing not-logged-in from a
 * bad HTTP response or a drifted wire protocol (design §4).
 */
import { Effect, Result, Schedule } from 'effect'
import { parseNblmHome } from '../../accounts/parse'
import { redact } from '../../debug'
import {
  FetchError,
  HttpStatusError,
  NotLoggedIn,
  ProtocolDrift,
  RpcRefused,
} from '../../fx/errors'
import { DebugLog, Http } from '../../fx/services'
import {
  addTextSourceParams,
  addUrlSourceParams,
  addYoutubeSourceParams,
  buildEnvelope,
  buildRpcUrl,
  createNotebookParams,
  homeUrl,
  listNotebooksParams,
  parseBatchexecuteResponse,
  parseNotebookList,
  RPC_IDS,
} from './protocol'

export interface NblmSession {
  csrfToken: string
  fSid?: string
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
    const html = yield* http.text(homeUrl(authuser), { credentials: 'include' })
    const parsed = parseNblmHome(html)
    yield* debugLog.log('rpc', 'session', {
      authuser,
      loggedIn: parsed.loggedIn,
      hasCsrf: parsed.csrfToken !== undefined,
      hasFsid: parsed.fSid !== undefined,
    })
    if (!parsed.loggedIn || parsed.csrfToken === undefined) {
      return yield* Effect.fail(new NotLoggedIn({ authuser }))
    }
    return {
      csrfToken: parsed.csrfToken,
      ...(parsed.fSid !== undefined ? { fSid: parsed.fSid } : {}),
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

    const textResult = yield* Effect.result(
      http.text(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: buildEnvelope(rpcId, params, session.csrfToken),
      }),
    )
    if (Result.isFailure(textResult)) {
      yield* debugLog.log('rpc', `${rpcId} failed`, { error: String(textResult.failure) })
      return yield* Effect.fail(textResult.failure)
    }
    const text = textResult.success

    const parseResult = yield* Effect.result(parseResponse(text, rpcId))
    if (Result.isFailure(parseResult)) {
      yield* debugLog.log('rpc', rpcId, {
        url: redact(url),
        resultKind: 'placeholder-null',
        responseHead: text.slice(0, 300),
      })
      yield* debugLog.log('rpc', `${rpcId} failed`, { error: String(parseResult.failure) })
      return yield* Effect.fail(parseResult.failure)
    }
    const result = parseResult.success

    yield* debugLog.log('rpc', rpcId, {
      url: redact(url),
      resultKind: result === null ? 'placeholder-null' : 'payload',
    })
    return result
  })

  return Effect.retry(attempt, {
    schedule: rpcRetrySchedule,
    while: (err) =>
      err instanceof ProtocolDrift || err instanceof RpcRefused ? false : isRetryable(err),
  }).pipe(
    Effect.timeout('20 seconds'),
    Effect.catchTag('TimeoutError', () => Effect.fail(new FetchError({ url, cause: 'timeout' }))),
  )
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
  return rpcCall(RPC_IDS.createNotebook, createNotebookParams(title), session, authuser, '/')
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
  )
}
