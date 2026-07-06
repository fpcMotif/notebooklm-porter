import type { SourceDoc } from '../model/types'

/**
 * Deliver docs into the user's open NotebookLM notebook, RPC-first with
 * automatic degradation (design §4):
 *
 *   Tier A  batchexecute RPC (izAoDd) from the service worker  — primary
 *   Tier B  DOM automation on an open notebooklm.google.com tab — fallback
 *   Tier C  file export (see ./export.ts)                       — floor
 *
 * The active tier is reported back so the popup can show which path ran and
 * flag when Tier A has degraded.
 *
 * TODO(codegen, stage 2): implement per design §4. The RPC protocol constants
 * (endpoint, rpc ids izAoDd/o4cbdc/wXbhsf, envelope shape) live isolated in
 * ./rpc/protocol.ts so a Google-side change is a one-file patch; the client
 * in ./rpc/client.ts distinguishes not-logged-in vs protocol-drift vs quota.
 */
export type IngestTier = 'rpc' | 'dom' | 'file'

export interface IngestOutcome {
  docId: string
  ok: boolean
  tier: IngestTier
  error?: string
}

export async function ingestIntoNotebook(
  docIds: string[],
  opts?: { authuser?: number },
): Promise<IngestOutcome[]> {
  void (docIds satisfies string[])
  void opts
  throw new Error('not implemented: ingestIntoNotebook (design §4, stage 2)')
}

/** Render helper kept here so callers never import a doc's Thread — only the SourceDoc. */
export type IngestableDoc = Pick<SourceDoc, 'id' | 'title' | 'canonicalUrl' | 'kind' | 'markdown'>
