import type {
  Author,
  Capture,
  MediaRef,
  Playlist,
  Post,
  SourceDoc,
  SourceDocBase,
  Thread,
  TranscriptDocument,
  Video,
  VideoEntry,
  WebCapture,
} from './types'
import { isSiteId, isThreadSiteId } from './types'

type UnknownRecord = Record<string, unknown>

const mediaKinds = new Set<MediaRef['kind']>(['image', 'video', 'link-card'])

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function optionalString(record: UnknownRecord, key: string): string | undefined | null {
  if (!Object.hasOwn(record, key)) return undefined
  const value = record[key]
  return typeof value === 'string' ? value : null
}

function optionalBoolean(record: UnknownRecord, key: string): boolean | undefined | null {
  if (!Object.hasOwn(record, key)) return undefined
  const value = record[key]
  return typeof value === 'boolean' ? value : null
}

function optionalFiniteNumber(record: UnknownRecord, key: string): number | undefined | null {
  if (!Object.hasOwn(record, key)) return undefined
  const value = record[key]
  return isFiniteNumber(value) ? value : null
}

function optionalNonNegativeSafeInteger(
  record: UnknownRecord,
  key: string,
): number | undefined | null {
  if (!Object.hasOwn(record, key)) return undefined
  const value = record[key]
  return isNonNegativeSafeInteger(value) ? value : null
}

function decodeArray<T>(value: unknown, decode: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined

  const result: T[] = []
  for (const item of value) {
    const decoded = decode(item)
    if (!decoded) return undefined
    result.push(decoded)
  }
  return result
}

function decodeAuthor(value: unknown): Author | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') return undefined

  const handle = optionalString(value, 'handle')
  if (handle === null) return undefined

  return {
    name: value.name,
    ...(handle !== undefined ? { handle } : {}),
  }
}

function decodeMedia(value: unknown): MediaRef | undefined {
  if (
    !isRecord(value) ||
    !mediaKinds.has(value.kind as MediaRef['kind']) ||
    typeof value.url !== 'string'
  ) {
    return undefined
  }

  const alt = optionalString(value, 'alt')
  if (alt === null) return undefined

  return {
    kind: value.kind as MediaRef['kind'],
    url: value.url,
    ...(alt !== undefined ? { alt } : {}),
  }
}

function decodePost(value: unknown): Post | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.text !== 'string')
    return undefined
  const depth = value.depth
  if (!isNonNegativeSafeInteger(depth) || typeof value.byOp !== 'boolean') return undefined

  const author = decodeAuthor(value.author)
  const createdAt = optionalString(value, 'createdAt')
  const score = optionalFiniteNumber(value, 'score')
  const parentId = optionalString(value, 'parentId')
  const hasMedia = Object.hasOwn(value, 'media')
  const mediaValue = value.media
  const hasLinks = Object.hasOwn(value, 'links')
  const linksValue = value.links
  if (!author || createdAt === null || score === null || parentId === null) return undefined

  const media = hasMedia ? decodeArray(mediaValue, decodeMedia) : undefined
  if (hasMedia && media === undefined) return undefined

  const links = !hasLinks
    ? undefined
    : Array.isArray(linksValue) && linksValue.every((item) => typeof item === 'string')
      ? [...linksValue]
      : undefined
  if (hasLinks && links === undefined) return undefined

  return {
    id: value.id,
    author,
    depth,
    text: value.text,
    byOp: value.byOp,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(score !== undefined ? { score } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    ...(media !== undefined ? { media } : {}),
    ...(links !== undefined ? { links } : {}),
  }
}

