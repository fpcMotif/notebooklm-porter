import type { Capture } from '../../model/types'
import {
  extractInnertube,
  extractYtInitialData,
  parseContinuation,
  parsePlaylistPage,
} from './parse'

const MAX_VIDEOS = 500

/**
 * Capture a YouTube playlist from its URL: fetch the playlist page, parse
 * `ytInitialData` for the first ~100 entries (server-rendered), then walk
 * InnerTube `browse` continuations for the rest. Runs in the background
 * service worker — no content script involved.
 */
export async function capturePlaylist(url: string): Promise<Capture> {
  const playlistId = extractPlaylistId(url)

  const pageUrl = `https://www.youtube.com/playlist?list=${playlistId}`
  const pageRes = await fetch(pageUrl, { headers: { 'Accept-Language': 'en' } })
  if (!pageRes.ok) {
    throw new Error(`capturePlaylist: fetch ${pageUrl} failed with ${pageRes.status}`)
  }
  const html = await pageRes.text()

  const initialData = extractYtInitialData(html)
  const { playlist, continuation: firstContinuation } = parsePlaylistPage(initialData, playlistId)

  let continuation = firstContinuation
  let truncated = false

  if (continuation) {
    const { apiKey, context } = extractInnertube(html)
    // Sequential by necessity: each continuation token is only known after
    // the previous page's response, so this can't be parallelized.
    while (continuation && playlist.videos.length < MAX_VIDEOS) {
      let next: {
        videos: Awaited<ReturnType<typeof parseContinuation>>['videos']
        continuation?: string
      }
      try {
        next = await fetchContinuation(apiKey, context, continuation)
      } catch {
        truncated = true
        break
      }
      playlist.videos.push(...next.videos)
      continuation = next.continuation
    }
    if (continuation && playlist.videos.length >= MAX_VIDEOS) {
      truncated = true
    }
  }

  playlist.videoCount = Math.max(playlist.videoCount, playlist.videos.length)
  if (truncated) {
    playlist.truncated = true
  }

  return { kind: 'playlist', playlist }
}

/** Derives the `list=` playlist id from either a `/playlist` or `/watch` URL. */
function extractPlaylistId(url: string): string {
  const u = new URL(url)
  const listId = u.searchParams.get('list')
  if (!listId) {
    throw new Error(`capturePlaylist: no playlist id ("list=") found in ${url}`)
  }
  return listId
}

async function fetchContinuation(apiKey: string, context: unknown, continuation: string) {
  const res = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en' },
    body: JSON.stringify({ context, continuation }),
  })
  if (!res.ok) {
    throw new Error(`capturePlaylist: continuation fetch failed with ${res.status}`)
  }
  const json = await res.json()
  return parseContinuation(json)
}
