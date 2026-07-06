/**
 * NBLM `batchexecute` RPC protocol constants, isolated in one file so a
 * Google-side change is a one-file patch (design §4). Pure — no fetch.
 *
 * Wire format verified against notebooklm-py + real captured VCR cassettes
 * (2026 migrated format): responses are `rt=c` chunked (byte-count line then
 * a JSON-array line, alternating), and add-source params carry a trailing
 * TEMPLATE_BLOCK tail — flat `[2]` tails from the pre-migration wire are
 * rejected by the server.
 */

export const RPC_IDS = {
  addSource: 'izAoDd',
  addSourceFile: 'o4cbdc',
  listNotebooks: 'wXbhsf',
  createNotebook: 'CCqFvf',
} as const

const ANTI_XSSI_PREFIX = ")]}'"

/**
 * 2026 migrated wire format's fixed template tail for izAoDd/CCqFvf params.
 * Flat `[2]` tails (pre-migration) are rejected by the server.
 */
export const TEMPLATE_BLOCK = [
  2,
  null,
  null,
  [1, null, null, null, null, null, null, null, null, null, [1]],
]

export function homeUrl(authuser: number): string {
  return `https://notebooklm.google.com/?authuser=${authuser}`
}

export function buildRpcUrl(opts: {
  rpcId: string
  authuser: number
  fSid?: string
  sourcePath?: string
}): string {
  const sourcePath = opts.sourcePath ?? '/'
  const params = new URLSearchParams()
  params.set('rpcids', opts.rpcId)
  params.set('source-path', sourcePath)
  if (opts.fSid !== undefined) params.set('f.sid', opts.fSid)
  params.set('hl', 'en')
  params.set('rt', 'c')
  params.set('authuser', String(opts.authuser))
  return `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?${params.toString()}`
}

/** f.req wraps a single RPC call; 'generic' is the fixed call-type literal NBLM expects. */
export function buildEnvelope(rpcId: string, params: unknown, csrfToken: string): string {
  const fReq = JSON.stringify([[[rpcId, JSON.stringify(params), null, 'generic']]])
  return `f.req=${encodeURIComponent(fReq)}&at=${encodeURIComponent(csrfToken)}&`
}

export function listNotebooksParams(): unknown[] {
  return [null, 1, null, [2]]
}

export function createNotebookParams(title: string): unknown[] {
  return [title, null, null, TEMPLATE_BLOCK]
}

export function addUrlSourceParams(notebookId: string, url: string): unknown[] {
  return [
    [[null, null, [url], null, null, null, null, null, null, null, 1]],
    notebookId,
    TEMPLATE_BLOCK,
  ]
}

export function addYoutubeSourceParams(notebookId: string, url: string): unknown[] {
  return [
    [[null, null, null, null, null, null, null, [url], null, null, 1]],
    notebookId,
    TEMPLATE_BLOCK,
  ]
}

export function addTextSourceParams(notebookId: string, title: string, content: string): unknown[] {
  return [
    [[null, [title, content], null, 2, null, null, null, null, null, null, 1]],
    notebookId,
    TEMPLATE_BLOCK,
  ]
}

/**
 * Parses the `rt=c` chunked batchexecute response: strips the anti-XSSI
 * prefix, then scans EVERY line that parses as a JSON array (tolerating the
 * interleaved byte-count lines — those fail JSON.parse and are skipped).
 * Each chunk is an array of frames `[tag, rpcId, resultJsonString, ...]`:
 *   - tag `"er"` for the matching rpcId ⇒ server error, throws immediately.
 *   - tag `"wrb.fr"` for the matching rpcId ⇒ candidate result; NBLM sends a
 *     placeholder-then-real pair for some RPCs, so the LAST non-null frame
 *     for the rpcId wins rather than the first.
 * Throws a distinctly-labeled error on any shape mismatch so callers can
 * surface "protocol-drift" instead of silently treating a broken response
 * as an empty result (design §4).
 */
export function parseBatchexecuteResponse(text: string, rpcId: string): unknown {
  const body = text.startsWith(ANTI_XSSI_PREFIX) ? text.slice(ANTI_XSSI_PREFIX.length) : text

  let lastMatch: string | undefined

  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Byte-count lines (and any other non-JSON noise) are expected filler
      // in the rt=c chunked format — tolerate and keep scanning.
      continue
    }

    if (!Array.isArray(parsed)) continue

    for (const frame of parsed) {
      if (!Array.isArray(frame)) continue
      if (frame[1] !== rpcId) continue

      if (frame[0] === 'er') {
        throw new Error(`rpc-error: ${JSON.stringify(frame[2])}`)
      }
      if (frame[0] === 'wrb.fr' && frame[2] !== null && frame[2] !== undefined) {
        lastMatch = frame[2] as string
      }
    }
  }

  if (lastMatch === undefined) {
    throw new Error(
      `protocol-drift: no wrb.fr frame found for rpcId ${rpcId} in response: ${text.slice(0, 500)}`,
    )
  }

  try {
    return JSON.parse(lastMatch)
  } catch {
    throw new Error(`protocol-drift: unparseable payload for rpcId ${rpcId}`)
  }
}

/** Skips malformed rows (missing id/title) rather than throwing on a partial list. */
export function parseNotebookList(result: unknown): { id: string; title: string }[] {
  if (!Array.isArray(result)) return []

  const notebooks: { id: string; title: string }[] = []
  for (const row of result) {
    if (!Array.isArray(row)) continue
    const title = row[0]
    const id = row[2]
    if (typeof title === 'string' && typeof id === 'string') {
      notebooks.push({ id, title })
    }
  }
  return notebooks
}
