import type { Capturable, SourceAdapter } from '../types'
import { captureYoutube, isMixList } from './capture'
import { standaloneYoutubeVideo, youtubeVideoIdentity } from './video'

export const youtubeAdapter: SourceAdapter = {
  id: 'youtube',
  hostMatch: [
    'https://www.youtube.com/*',
    'https://youtube.com/*',
    'https://m.youtube.com/*',
    'https://youtu.be/*',
  ],
  detect(url: string): Capturable | null {
    const u = safeUrl(url)
    if (!u) return null
    const listId = u.searchParams.get('list')
    if (u.pathname === '/playlist' && listId) {
      return { kind: 'playlist', label: 'Capture this playlist' }
    }
    if (listId && youtubeVideoIdentity(url) !== undefined) {
      const label = isMixList(listId)
        ? 'Capture this Mix (snapshot)'
        : "Capture this video's playlist"
      return { kind: 'playlist', label }
    }
    if (standaloneYoutubeVideo(url) !== undefined) {
      return { kind: 'video', label: 'Capture this video' }
    }
    return null
  },
  captureFromUrl: captureYoutube,
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
