import type { SourceDoc } from './model/types'

const KEY = 'porter/docs'

/**
 * Capture queue in extension local storage (unlimitedStorage granted).
 * Docs are keyed by SourceDoc.id, so re-capturing a thread REPLACES the
 * stale doc instead of duplicating it — that is the dedup story.
 */
export async function listDocs(): Promise<SourceDoc[]> {
  const got = await browser.storage.local.get(KEY)
  const docs = (got[KEY] ?? []) as SourceDoc[]
  return docs.toSorted((a, b) => b.capturedAt.localeCompare(a.capturedAt))
}

export async function upsertDoc(doc: SourceDoc): Promise<void> {
  const docs = await listDocs()
  const next = [doc, ...docs.filter((d) => d.id !== doc.id)]
  await browser.storage.local.set({ [KEY]: next })
}

export async function deleteDoc(docId: string): Promise<void> {
  const docs = await listDocs()
  await browser.storage.local.set({ [KEY]: docs.filter((d) => d.id !== docId) })
}
