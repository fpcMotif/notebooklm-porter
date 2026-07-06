import type { Capture } from '../../model/types'
import {
  extractInnertube,
  extractYtInitialData,
  parseContinuation,
  parsePlaylistPage,
} from './parse'

const MAX_VIDEOS = 500

/** `RD`/`UL`-prefixed `list=` ids are session-generated Mixes/Radios: no real `/playlist?list=` page exists for them. */
export function isMixList(listId: string): boolean {
  return listId.startsWith('RD') || listId.startsWith('UL')
}

/**
 * Capture a YouTube playlist from its URL: fetch the playlist page, parse
 * `ytInitialData` for the first ~100 entries (server-rendered), then walk
 * InnerTube `browse` continuations for the rest. Runs in the background
 * service worker — no content script involved.
 */
export async function capturePlaylist(url: string): Promise<Capture> {
  const playlistId = extractPlaylistId(url)

  if (isMixList(playlistId)) {
    return captureMixPlaylist(url, playlistId)
  }

  const pageUrl = `https://www.youtube.com/playlist?list=${playlistId}`
  const html = await fetchPageHtml(pageUrl)

  const initialData = extractDataOrThrow(html, pageUrl)
  const { playlist, continuation: firstContinuation } = parsePlaylistOrThrow(
    initialData,
    playlistId,
    pageUrl,
  )

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

/**
 * Captures a Mix/Radio (`list=RD*`/`UL*`): these have no `/playlist?list=`
 * page and are session-generated + endless, so there's no continuation to
 * walk — just parse the watch page's embedded panel and mark it truncated.
 */
async function captureMixPlaylist(url: string, playlistId: string): Promise<Capture> {
  const pageUrl = cleanWatchUrl(url, playlistId)
  const html = await fetchPageHtml(pageUrl)

  const initialData = extractDataOrThrow(html, pageUrl)
  const { playlist } = parsePlaylistOrThrow(initialData, playlistId, pageUrl)

  playlist.url = pageUrl
  playlist.videoCount = Math.max(playlist.videoCount, playlist.videos.length)
  playlist.truncated = true

  return { kind: 'playlist', playlist }
}

/** Strips `t=`/other player params from a watch URL, keeping only `v=` and `list=`. */
function cleanWatchUrl(url: string, playlistId: string): string {
  const u = new URL(url)
  const videoId = u.searchParams.get('v')
  if (!videoId) {
    throw new Error(`capturePlaylist: no video id ("v=") found in mix URL ${url}`)
  }
  return `https://www.youtube.com/watch?v=${videoId}&list=${playlistId}`
}

async function fetchPageHtml(pageUrl: string): Promise<string> {
  let pageRes: Response
  try {
    pageRes = await fetch(pageUrl, { headers: { 'Accept-Language': 'en' } })
  } catch (err) {
    throw new Error(`capturePlaylist: fetch ${pageUrl} failed`, { cause: err })
  }
  if (!pageRes.ok) {
    throw new Error(`capturePlaylist: fetch ${pageUrl} failed with ${pageRes.status}`)
  }
  return pageRes.text()
}

function extractDataOrThrow(html: string, pageUrl: string): unknown {
  try {
    return extractYtInitialData(html)
  } catch (err) {
    throw new Error(`capturePlaylist: failed to parse page ${pageUrl}`, { cause: err })
  }
}

function parsePlaylistOrThrow(
  data: unknown,
  playlistId: string,
  pageUrl: string,
): ReturnType<typeof parsePlaylistPage> {
  try {
    return parsePlaylistPage(data, playlistId)
  } catch (err) {
    throw new Error(`capturePlaylist: failed to parse page ${pageUrl}`, { cause: err })
  }
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