function decodeThread(value: unknown): Thread | undefined {
  if (!isRecord(value) || !isThreadSiteId(value.site)) return undefined
  if (
    typeof value.url !== 'string' ||
    value.url.trim() === '' ||
    typeof value.title !== 'string' ||
    !Array.isArray(value.posts)
  ) {
    return undefined
  }

  const author = decodeAuthor(value.author)
  const createdAt = optionalString(value, 'createdAt')
  const truncated = optionalBoolean(value, 'truncated')
  const hasStats = Object.hasOwn(value, 'stats')
  const statsValue = value.stats
  const posts = decodeArray(value.posts, decodePost)
  if (!author || createdAt === null || truncated === null || !posts) return undefined

  let stats: Thread['stats']
  if (hasStats) {
    if (!isRecord(statsValue)) return undefined
    const score = optionalFiniteNumber(statsValue, 'score')
    const replyCount = optionalNonNegativeSafeInteger(statsValue, 'replyCount')
    if (score === null || replyCount === null) return undefined
    stats = {
      ...(score !== undefined ? { score } : {}),
      ...(replyCount !== undefined ? { replyCount } : {}),
    }
  }

  return {
    site: value.site,
    url: value.url,
    title: value.title,
    author,
    posts,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(stats !== undefined ? { stats } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
  }
}

function decodeVideoEntry(value: unknown): VideoEntry | undefined {
  if (
    !isRecord(value) ||
    typeof value.videoId !== 'string' ||
    value.videoId.trim() === '' ||
    typeof value.url !== 'string' ||
    typeof value.title !== 'string' ||
    !isPositiveSafeInteger(value.index)
  ) {
    return undefined
  }

  const channel = optionalString(value, 'channel')
  const durationSeconds = optionalFiniteNumber(value, 'durationSeconds')
  const hasCaptions = optionalBoolean(value, 'hasCaptions')
  if (channel === null || durationSeconds === null || hasCaptions === null) return undefined

  return {
    videoId: value.videoId,
    url: value.url,
    title: value.title,
    index: value.index,
    ...(channel !== undefined ? { channel } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(hasCaptions !== undefined ? { hasCaptions } : {}),
  }
}

function decodeTranscriptDocument(value: unknown): TranscriptDocument | undefined {
  if (
    !isRecord(value) ||
    typeof value.videoId !== 'string' ||
    value.videoId.trim() === '' ||
    typeof value.url !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.markdown !== 'string'
  ) {
    return undefined
  }

  return {
    videoId: value.videoId,
    url: value.url,
    title: value.title,
    markdown: value.markdown,
  }
}

function decodePlaylist(value: unknown): Playlist | undefined {
  if (
    !isRecord(value) ||
    typeof value.playlistId !== 'string' ||
    value.playlistId.trim() === '' ||
    typeof value.url !== 'string' ||
    typeof value.title !== 'string' ||
    !isNonNegativeSafeInteger(value.videoCount) ||
    !Array.isArray(value.videos)
  ) {
    return undefined
  }

  const channel = optionalString(value, 'channel')
  const truncated = optionalBoolean(value, 'truncated')
  const videos = decodeArray(value.videos, decodeVideoEntry)
  const hasTranscriptDocs = Object.hasOwn(value, 'transcriptDocs')
  const transcriptDocsValue = value.transcriptDocs
  const transcriptDocs = !hasTranscriptDocs
    ? undefined
    : decodeArray(transcriptDocsValue, decodeTranscriptDocument)
  if (
    channel === null ||
    truncated === null ||
    !videos ||
    (hasTranscriptDocs && transcriptDocs === undefined)
  ) {
    return undefined
  }

  return {
    playlistId: value.playlistId,
    url: value.url,
    title: value.title,
    videoCount: value.videoCount,
    videos,
    ...(channel !== undefined ? { channel } : {}),
    ...(transcriptDocs !== undefined ? { transcriptDocs } : {}),
    ...(truncated !== undefined ? { truncated } : {}),
  }
}

function decodeVideo(value: unknown): Video | undefined {
  if (
    !isRecord(value) ||
    typeof value.videoId !== 'string' ||
    value.videoId.trim() === '' ||
    typeof value.url !== 'string' ||
    typeof value.title !== 'string'
  ) {
    return undefined
  }

  const channel = optionalString(value, 'channel')
  const durationSeconds = optionalFiniteNumber(value, 'durationSeconds')
  if (channel === null || durationSeconds === null) return undefined

  return {
    videoId: value.videoId,
    url: value.url,
    title: value.title,
    ...(channel !== undefined ? { channel } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  }
}

function decodeWebCapture(value: unknown): WebCapture | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.trim() === '' ||
    typeof value.url !== 'string' ||
    typeof value.title !== 'string' ||
    (value.mode !== 'selection' && value.mode !== 'page' && value.mode !== 'link') ||
    typeof value.text !== 'string'
  ) {
    return undefined
  }

  return {
    id: value.id,
    url: value.url,
    title: value.title,
    mode: value.mode,
    text: value.text,
  }
}

export function decodeCapture(value: unknown): Capture | undefined {
  if (!isRecord(value)) return undefined

  if (value.kind === 'thread') {
    const thread = decodeThread(value.thread)
    return thread ? { kind: 'thread', thread } : undefined
  }

  if (value.kind === 'playlist') {
    const playlist = decodePlaylist(value.playlist)
    return playlist ? { kind: 'playlist', playlist } : undefined
  }

  if (value.kind === 'video') {
    const video = decodeVideo(value.video)
    return video ? { kind: 'video', video } : undefined
  }

  if (value.kind === 'web') {
    const web = decodeWebCapture(value.web)
    return web ? { kind: 'web', web } : undefined
  }

  return undefined
}

function requiredString(record: UnknownRecord, key: string): string | undefined {
  return Object.hasOwn(record, key) && typeof record[key] === 'string' ? record[key] : undefined
}

function requiredNonBlankString(record: UnknownRecord, key: string): string | undefined {
  const value = requiredString(record, key)
  return value !== undefined && value.trim() !== '' ? value : undefined
}

function requiredIsoTimestamp(record: UnknownRecord, key: string): string | undefined {
  const value = requiredNonBlankString(record, key)
  if (value === undefined) return undefined
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value
    : undefined
}

function nativeIdForSite(id: string, site: string): string | undefined {
  const prefix = `${site}:`
  if (!id.startsWith(prefix)) return undefined
  const nativeId = id.slice(prefix.length)
  return nativeId.trim() !== '' ? nativeId : undefined
}

function nativeIdFromCanonicalYoutubeUrl(
  url: string,
  pathname: '/watch' | '/playlist',
  queryKey: 'v' | 'list',
): string | undefined {
  try {
    const parsed = new URL(url)
    const nativeId = parsed.searchParams.get(queryKey)
    if (!nativeId || nativeId.trim() === '') return undefined
    const canonical = new URL(`https://www.youtube.com${pathname}`)
    canonical.searchParams.set(queryKey, nativeId)
    return canonical.toString() === url ? nativeId : undefined
  } catch {
    return undefined
  }
}

function playlistIdFromCanonicalYoutubeUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    const playlistId = parsed.searchParams.get('list')
    if (!playlistId || playlistId.trim() === '') return undefined

    if (parsed.pathname === '/playlist') {
      const canonical = new URL('https://www.youtube.com/playlist')
      canonical.searchParams.set('list', playlistId)
      return canonical.toString() === url ? playlistId : undefined
    }

    const videoId = parsed.searchParams.get('v')
    if (parsed.pathname !== '/watch' || !videoId || videoId.trim() === '') return undefined
    const canonical = new URL('https://www.youtube.com/watch')
    canonical.searchParams.set('v', videoId)
    canonical.searchParams.set('list', playlistId)
    return canonical.toString() === url ? playlistId : undefined
  } catch {
    return undefined
  }
}

