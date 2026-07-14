import { Effect, Result } from 'effect'
import type { TranscriptDocument, VideoEntry } from '../../model/types'
import type { FetchError, HttpStatusError } from '../../fx/errors'
import { DebugLog, Http, withHttpTimeout } from '../../fx/services'
import { extractInnertube, extractYtInitialData } from './parse'
import {
  extractYtInitialPlayerResponse,
  parseAutoChapters,
  parseCaptionTracks,
  parseJson3Cues,
  renderTranscriptMarkdown,
  selectCaptionTrack,
  type CaptionTrack,
} from './transcript'

/** Keep enrichment bounded; videos beyond this remain normal YouTube URL sources. */
export const MAX_TRANSCRIPT_VIDEOS = 200
const TRANSCRIPT_CONCURRENCY = 4

function chaptersFromWatchHtml(html: string) {
  try {
    return parseAutoChapters(extractYtInitialData(html))
  } catch {
    return []
  }
}

function json3Url(trackUrl: string): string | undefined {
  try {
    const url = new URL(trackUrl)
    url.searchParams.set('fmt', 'json3')
    return url.toString()
  } catch {
    return undefined
  }
}

function tryExtractInnertube(html: string): { apiKey: string; context: unknown } | undefined {
  try {
    return extractInnertube(html)
  } catch {
    return undefined
  }
}

/**
 * A cookieless watch-page fetch frequently omits `captionTracks` from the
 * inline player response. The InnerTube `player` endpoint returns them
 * reliably, reusing the API key + client context already embedded in that same
 * page. Any failure yields no tracks so the caller falls back to a URL source.
 */
function playerApiCaptionTracks(
  html: string,
  videoId: string,
): Effect.Effect<CaptionTrack[], FetchError | HttpStatusError, Http> {
  return Effect.gen(function* () {
    const config = tryExtractInnertube(html)
    if (config === undefined) return []
    const http = yield* Http
    const player = yield* http.json(
      `https://www.youtube.com/youtubei/v1/player?key=${config.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en' },
        body: JSON.stringify({ context: config.context, videoId }),
      },
    )
    return parseCaptionTracks(player)
  })
}

/** Why a video produced no transcript — aggregated so 0/N is diagnosable, not silent. */
type SkipReason =
  | 'no-player-response'
  | 'no-caption-tracks'
  | 'no-json3-url'
  | 'no-cues'
  | 'fetch-failed'

type EnrichOutcome =
  | { kind: 'doc'; doc: TranscriptDocument }
  | { kind: 'skip'; reason: Exclude<SkipReason, 'fetch-failed'> }

/** enrichVideo's outcome plus the caller-supplied `fetch-failed` for http errors. */
type EnrichAggregate =
  | { kind: 'doc'; doc: TranscriptDocument }
  | { kind: 'skip'; reason: SkipReason }

function enrichVideo(
  video: VideoEntry,
): Effect.Effect<EnrichOutcome, FetchError | HttpStatusError, Http> {
  return withHttpTimeout(
    Effect.gen(function* () {
      const http = yield* Http
      const html = yield* http.text(video.url, { headers: { 'Accept-Language': 'en' } })
      const playerResponse = extractYtInitialPlayerResponse(html)
      // Prefer the inline tracks (one fewer request); fall back to the InnerTube
      // player endpoint when the cookieless page carries none.
      let tracks = playerResponse === undefined ? [] : parseCaptionTracks(playerResponse)
      if (tracks.length === 0) {
        tracks = yield* playerApiCaptionTracks(html, video.videoId)
      }
      const track = selectCaptionTrack(tracks)
      if (track === undefined) {
        return {
          kind: 'skip',
          reason: playerResponse === undefined ? 'no-player-response' : 'no-caption-tracks',
        }
      }

      const captionUrl = json3Url(track.url)
      if (captionUrl === undefined) return { kind: 'skip', reason: 'no-json3-url' }

      const captionJson = yield* http.text(captionUrl, { headers: { 'Accept-Language': 'en' } })
      const markdown = renderTranscriptMarkdown(
        video,
        parseJson3Cues(captionJson),
        chaptersFromWatchHtml(html),
      )
      if (markdown === undefined) return { kind: 'skip', reason: 'no-cues' }
      return {
        kind: 'doc',
        doc: { videoId: video.videoId, url: video.url, title: video.title, markdown },
      }
    }),
    video.url,
  )
}

/**
 * Captures available transcripts without making them a capture prerequisite.
 * Every unsuccessful video deliberately falls back to the normal YouTube URL
 * ingest unit, and signed caption URLs are never surfaced or logged.
 */
export function enrichPlaylistTranscripts(
  videos: VideoEntry[],
): Effect.Effect<TranscriptDocument[], never, Http | DebugLog> {
  return Effect.gen(function* () {
    const consideredCount = Math.min(videos.length, MAX_TRANSCRIPT_VIDEOS)
    const outcomes = yield* Effect.forEach(
      videos.slice(0, MAX_TRANSCRIPT_VIDEOS),
      (video) =>
        enrichVideo(video).pipe(
          Effect.result,
          Effect.map(
            (result): EnrichAggregate =>
              Result.isSuccess(result) ? result.success : { kind: 'skip', reason: 'fetch-failed' },
          ),
        ),
      { concurrency: TRANSCRIPT_CONCURRENCY },
    )
    const docs = outcomes.flatMap((outcome) => (outcome.kind === 'doc' ? [outcome.doc] : []))
    // Histogram of why videos fell back — turns a silent 0/N enrichment into a
    // precise cause (consent page vs no captions vs empty cues vs fetch error).
    const skips: Partial<Record<SkipReason, number>> = {}
    for (const outcome of outcomes) {
      if (outcome.kind === 'skip') skips[outcome.reason] = (skips[outcome.reason] ?? 0) + 1
    }
    const debugLog = yield* DebugLog
    yield* debugLog.log('youtube', 'transcript enrichment summary', {
      totalVideos: videos.length,
      consideredCount,
      enrichedCount: docs.length,
      fallbackCount: consideredCount - docs.length,
      cappedByLimit: videos.length > MAX_TRANSCRIPT_VIDEOS,
      skips,
    })
    return docs
  })
}
