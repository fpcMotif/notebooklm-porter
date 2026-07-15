import type { Capturable, SourceAdapter } from '../types'
import { captureRedditThread } from './capture'

export const redditAdapter: SourceAdapter = {
  id: 'reddit',
  hostMatch: [
    'https://www.reddit.com/*',
    'https://old.reddit.com/*',
    'https://reddit.com/*',
    'https://sh.reddit.com/*',
  ],
  detect(url: string): Capturable | null {
    const u = safeUrl(url)
    if (!u) return null
    if (/^\/r\/[^/]+\/comments\/[a-z0-9]+/i.test(u.pathname)) {
      return { kind: 'thread', label: 'Capture this discussion' }
    }
    return null
  },
  strategy: { mode: 'url', capture: captureRedditThread },
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
