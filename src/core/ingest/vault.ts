/**
 * Obsidian vault export — batch-downloads captured docs as a folder tree of
 * .md files (Tier C, design §4: same always-works `browser.downloads` path
 * as export.ts's flat per-format export). formatCapture's Markdown already
 * carries YAML frontmatter, so the downloaded tree opens as a native
 * Obsidian vault with no further conversion.
 *
 * Deliberately takes docs directly rather than doc ids + a Kv lookup (unlike
 * exportDocs in ./export.ts) so this module never depends on ../store —
 * store.ts hooks auto-export in on capture, and store.ts -> vault.ts ->
 * store.ts would be a cycle.
 */
import { Effect } from 'effect'
import { sanitizeFilenameBase } from '../filename'
import { FetchError } from '../fx/errors'
import type { SourceDoc } from '../model/types'

/** Top-level Downloads subfolder every vault export lands in. */
export const VAULT_ROOT = 'NotebookLM Porter'

const TITLE_CAP = 100

/** Vault-relative subpath for one doc's title, before collision dedup. */
function vaultBasePath(doc: SourceDoc): string {
  const sanitized = sanitizeFilenameBase(doc.title, TITLE_CAP)
  const title = sanitized.length > 0 ? sanitized : 'source'
  return `${VAULT_ROOT}/${doc.site}/${title}.md`
}

/** Inserts a " (n)" disambiguator right before the extension. */
function withCollisionSuffix(path: string, n: number): string {
  const dot = path.lastIndexOf('.')
  return `${path.slice(0, dot)} (${n})${path.slice(dot)}`
}

/**
 * Relative-subpath filename for every doc, keyed by doc id — the tree
 * layout `browser.downloads.download`'s `filename` field expects. Two docs
 * that sanitize to the same site + title (e.g. two threads both titled
 * "Untitled") get a numeric suffix in first-seen order, so one download
 * never silently clobbers another doc's file. A re-export of the SAME doc
 * set reproduces the SAME layout (the collision order only depends on the
 * input order), which is what keeps `conflictAction: 'overwrite'` idempotent
 * per doc instead of accumulating "(1)", "(2)", … on every run.
 */
export function vaultLayout(docs: readonly SourceDoc[]): Map<string, string> {
  const seenCounts = new Map<string, number>()
  const layout = new Map<string, string>()
  for (const doc of docs) {
    const base = vaultBasePath(doc)
    const seen = seenCounts.get(base) ?? 0
    seenCounts.set(base, seen + 1)
    layout.set(doc.id, seen === 0 ? base : withCollisionSuffix(base, seen))
  }
  return layout
}

/**
 * Downloads every doc's Markdown into the vault tree. Per-doc isolation
 * (Effect.result), same pattern as exportDocs/backupOne: one download
 * failure never aborts the rest of the batch, and never fails the caller —
 * this runs unattended from the capture hook, not just an explicit popup
 * action, so there is no UI in the failure path to report to.
 */
export function exportVault(docs: readonly SourceDoc[]): Effect.Effect<void> {
  const layout = vaultLayout(docs)
  return Effect.all(
    docs.map((doc) =>
      Effect.result(downloadVaultDoc(doc, layout.get(doc.id) ?? vaultBasePath(doc))),
    ),
    { concurrency: 'unbounded' },
  ).pipe(Effect.asVoid)
}

function downloadVaultDoc(doc: SourceDoc, filename: string): Effect.Effect<void, FetchError> {
  return Effect.acquireUseRelease(
    Effect.sync(() => URL.createObjectURL(new Blob([doc.markdown], { type: 'text/markdown' }))),
    (url) =>
      Effect.tryPromise({
        try: () =>
          browser.downloads.download({
            url,
            filename,
            // Overwrite, not uniquify: re-exporting the same doc set is meant
            // to be idempotent (replace the file in place), not pile up
            // "(1)", "(2)", … copies of an unchanged doc on every re-export.
            conflictAction: 'overwrite',
            saveAs: false,
          }),
        catch: (cause) => new FetchError({ url: doc.id, cause }),
      }),
    (url) => Effect.sync(() => URL.revokeObjectURL(url)),
  ).pipe(Effect.asVoid)
}