function decodeSourceDocBase(value: unknown): Omit<SourceDocBase, 'kind' | 'site'> | undefined {
  if (!isRecord(value)) return undefined

  const id = requiredNonBlankString(value, 'id')
  const title = requiredString(value, 'title')
  const canonicalUrl = requiredNonBlankString(value, 'canonicalUrl')
  const capturedAt = requiredIsoTimestamp(value, 'capturedAt')
  const markdown = requiredString(value, 'markdown')
  const wordCount = value.wordCount
  const truncated = value.truncated
  const jsonl = optionalString(value, 'jsonl')
  if (
    id === undefined ||
    title === undefined ||
    canonicalUrl === undefined ||
    capturedAt === undefined ||
    markdown === undefined ||
    !isNonNegativeSafeInteger(wordCount) ||
    typeof truncated !== 'boolean' ||
    jsonl === null
  ) {
    return undefined
  }

  return {
    id,
    title,
    canonicalUrl,
    capturedAt,
    markdown,
    wordCount,
    truncated,
    ...(jsonl !== undefined ? { jsonl } : {}),
  }
}

function decodeSourceDocFromRecord(
  value: unknown,
  allowLegacyPlaylist: boolean,
): SourceDoc | undefined {
  if (!isRecord(value) || !Object.hasOwn(value, 'kind') || !Object.hasOwn(value, 'site'))
    return undefined
  const base = decodeSourceDocBase(value)
  if (!base || !isSiteId(value.site)) return undefined
  const nativeId = nativeIdForSite(base.id, value.site)
  if (nativeId === undefined) return undefined

  if (value.kind === 'playlist') {
    if (value.site !== 'youtube') return undefined
    if (playlistIdFromCanonicalYoutubeUrl(base.canonicalUrl) !== nativeId) {
      return undefined
    }
    const hasPlaylistVideos = Object.hasOwn(value, 'playlistVideos')
    const playlistVideos = hasPlaylistVideos
      ? decodeArray(value.playlistVideos, decodeVideoEntry)
      : undefined
    const hasVideoDocs = Object.hasOwn(value, 'videoDocs')
    const videoDocs = hasVideoDocs
      ? decodeArray(value.videoDocs, decodeTranscriptDocument)
      : undefined
    if (
      (hasPlaylistVideos && playlistVideos === undefined) ||
      (hasVideoDocs && videoDocs === undefined)
    ) {
      return undefined
    }

    if (playlistVideos !== undefined) {
      return {
        ...base,
        site: 'youtube',
        kind: 'playlist',
        playlistVideos,
        ...(videoDocs !== undefined ? { videoDocs } : {}),
      }
    }

    if (!allowLegacyPlaylist || base.jsonl === undefined) return undefined
    const legacyVideos: VideoEntry[] = []
    for (const row of base.jsonl.split('\n')) {
      if (row.trim().length === 0) continue
      try {
        const video = decodeVideoEntry(JSON.parse(row) as unknown)
        if (!video) return undefined
        legacyVideos.push(video)
      } catch {
        return undefined
      }
    }
    return {
      ...base,
      site: 'youtube',
      kind: 'playlist',
      playlistVideos: legacyVideos,
      ...(videoDocs !== undefined ? { videoDocs } : {}),
    }
  }

  if (value.kind !== 'thread' && value.kind !== 'video' && value.kind !== 'web') return undefined
  if (Object.hasOwn(value, 'playlistVideos') || Object.hasOwn(value, 'videoDocs')) return undefined
  if (value.kind === 'video' && value.site !== 'youtube') return undefined
  if (value.kind === 'web' && value.site !== 'web') return undefined

  if (value.kind === 'thread') {
    return isThreadSiteId(value.site) ? { ...base, site: value.site, kind: 'thread' } : undefined
  }
  if (value.kind === 'video') {
    return nativeIdFromCanonicalYoutubeUrl(base.canonicalUrl, '/watch', 'v') === nativeId
      ? { ...base, site: 'youtube', kind: 'video' }
      : undefined
  }
  return { ...base, site: 'web', kind: 'web' }
}

/** Decodes one canonical stored document; legacy playlists require the batch decoder. */
export function decodeSourceDoc(value: unknown): SourceDoc | undefined {
  return decodeSourceDocFromRecord(value, false)
}

/**
 * Validates the storage boundary. Bad rows do not poison valid siblings.
 * Legacy playlists migrate only from complete VideoEntry JSONL rows.
 */
export function decodeStoredSourceDocs(value: unknown): SourceDoc[] | undefined {
  if (!Array.isArray(value)) return undefined
  const byId = new Map<string, SourceDoc>()
  for (const item of value) {
    const doc = decodeSourceDocFromRecord(item, true)
    if (doc === undefined) continue
    const existing = byId.get(doc.id)
    if (existing === undefined || doc.capturedAt > existing.capturedAt) byId.set(doc.id, doc)
  }
  return [...byId.values()].toSorted((a, b) => b.capturedAt.localeCompare(a.capturedAt))
}
