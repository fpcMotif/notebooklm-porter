import type { SourceDoc } from '../model/types'
import { addTextSource, addYoutubeSource, fetchSession, type NblmSession } from './rpc/client'
import { listDocs } from '../store'

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

async function ingestOneDoc(
  doc: SourceDoc,
  notebookId: string,
  session: NblmSession,
  authuser: number,
): Promise<IngestOutcome> {
  if (doc.kind === 'playlist') {
    const urls = videoUrlsForDoc(doc)
    for (const url of urls) {
      try {
        // Sequential by necessity: NBLM's add-source RPC must not be
        // fired concurrently per notebook, so this can't become a
        // Promise.all — see design §4.
        // eslint-disable-next-line no-await-in-loop
        await addYoutubeSource(notebookId, url, session, authuser)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { docId: doc.id, ok: false, tier: 'rpc', error: `${url}: ${message}` }
      }
    }
    return { docId: doc.id, ok: true, tier: 'rpc' }
  }

  try {
    await addTextSource(notebookId, doc.title, doc.markdown, session, authuser)
    return { docId: doc.id, ok: true, tier: 'rpc' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { docId: doc.id, ok: false, tier: 'rpc', error: message }
  }
}

export async function ingestIntoNotebook(
  docIds: string[],
  opts: { authuser?: number; notebookId: string },
): Promise<IngestOutcome[]> {
  const authuser = opts.authuser ?? 0
  const session = await fetchSession(authuser)

  const docs = await listDocs()
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
    // eslint-disable-next-line no-await-in-loop
    outcomes.push(await ingestOneDoc(doc, opts.notebookId, session, authuser))
  }
  return outcomes
}

/** Render helper kept here so callers never import a doc's Thread — only the SourceDoc. */
export type IngestableDoc = Pick<SourceDoc, 'id' | 'title' | 'canonicalUrl' | 'kind' | 'markdown'>
