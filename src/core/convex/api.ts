/**
 * Pure request builders + response decoding for Convex's HTTP function API
 * (POST /api/query | /api/mutation). Fetch-free so the remote-profile loader
 * (through the Http service) and the Kv mirror (raw fetch in layers.ts)
 * share one tested wire shape.
 */
import type { HttpInit } from '../fx/services'

/** Convex deployment URLs must be https (typically https://<name>.convex.cloud). */
export function isValidConvexUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === 'https:'
  } catch {
    return false
  }
}

/** Trims and drops trailing slashes so `/api/...` paths compose cleanly. */
export function normalizeConvexUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export interface ConvexRequest {
  url: string
  init: HttpInit
}

function functionRequest(
  kind: 'query' | 'mutation',
  deploymentUrl: string,
  path: string,
  args: Record<string, unknown>,
): ConvexRequest {
  return {
    url: `${normalizeConvexUrl(deploymentUrl)}/api/${kind}`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, args, format: 'json' }),
    },
  }
}

export function convexQueryRequest(
  deploymentUrl: string,
  path: string,
  args: Record<string, unknown>,
): ConvexRequest {
  return functionRequest('query', deploymentUrl, path, args)
}

export function convexMutationRequest(
  deploymentUrl: string,
  path: string,
  args: Record<string, unknown>,
): ConvexRequest {
  return functionRequest('mutation', deploymentUrl, path, args)
}

export type ConvexResult = { ok: true; value: unknown } | { ok: false; error: string }

/** Decodes the `{ status: 'success' | 'error' }` envelope every function call returns. */
export function parseConvexResult(body: unknown): ConvexResult {
  if (typeof body !== 'object' || body === null || !('status' in body)) {
    return { ok: false, error: 'unrecognized Convex response shape' }
  }
  if (body.status === 'success') {
    return { ok: true, value: 'value' in body ? body.value : undefined }
  }
  const error =
    'errorMessage' in body && typeof body.errorMessage === 'string'
      ? body.errorMessage
      : 'unknown Convex error'
  return { ok: false, error }
}
