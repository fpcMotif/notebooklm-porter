/**
 * Export stored docs as downloaded .md / .jsonl files via chrome.downloads —
 * the always-works ingest path (NotebookLM accepts Markdown file upload).
 * Tier C (design §4): zero ToS/breakage risk, and the automatic destination
 * when Tier A (RPC) and Tier B (DOM) both fail.
 */
import { Effect } from 'effect'
import { sanitizeFilenameBase } from '../filename'
import { FetchError, type StorageError } from '../fx/errors'
import type { Kv } from '../fx/services'
import type { SourceDoc } from '../model/types'
import { listDocs } from '../store'

export type ExportFormat = 'markdown' | 'jsonl'

/**
 * Filesystem-safe download filename for a doc title. Whitespace (including
 * tabs/newlines) collapses to a single space first; remaining hostile
 * characters (path separators, Windows-reserved glyphs, control chars)
 * become '-'; length is capped so it never trips OS path-length limits; an
 * empty/whitespace-only title falls back to 'source' so a download is never
 * silently unnamed.
 */
export function exportFilename(title: string, format: ExportFormat): string {
  const ext = format === 'markdown' ? 'md' : 'jsonl'
  const sanitized = sanitizeFilenameBase(title, 120)
  const base = sanitized.length > 0 ? sanitized : 'source'
  return `${base}.${ext}`
}

/** Content + MIME type for a doc's blob, per export format. */
export function docBlobParts(
  doc: SourceDoc,
  format: ExportFormat,
): { content: string; mime: string } {
  if (format === 'jsonl') {
    return { content: doc.jsonl ?? '', mime: 'application/x-ndjson' }
  }
  return { content: doc.markdown, mime: 'text/markdown' }
}

/**
 * Downloads each selected doc as a Blob-URL file. Docs not found in the
 * store (e.g. deleted between selection and export) are silently skipped —
 * the caller sees only the ids that actually downloaded via the Chrome
 * downloads UI itself.
 */
export function exportDocs(
  docIds: string[],
  format: ExportFormat,
): Effect.Effect<void, StorageError, Kv> {
  return Effect.gen(function* () {
    const docs = yield* listDocs()
    const byId = new Map(docs.map((d) => [d.id, d]))
    const selected = docIds.map((id) => byId.get(id)).filter((doc) => doc !== undefined)

    // Per-doc isolation (Effect.result), same pattern as ingestOneDoc/backupOne:
    // one doc's download failure must not abort the rest of the batch.
    yield* Effect.all(
      selected.map((doc) => Effect.result(downloadDoc(doc, format))),
      { concurrency: 'unbounded' },
    )
  })
}

function downloadDoc(doc: SourceDoc, format: ExportFormat): Effect.Effect<void, FetchError> {
  const { content, mime } = docBlobParts(doc, format)
  return Effect.acquireUseRelease(
    Effect.sync(() => URL.createObjectURL(new Blob([content], { type: mime }))),
    (url) =>
      Effect.tryPromise({
        try: () =>
          browser.downloads.download({
            url,
            filename: exportFilename(doc.title, format),
            saveAs: false,
          }),
        catch: (cause) => new FetchError({ url: doc.id, cause }),
      }),
    (url) => Effect.sync(() => URL.revokeObjectURL(url)),
  ).pipe(Effect.asVoid)
}
