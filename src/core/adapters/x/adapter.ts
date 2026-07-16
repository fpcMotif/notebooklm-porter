import type { Capturable, SourceAdapter } from '../types'

export const X_CONTENT_MATCHES = [
  'https://x.com/*',
  'https://twitter.com/*',
  'https://mobile.twitter.com/*',
] as const

/**
 * X threads need logged-in page context (DOM + intercepted GraphQL), so
 * extraction lives in `entrypoints/x.content.ts`, not here — this adapter
 * only contributes detection and host permissions.
 */
export const xAdapter: SourceAdapter = {
  id: 'x',
  hostMatch: X_CONTENT_MATCHES,
  detect(url: string): Capturable | null {
    const u = safeUrl(url)
    if (!u) return null
    // /<handle>/status/<id> — a thread page.
    const match = /^\/[^/]+\/status\/(\d+)/.exec(u.pathname)
    const statusId = match?.[1]
    if (statusId !== undefined) {
      return { identity: statusId, kind: 'thread', label: 'Capture this thread' }
    }
    return null
  },
  // Extraction runs in entrypoints/x.content.ts; this adapter only contributes
  // detection and host permissions.
  strategy: { mode: 'content-script' },
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
