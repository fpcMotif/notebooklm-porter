/**
 * NBLM `batchexecute` RPC protocol constants, isolated in one file so a
 * Google-side change is a one-file patch (design §4). Pure — no fetch.
 */

export const RPC_IDS = {
  addSource: 'izAoDd',
  addSourceFile: 'o4cbdc',
  listNotebooks: 'wXbhsf',
} as const

const ANTI_XSSI_PREFIX = ")]}'"

export function batchexecuteUrl(authuser: number): string {
  return `https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?authuser=${authuser}`
}

export function homeUrl(authuser: number): string {
  return `https://notebooklm.google.com/?authuser=${authuser}`
}

/** f.req wraps a single RPC call; 'generic' is the fixed call-type literal NBLM expects. */
export function buildEnvelope(rpcId: string, params: unknown, csrfToken: string): string {
  const fReq = JSON.stringify([[[rpcId, JSON.stringify(params), null, 'generic']]])
  return `f.req=${encodeURIComponent(fReq)}&at=${encodeURIComponent(csrfToken)}`
}

/**
 * Strips the anti-XSSI prefix, then scans the line-delimited JSON chunks for
 * the `["wrb.fr", rpcId, <json-string>, ...]` line matching rpcId and returns
 * the parsed 3rd element. Throws a distinctly-labeled error on any shape
 * mismatch so callers can surface "protocol-drift" instead of silently
 * treating a broken response as an empty result (design §4).
 */
export function parseBatchexecuteResponse(text: string, rpcId: string): unknown {
  const body = text.startsWith(ANTI_XSSI_PREFIX) ? text.slice(ANTI_XSSI_PREFIX.length) : text

  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }

    const match = findWrbFrLine(parsed, rpcId)
    if (match !== undefined) {
      try {
        return JSON.parse(match)
      } catch {
        throw new Error(`protocol-drift: unparseable payload for rpcId ${rpcId}`)
      }
    }
  }

  throw new Error(`protocol-drift: no wrb.fr line found for rpcId ${rpcId}`)
}

/**
 * batchexecute responses are an array of chunks, each itself an array of
 * `["wrb.fr", rpcId, jsonString, ...]` entries. Walks both levels defensively
 * since the wrapping depth has drifted across Google RPC surfaces before.
 */
function findWrbFrLine(parsed: unknown, rpcId: string): string | undefined {
  if (!Array.isArray(parsed)) return undefined

  for (const entry of parsed) {
    if (isWrbFrEntry(entry, rpcId)) {
      return entry[2]
    }
    if (Array.isArray(entry)) {
      const nested = findWrbFrLine(entry, rpcId)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function isWrbFrEntry(
  entry: unknown,
  rpcId: string,
): entry is ['wrb.fr', string, string, ...unknown[]] {
  return (
    Array.isArray(entry) &&
    entry[0] === 'wrb.fr' &&
    entry[1] === rpcId &&
    typeof entry[2] === 'string'
  )
}
