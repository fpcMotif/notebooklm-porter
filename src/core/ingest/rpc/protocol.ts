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

import { type NotebookSource, sourceKindFromCode, sourceStatusFromCode } from '../sources/model'
import type { NotebookMeta } from '../../notebooks/model'

export const RPC_IDS = {
  addSource: 'izAoDd',
  addSourceFile: 'o4cbdc',
  listNotebooks: 'wXbhsf',
  createNotebook: 'CCqFvf',
  /** Fetch one notebook incl. its source rows (source-console list). */
  getNotebook: 'rLM1Ne',
  /** Remove one source from a notebook (source-console dedup). */
  deleteSource: 'tGMBJ',
  /** Re-fetch one URL/Drive source in place (source-console retry). */
  refreshSource: 'FLmJqe',
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

/** GET_NOTEBOOK (rLM1Ne) params — fetch one notebook incl. its source rows. */
export function getNotebookParams(notebookId: string): unknown[] {
  return [notebookId, null, [2], null, 0]
}

/** DELETE_SOURCE (tGMBJ) params — remove one source by id. */
export function deleteSourceParams(sourceId: string): unknown[] {
  return [[[sourceId]]]
}

/** REFRESH_SOURCE (FLmJqe) params — re-fetch one URL/Drive source by id. */
export function refreshSourceParams(sourceId: string): unknown[] {
  return [null, [sourceId], [2]]
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

/**
 * Source-id envelope variants at `entry[0]`: bare `"id"`, typical `["id"]`, or
 * drive-backed `[null, true, ["id"]]`. Returns the id string or undefined.
 */
function extractSourceId(envelope: unknown): string | undefined {
  if (typeof envelope === 'string') return envelope
  const arr = asArray(envelope)
  if (arr === undefined) return undefined
  const plain = arr[0]
  if (typeof plain === 'string') return plain
  const driveInner = asArray(arr[2])?.[0]
  return typeof driveInner === 'string' ? driveInner : undefined
}

/** Canonical URL from `metadata[7][0]`, falling back to the youtube block `metadata[5][0]`. */
function extractSourceUrl(metadata: unknown[] | undefined): string | undefined {
  const canonical = asArray(metadata?.[7])?.[0]
  if (typeof canonical === 'string' && canonical !== '') return canonical
  const youtube = asArray(metadata?.[5])?.[0]
  if (typeof youtube === 'string' && youtube !== '') return youtube
  return undefined
}

function parseSourceRow(entry: unknown): NotebookSource | undefined {
  const arr = asArray(entry)
  if (arr === undefined || arr.length === 0) return undefined
  const id = extractSourceId(arr[0])
  if (id === undefined || id === '') return undefined

  const rawTitle = arr[1]
  const title = typeof rawTitle === 'string' ? rawTitle : ''
  const metadata = asArray(arr[2])
  const url = extractSourceUrl(metadata)
  const createdAt = asArray(metadata?.[2])?.[0]

  return {
    id,
    title,
    kind: sourceKindFromCode(metadata?.[4]),
    status: sourceStatusFromCode(asArray(arr[3])?.[1]),
    ...(url !== undefined ? { url } : {}),
    ...(typeof createdAt === 'number' ? { createdAt } : {}),
  }
}

/**
 * Extracts a notebook's source rows from a GET_NOTEBOOK (rLM1Ne) result. The
 * rows live at `result[0][1]`; a genuinely empty notebook elides that slot
 * (`null`) and yields `[]`. Malformed rows are skipped rather than throwing, so
 * a partial list still surfaces — mirroring `parseNotebookList`.
 */
export function parseNotebookSources(result: unknown): NotebookSource[] {
  const info = asArray(asArray(result)?.[0])
  const rows = asArray(info?.[1])
  if (rows === undefined) return []
  const sources: NotebookSource[] = []
  for (const row of rows) {
    const parsed = parseSourceRow(row)
    if (parsed !== undefined) sources.push(parsed)
  }
  return sources
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
  let sawFrame = false

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
        throw new Error(`rpc-error: ${safeRpcErrorCode(frame[2])}`)
      }
      if (frame[0] === 'wrb.fr') {
        sawFrame = true
        if (frame[2] !== null && frame[2] !== undefined) {
          lastMatch = frame[2] as string
        }
      }
    }
  }

  if (lastMatch === undefined) {
    // Placeholder-only response (wrb.fr frame with null result, no er) =
    // server ACCEPTED the call but sent no payload — observed live on izAoDd
    // adds that did succeed. Treating it as drift makes callers retry and
    // create duplicate sources.
    if (sawFrame) return null
    throw new Error(
      `protocol-drift: no wrb.fr frame found for rpcId ${rpcId}; responseBytes=${text.length}`,
    )
  }

  try {
    return JSON.parse(lastMatch)
  } catch {
    throw new Error(`protocol-drift: unparseable payload for rpcId ${rpcId}`)
  }
}

function safeRpcErrorCode(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && SAFE_RPC_ERROR_CODES.has(value)) return value
  return 'UNKNOWN'
}

const SAFE_RPC_ERROR_CODES = new Set([
  'ABORTED',
  'ALREADY_EXISTS',
  'CANCELLED',
  'DEADLINE_EXCEEDED',
  'FAILED_PRECONDITION',
  'INTERNAL',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'QUOTA_EXCEEDED',
  'RESOURCE_EXHAUSTED',
  'UNAUTHENTICATED',
  'UNAVAILABLE',
  'UNKNOWN',
])

/** Strictly decodes the two verified wXbhsf catalog containers. */
export function parseNotebookList(result: unknown): NotebookMeta[] {
  if (!Array.isArray(result)) {
    throw new Error('protocol-drift: notebook list is not an array')
  }
  if (result.length === 0) return []
  const nested =
    (result.length === 1 || (result.length === 2 && result[1] === null)) &&
    Array.isArray(result[0]) &&
    !isNotebookRow(result[0])
  if (nested) {
    return notebookRows(result[0])
  }
  return notebookRows(result)
}

function isNotebookRow(value: unknown): value is unknown[] {
  return Array.isArray(value) && typeof value[0] === 'string' && typeof value[2] === 'string'
}

function notebookRows(rows: unknown[]): NotebookMeta[] {
  const notebooks: NotebookMeta[] = []
  for (const [index, row] of rows.entries()) {
    if (!Array.isArray(row)) {
      throw new Error(`protocol-drift: notebook row ${index} is not an array`)
    }
    const title = row[0]
    const id = row[2]
    if (typeof title !== 'string' || typeof id !== 'string') {
      throw new Error(`protocol-drift: notebook row ${index} lacks title or id`)
    }
    notebooks.push({ id, title })
  }
  return notebooks
}

export interface CreateNotebookAck {
  readonly hintedId?: string
}

/** Extracts the only trusted create-response fact; unknown accepted shapes carry no hint. */
export function parseCreateNotebookAck(result: unknown): CreateNotebookAck {
  if (isCreateNotebookHint(result)) return { hintedId: result[2] }
  if (Array.isArray(result) && result.length === 1 && isCreateNotebookHint(result[0])) {
    return { hintedId: result[0][2] }
  }
  return {}
}

function isCreateNotebookHint(
  value: unknown,
): value is [title: string, placeholder: null, id: string] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    typeof value[0] === 'string' &&
    value[1] === null &&
    typeof value[2] === 'string'
  )
}
