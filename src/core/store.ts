import { Effect } from 'effect'
import { Kv } from './fx/services'
import type { StorageError } from './fx/errors'
import type { SourceDoc } from './model/types'

const KEY = 'porter/docs'

/**
 * Capture queue in extension local storage (unlimitedStorage granted).
 * Docs are keyed by SourceDoc.id, so re-capturing a thread REPLACES the
 * stale doc instead of duplicating it — that is the dedup story.
 */
export function listDocs(): Effect.Effect<SourceDoc[], StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    const docs = (yield* kv.get<SourceDoc[]>(KEY)) ?? []
    return docs.toSorted((a, b) => b.capturedAt.localeCompare(a.capturedAt))
  })
}

export function upsertDoc(doc: SourceDoc): Effect.Effect<void, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    const docs = yield* listDocs()
    const next = [doc, ...docs.filter((d) => d.id !== doc.id)]
    yield* kv.set(KEY, next)
  })
}

export function deleteDoc(docId: string): Effect.Effect<void, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    const docs = yield* listDocs()
    yield* kv.set(
      KEY,
      docs.filter((d) => d.id !== docId),
    )
  })
}
