import { Effect, Result } from 'effect'
import type { Capture, Playlist, VideoEntry } from '../../model/types'
import { ExtractionError, type FetchError, type HttpStatusError } from '../../fx/errors'
import { DebugLog, Http } from '../../fx/services'
import { enrichPlaylistTranscripts } from './enrich'
import { extractYtInitialPlayerResponse } from './transcript'
import { standaloneYoutubeVideo, videoFromPlayerResponse, youtubeVideoIdentity } from './video'
import {
  extractInnertube,
  extractYtInitialData,
  parseContinuation,
  parsePlaylistPage,
} from './parse'

const MAX_VIDEOS = 500

export interface CapturePlaylistOptions {
  /** Best-effort, bounded transcript snapshots for the playlist's first videos. */
  enrichTranscripts?: boolean
}

/** `RD`/`UL`-prefixed `list=` ids are session-generated Mixes/Radios: no real `/playlist?list=` page exists for them. */
export function isMixList(listId: string): boolean {
  return listId.startsWith('RD') || listId.startsWith('UL')
}

/** Selects the URL's natural capture shape without making adapter callers branch. */
export function captureYoutube(
  url: string,
  options: CapturePlaylistOptions = {},
): Effect.Effect<Capture, FetchError | HttpStatusError | ExtractionError, Http | DebugLog> {
  return hasPlaylistParameter(url) ? capturePlaylist(url, options) : captureVideo(url)
}

/** Captures one canonical YouTube source; metadata extraction is best-effort only. */
export function captureVideo(
  url: string,
): Effect.Effect<Capture, FetchError | HttpStatusError | ExtractionError, Http | DebugLog> {
  return Effect.gen(function* () {
    const identity = standaloneYoutubeVideo(url)
    if (identity === undefined) {
      return yield* Effect.fail(
        new ExtractionError({ url, reason: 'not a standalone YouTube video URL' }),
      )
    }
    const html = yield* fetchPageHtml(identity.url)
    const video = videoFromPlayerResponse(extractYtInitialPlayerResponse(html), identity)
    const debugLog = yield* DebugLog
    yield* debugLog.log('youtube', 'video captured', {
      videoId: video.videoId,
      hasChannel: video.channel !== undefined,
    })
    return { kind: 'video', video }
  })
}

/**
 * Capture a YouTube playlist from its URL: fetch the playlist page, parse
 * `ytInitialData` for the first ~100 entries (server-rendered), then walk
 * InnerTube `browse` continuations for the rest. Runs in the background
 * service worker — no content script involved.
 */
export function capturePlaylist(
  url: string,
  options: CapturePlaylistOptions = {},
): Effect.Effect<Capture, FetchError | HttpStatusError | ExtractionError, Http | DebugLog> {
  return Effect.gen(function* () {
    const playlistId = yield* extractPlaylistId(url)
    const debugLog = yield* DebugLog

    if (isMixList(playlistId)) {
      return yield* captureMixPlaylist(url, playlistId, options)
    }

    const pageUrl = `https://www.youtube.com/playlist?list=${playlistId}`
    const html = yield* fetchPageHtml(pageUrl)

    const initialData = yield* extractDataOrFail(html, pageUrl)
    const { playlist, continuation: firstContinuation } = yield* parsePlaylistOrFail(
      initialData,
      playlistId,
      pageUrl,
    )
    // 0 videos here means markup drift, NOT an empty playlist — the single
    // most useful line for "why did my 300-video playlist come back short".
    yield* debugLog.log(
      'youtube',
      'playlist first page parsed',
      {
        initialVideoCount: playlist.videos.length,
        declaredVideoCount: playlist.videoCount,
        hasContinuation: Boolean(firstContinuation),
      },
      { run: playlistId },
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
          yield* debugLog.log(
            'youtube',
            'playlist continuation failed',
            { videosSoFar: playlist.videos.length },
            { run: playlistId, level: 'warn' },
          )
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

    yield* enrichPlaylistIfRequested(playlist, options)

    yield* debugLog.log(
      'youtube',
      'playlist capture complete',
      { videoCount: playlist.videos.length, truncated: playlist.truncated === true },
      { run: playlistId },
    )

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
  options: CapturePlaylistOptions,
): Effect.Effect<Capture, FetchError | HttpStatusError | ExtractionError, Http | DebugLog> {
  return Effect.gen(function* () {
    const pageUrl = yield* cleanWatchUrl(url, playlistId)
    const html = yield* fetchPageHtml(pageUrl)

    const initialData = yield* extractDataOrFail(html, pageUrl)
    const { playlist } = yield* parsePlaylistOrFail(initialData, playlistId, pageUrl)

    playlist.url = pageUrl
    playlist.videoCount = Math.max(playlist.videoCount, playlist.videos.length)
    playlist.truncated = true

    yield* enrichPlaylistIfRequested(playlist, options)

    const debugLog = yield* DebugLog
    yield* debugLog.log(
      'youtube',
      'mix playlist captured',
      { videoCount: playlist.videos.length },
      { run: playlistId },
    )

    return { kind: 'playlist', playlist }
  })
}

function enrichPlaylistIfRequested(
  playlist: Playlist,
  options: CapturePlaylistOptions,
): Effect.Effect<void, never, Http | DebugLog> {
  if (!options.enrichTranscripts) return Effect.void
  return Effect.gen(function* () {
    const transcriptDocs = yield* enrichPlaylistTranscripts(playlist.videos)
    if (transcriptDocs.length > 0) playlist.transcriptDocs = transcriptDocs
  })
}

/** Strips `t=`/other player params from a watch URL, keeping only `v=` and `list=`. */
function cleanWatchUrl(url: string, playlistId: string): Effect.Effect<string, ExtractionError> {
  const identity = youtubeVideoIdentity(url)
  if (identity === undefined) {
    return Effect.fail(new ExtractionError({ url, reason: `no video id ("v=") found in mix URL` }))
  }
  return Effect.succeed(`https://www.youtube.com/watch?v=${identity.videoId}&list=${playlistId}`)
}

function fetchPageHtml(pageUrl: string): Effect.Effect<string, FetchError | HttpStatusError, Http> {
  return Effect.gen(function* () {
    const http = yield* Http
    return yield* http.text(pageUrl, { headers: { 'Accept-Language': 'en' } })
  })
}

function hasPlaylistParameter(url: string): boolean {
  try {
    return new URL(url).searchParams.has('list')
  } catch {
    return false
  }
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
