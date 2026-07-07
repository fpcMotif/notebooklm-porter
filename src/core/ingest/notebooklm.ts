import { Effect, Result } from 'effect'
import type { SourceDoc } from '../model/types'
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
import { addTextSource, addYoutubeSource, fetchSession, type NblmSession } from './rpc/client'

/**
 * Deliver docs into the user's chosen NotebookLM notebook, RPC-first with
 * automatic degradation (design §4):
 *
 *   Tier A  batchexecute RPC (izAoDd) from the service worker  — primary
 *   Tier B  DOM automation on an open notebooklm.google.com tab — fallback
 *   Tier C  file export (see ./export.ts)                       — floor
 *
 * The active tier is reported back so the popup can show which path ran and
 * flag when Tier A has degraded.
 *
 * TODO(stage 4): Tier B / Tier C automatic fallback on Tier-A failure. This
 * implements Tier A only, per the current scope lock.
 */
export type IngestTier = 'rpc' | 'dom' | 'file'

export interface IngestOutcome {
  docId: string
  ok: boolean
  tier: IngestTier
  error?: string
}

const YOUTUBE_URL_RE = /https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}/g

/** Prefers doc.jsonl (structured) when populated; falls back to regexing the rendered markdown. */
function videoUrlsForDoc(doc: SourceDoc): string[] {
  if (doc.jsonl !== undefined && doc.jsonl.length > 0) {
    const urls: string[] = []
    for (const line of doc.jsonl.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const parsed = JSON.parse(line) as { url?: unknown }
        if (typeof parsed.url === 'string') urls.push(parsed.url)
      } catch {
        // Malformed line — fall through to the markdown regex below for this doc.
      }
    }
    if (urls.length > 0) return Array.from(new Set(urls))
  }

  const matches = doc.markdown.match(YOUTUBE_URL_RE) ?? []
  return Array.from(new Set(matches))
}

function ingestOneDoc(
  doc: SourceDoc,
  notebookId: string,
  session: NblmSession,
  authuser: number,
): Effect.Effect<IngestOutcome, never, Http | DebugLog> {
  return Effect.gen(function* () {
    const debugLog = yield* DebugLog

    if (doc.kind === 'playlist') {
      const urls = videoUrlsForDoc(doc)
      yield* debugLog.log('ingest', doc.id, { kind: doc.kind, sources: urls.length })
      for (const url of urls) {
        // Sequential by necessity: NBLM's add-source RPC must not be
        // fired concurrently per notebook, so this can't become
        // Effect.all-in-parallel — see design §4.
        const result = yield* Effect.result(addYoutubeSource(notebookId, url, session, authuser))
        if (Result.isFailure(result)) {
          const message = String(result.failure)
          yield* debugLog.log('ingest', `${doc.id} failed`, { error: message })
          return { docId: doc.id, ok: false, tier: 'rpc' as const, error: `${url}: ${message}` }
        }
      }
      return { docId: doc.id, ok: true, tier: 'rpc' as const }
    }

    yield* debugLog.log('ingest', doc.id, { kind: doc.kind, sources: 1 })
    const result = yield* Effect.result(
      addTextSource(notebookId, doc.title, doc.markdown, session, authuser),
    )
    if (Result.isFailure(result)) {
      const message = String(result.failure)
      yield* debugLog.log('ingest', `${doc.id} failed`, { error: message })
      return { docId: doc.id, ok: false, tier: 'rpc' as const, error: message }
    }
    return { docId: doc.id, ok: true, tier: 'rpc' as const }
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
    // only per-doc RPC failures below get stringified into IngestOutcome.
    const session = yield* fetchSession(authuser)
    const docs = yield* listDocs()
    const byId = new Map(docs.map((doc) => [doc.id, doc]))

    const outcomes: IngestOutcome[] = []
    for (const docId of docIds) {
      const doc = byId.get(docId)
      if (doc === undefined) {
        outcomes.push({ docId, ok: false, tier: 'rpc', error: 'Doc not found' })
        continue
      }
      // Sequential by necessity: ingest runs against one shared NBLM session
      // and notebook, and callers rely on outcome order matching docIds.
      outcomes.push(yield* ingestOneDoc(doc, opts.notebookId, session, authuser))
    }
    return outcomes
  })
}

/** Render helper kept here so callers never import a doc's Thread — only the SourceDoc. */
export type IngestableDoc = Pick<SourceDoc, 'id' | 'title' | 'canonicalUrl' | 'kind' | 'markdown'>
