import { Effect } from 'effect'
import type { StorageError } from './fx/errors'
import { kvSlot } from './fx/kv-slot'
import { DebugLog, Kv } from './fx/services'
import type { SourceDoc } from './model/types'

/**
 * Capture queue in extension local storage (unlimitedStorage granted).
 * Docs are keyed by SourceDoc.id, so re-capturing a thread REPLACES the
 * stale doc instead of duplicating it — that is the dedup story.
 */
const docsSlot = kvSlot<SourceDoc[]>('porter/docs', () => [])

export function listDocs(): Effect.Effect<SourceDoc[], StorageError, Kv> {
  return Effect.gen(function* () {
    const docs = yield* docsSlot.load()
    return docs.toSorted((a, b) => b.capturedAt.localeCompare(a.capturedAt))
  })
}

export function upsertDoc(doc: SourceDoc): Effect.Effect<void, StorageError, Kv> {
  return Effect.gen(function* () {
    const docs = yield* listDocs()
    const next = [doc, ...docs.filter((d) => d.id !== doc.id)]
    yield* docsSlot.save(next)
  })
}

export function deleteDoc(docId: string): Effect.Effect<void, StorageError, Kv> {
  return Effect.gen(function* () {
    const docs = yield* listDocs()
    yield* docsSlot.save(docs.filter((d) => d.id !== docId))
  })
}

/**
 * Persists a freshly captured doc and records a content-free summary in the
 * debug ring — counts and kinds, never titles or bodies — so a copied log
 * shows what capture produced without leaking the captured text.
 */
export function storeCapturedDoc(doc: SourceDoc): Effect.Effect<void, StorageError, DebugLog | Kv> {
  return Effect.gen(function* () {
    yield* upsertDoc(doc)
    const debugLog = yield* DebugLog
    yield* debugLog.log('capture', 'stored', {
      docId: doc.id,
      site: doc.site,
      kind: doc.kind,
      wordCount: doc.wordCount,
      truncated: doc.truncated,
      ...(doc.videoDocs !== undefined ? { videoTranscripts: doc.videoDocs.length } : {}),
    })
  })
}
