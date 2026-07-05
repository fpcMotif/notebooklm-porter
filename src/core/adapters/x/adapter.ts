import type { Capturable, SourceAdapter } from '../types'

/**
 * X threads need logged-in page context (DOM + intercepted GraphQL), so
 * extraction lives in `entrypoints/x.content.ts`, not here — this adapter
 * only contributes detection and host permissions.
 */
export const xAdapter: SourceAdapter = {
  id: 'x',
  hostMatch: ['https://x.com/*', 'https://twitter.com/*', 'https://mobile.twitter.com/*'],
  contentScript: true,
  detect(url: string): Capturable | null {
    const u = safeUrl(url)
    if (!u) return null
    // /<handle>/status/<id> — a thread page.
    if (/^\/[^/]+\/status\/\d+/.test(u.pathname)) {
      return { kind: 'thread', label: 'Capture this thread' }
    }
    return null
  },
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
