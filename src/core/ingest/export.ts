/**
 * Export stored docs as downloaded .md / .jsonl files via chrome.downloads —
 * the always-works ingest path (NotebookLM accepts Markdown file upload).
 *
 * TODO(codegen): implement per docs/superpowers/specs design §Ingest.
 */
export async function exportDocs(docIds: string[], format: 'markdown' | 'jsonl'): Promise<void> {
  throw new Error(`not implemented: exportDocs(${docIds.length} docs, ${format})`)
}
