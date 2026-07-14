import type { Video } from '../../model/types'

const VIDEO_ID_RE = /^[\w-]{11}$/

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function canonicalVideoIdentity(parsed: URL): { videoId: string; url: string } | undefined {
  const host = parsed.hostname.toLowerCase()
  const videoId =
    host === 'youtu.be'
      ? parsed.pathname.split('/').find((part) => part.length > 0)
      : host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com'
        ? parsed.pathname === '/watch'
          ? (parsed.searchParams.get('v') ?? undefined)
          : parsed.pathname.startsWith('/shorts/')
            ? parsed.pathname.split('/')[2]
            : undefined
        : undefined
  if (videoId === undefined || !VIDEO_ID_RE.test(videoId)) return undefined
  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` }
}

/** Resolves a public YouTube video path, including one paired with a playlist. */
export function youtubeVideoIdentity(url: string): { videoId: string; url: string } | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  return canonicalVideoIdentity(parsed)
}

/** Canonicalizes normal and shortened public watch URLs without a playlist. */
export function standaloneYoutubeVideo(url: string): { videoId: string; url: string } | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.searchParams.has('list')) return undefined
  return canonicalVideoIdentity(parsed)
}

/**
 * Reads only display metadata. A valid canonical URL still produces a source
 * when the watch-page player response has drifted or is absent.
 */
export function videoFromPlayerResponse(
  playerResponse: unknown,
  identity: { videoId: string; url: string },
): Video {
  const details = asRecord(asRecord(playerResponse)?.videoDetails)
  const title =
    typeof details?.title === 'string' && details.title.trim() !== ''
      ? details.title
      : `YouTube video ${identity.videoId}`
  const channel =
    typeof details?.author === 'string' && details.author.trim() !== '' ? details.author : undefined
  const durationSeconds = finiteNumber(details?.lengthSeconds)
  return {
    videoId: identity.videoId,
    url: identity.url,
    title,
    ...(channel !== undefined ? { channel } : {}),
    ...(durationSeconds !== undefined && durationSeconds >= 0 ? { durationSeconds } : {}),
  }
}
