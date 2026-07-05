import type { Capture } from '../../model/types'
import type { Capturable, SourceAdapter } from '../types'

export const hackernewsAdapter: SourceAdapter = {
  id: 'hackernews',
  hostMatch: ['https://news.ycombinator.com/*'],
  apiHosts: ['https://hn.algolia.com/*'],
  detect(url: string): Capturable | null {
    const u = safeUrl(url)
    if (!u) return null
    if (u.pathname === '/item' && u.searchParams.get('id')) {
      return { kind: 'thread', label: 'Capture this discussion' }
    }
    return null
  },
  async captureFromUrl(url: string): Promise<Capture> {
    const { captureHnThread } = await import('./capture')
    return captureHnThread(url)
  },
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
