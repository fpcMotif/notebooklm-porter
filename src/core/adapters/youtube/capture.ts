import { Effect, Result } from 'effect'
import type { Capture, VideoEntry } from '../../model/types'
import { ExtractionError, type FetchError, type HttpStatusError } from '../../fx/errors'
import { Http } from '../../fx/services'
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
export function capturePlaylist(
  url: string,
): Effect.Effect<Capture, FetchError | HttpStatusError | ExtractionError, Http> {
  return Effect.gen(function* () {
    const playlistId = yield* extractPlaylistId(url)

    if (isMixList(playlistId)) {
      return yield* captureMixPlaylist(url, playlistId)
    }

    const pageUrl = `https://www.youtube.com/playlist?list=${playlistId}`
    const html = yield* fetchPageHtml(pageUrl)

    const initialData = yield* extractDataOrFail(html, pageUrl)
    const { playlist, continuation: firstContinuation } = yield* parsePlaylistOrFail(
      initialData,
      playlistId,
      pageUrl,
    )

    let continuation = firstContinuation
    let truncated = false

    if (continuation) {
      const { apiKey, context } = yield* extractInnertubeOrFail(html, pageUrl)
      // Sequential by necessity: each continuation token is only known after
      // the previous page's response, so this can't be parallelized.
      while (continuation && playlist.videos.length < MAX_VIDEOS) {
        const next: { videos: VideoEntry[]; continuation?: string } | undefined = yield* Effect.gen(
          function* () {
            const result = yield* Effect.result(
              fetchContinuation(apiKey, context, continuation as string),
            )
            return Result.isSuccess(result) ? result.success : undefined
          },
        )
        if (next === undefined) {
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
  })
}

/**
 * Captures a Mix/Radio (`list=RD*`/`UL*`): these have no `/playlist?list=`
 * page and are session-generated + endless, so there's no continuation to
 * walk — just parse the watch page's embedded panel and mark it truncated.
 */
function captureMixPlaylist(
  url: string,
  playlistId: string,
): Effect.Effect<Capture, FetchError | HttpStatusError | ExtractionError, Http> {
  return Effect.gen(function* () {
    const pageUrl = yield* cleanWatchUrl(url, playlistId)
    const html = yield* fetchPageHtml(pageUrl)

    const initialData = yield* extractDataOrFail(html, pageUrl)
    const { playlist } = yield* parsePlaylistOrFail(initialData, playlistId, pageUrl)

    playlist.url = pageUrl
    playlist.videoCount = Math.max(playlist.videoCount, playlist.videos.length)
    playlist.truncated = true

    return { kind: 'playlist', playlist }
  })
}

/** Strips `t=`/other player params from a watch URL, keeping only `v=` and `list=`. */
function cleanWatchUrl(url: string, playlistId: string): Effect.Effect<string, ExtractionError> {
  const u = new URL(url)
  const videoId = u.searchParams.get('v')
  if (!videoId) {
    return Effect.fail(new ExtractionError({ url, reason: `no video id ("v=") found in mix URL` }))
  }
  return Effect.succeed(`https://www.youtube.com/watch?v=${videoId}&list=${playlistId}`)
}

function fetchPageHtml(pageUrl: string): Effect.Effect<string, FetchError | HttpStatusError, Http> {
  return Effect.gen(function* () {
    const http = yield* Http
    return yield* http.text(pageUrl, { headers: { 'Accept-Language': 'en' } })
  })
}

function extractDataOrFail(html: string, pageUrl: string): Effect.Effect<unknown, ExtractionError> {
  return Effect.try({
    try: () => extractYtInitialData(html),
    catch: (cause) => new ExtractionError({ url: pageUrl, reason: String(cause) }),
  })
}

function extractInnertubeOrFail(
  html: string,
  pageUrl: string,
): Effect.Effect<{ apiKey: string; context: unknown }, ExtractionError> {
  return Effect.try({
    try: () => extractInnertube(html),
    catch: (cause) => new ExtractionError({ url: pageUrl, reason: String(cause) }),
  })
}

function parsePlaylistOrFail(
  data: unknown,
  playlistId: string,
  pageUrl: string,
): Effect.Effect<ReturnType<typeof parsePlaylistPage>, ExtractionError> {
  return Effect.try({
    try: () => parsePlaylistPage(data, playlistId),
    catch: (cause) => new ExtractionError({ url: pageUrl, reason: String(cause) }),
  })
}

/** Derives the `list=` playlist id from either a `/playlist` or `/watch` URL. */
function extractPlaylistId(url: string): Effect.Effect<string, ExtractionError> {
  const u = new URL(url)
  const listId = u.searchParams.get('list')
  if (!listId) {
    return Effect.fail(new ExtractionError({ url, reason: `no playlist id ("list=") found` }))
  }
  return Effect.succeed(listId)
}

function fetchContinuation(
  apiKey: string,
  context: unknown,
  continuation: string,
): Effect.Effect<
  { videos: VideoEntry[]; continuation?: string },
  FetchError | HttpStatusError,
  Http
> {
  return Effect.gen(function* () {
    const http = yield* Http
    const json = yield* http.json(`https://www.youtube.com/youtubei/v1/browse?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en' },
      body: JSON.stringify({ context, continuation }),
    })
    return parseContinuation(json)
  })
}
