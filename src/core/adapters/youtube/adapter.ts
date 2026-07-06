import type { Capture } from '../../model/types'
import type { Capturable, SourceAdapter } from '../types'
import { isMixList } from './capture'

export const youtubeAdapter: SourceAdapter = {
  id: 'youtube',
  hostMatch: ['https://www.youtube.com/*', 'https://youtube.com/*', 'https://m.youtube.com/*'],
  detect(url: string): Capturable | null {
    const u = safeUrl(url)
    if (!u) return null
    const listId = u.searchParams.get('list')
    if (u.pathname === '/playlist' && listId) {
      return { kind: 'playlist', label: 'Capture this playlist' }
    }
    if (u.pathname === '/watch' && listId) {
      const label = isMixList(listId)
        ? 'Capture this Mix (snapshot)'
        : "Capture this video's playlist"
      return { kind: 'playlist', label }
    }
    return null
  },
  async captureFromUrl(url: string): Promise<Capture> {
    // Implemented in ./capture.ts (playlist page fetch + InnerTube continuations).
    const { capturePlaylist } = await import('./capture')
    return capturePlaylist(url)
  },
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
