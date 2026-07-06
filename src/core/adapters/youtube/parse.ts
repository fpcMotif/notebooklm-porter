import type { Playlist, VideoEntry } from '../../model/types'

/**
 * YouTube A/B-serves multiple playlist-row shapes (confirmed live 2026-07-06):
 * `lockupViewModel` under `sectionListRenderer` on `/playlist?list=` pages,
 * `playlistPanelVideoRenderer` under `twoColumnWatchNextResults.playlist.playlist`
 * on `/watch?...&list=` pages, plus the older documented `playlistVideoRenderer`
 * (`playlistVideoListRenderer`/`richGridRenderer` wrappers) that no live probe has
 * reproduced but which YouTube's own scraping docs still describe. Rather than
 * chase fixed wrapper paths, the page is walked as a bounded recursive scan that
 * collects every row/continuation node in document order, regardless of what
 * wraps it.
 */

const MAX_SCAN_DEPTH = 25

interface TextRun {
  text: string
}

interface RunsText {
  runs?: TextRun[]
  simpleText?: string
}

interface LockupTitle {
  content?: string
}

interface ThumbnailBadge {
  thumbnailBadgeViewModel?: { text?: string }
}

interface ThumbnailOverlay {
  thumbnailBottomOverlayViewModel?: { badges?: ThumbnailBadge[] }
}

interface WatchEndpoint {
  videoId?: string
  index?: number
}

interface LockupViewModel {
  contentId?: string
  contentType?: string
  contentImage?: {
    thumbnailViewModel?: { overlays?: ThumbnailOverlay[] }
  }
  metadata?: {
    lockupMetadataViewModel?: {
      title?: LockupTitle
      metadata?: {
        contentMetadataViewModel?: {
          metadataRows?: { metadataParts?: { text?: { content?: string } }[] }[]
        }
      }
    }
  }
  rendererContext?: {
    commandContext?: {
      onTap?: { innertubeCommand?: { watchEndpoint?: WatchEndpoint } }
    }
  }
}

interface PlaylistVideoRenderer {
  videoId?: string
  title?: RunsText
  shortBylineText?: RunsText
  lengthSeconds?: string
  index?: RunsText | { simpleText?: string }
  navigationEndpoint?: { watchEndpoint?: WatchEndpoint }
}

interface PlaylistPanelVideoRenderer {
  videoId?: string
  title?: RunsText
  lengthText?: RunsText
  longBylineText?: RunsText
  shortBylineText?: RunsText
  navigationEndpoint?: { watchEndpoint?: WatchEndpoint }
}

/** Narrows an `unknown` JSON value to a plain object, or returns undefined. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

/**
 * Finds the `{` that opens a JSON object at `startIndex` and walks forward to
 * its matching `}`, tracking string/escape state so a literal `};` inside a
 * field value (e.g. a video title) can't be mistaken for the object's end.
 */
function findMatchingBrace(html: string, startIndex: number): number | undefined {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = startIndex; i < html.length; i++) {
    const char = html[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth++
    } else if (char === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return undefined
}

/** Regex-extracts the inline `ytInitialData` JSON blob from a playlist/watch page. */
export function extractYtInitialData(html: string): unknown {
  const assignMatch = html.match(/(?:window\["ytInitialData"\]|ytInitialData)\s*=\s*{/)
  if (!assignMatch || assignMatch.index === undefined) {
    throw new Error('extractYtInitialData: ytInitialData not found in page HTML')
  }
  const openBraceIndex = assignMatch.index + assignMatch[0].length - 1
  const closeBraceIndex = findMatchingBrace(html, openBraceIndex)
  if (closeBraceIndex === undefined) {
    throw new Error('extractYtInitialData: ytInitialData not found in page HTML')
  }
  const blob = html.slice(openBraceIndex, closeBraceIndex + 1)
  try {
    return JSON.parse(blob)
  } catch (err) {
    throw new Error('extractYtInitialData: failed to parse ytInitialData JSON', { cause: err })
  }
}

/** Regex-extracts the InnerTube API key + context object needed for browse continuations. */
export function extractInnertube(html: string): { apiKey: string; context: unknown } {
  const keyMatch = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)
  if (!keyMatch?.[1]) {
    throw new Error('extractInnertube: INNERTUBE_API_KEY not found in page HTML')
  }
  const ctxMatch = html.match(/"INNERTUBE_CONTEXT":(\{.+?\}),"INNERTUBE_CONTEXT_CLIENT_NAME"/)
  if (!ctxMatch?.[1]) {
    throw new Error('extractInnertube: INNERTUBE_CONTEXT not found in page HTML')
  }
  let context: unknown
  try {
    context = JSON.parse(ctxMatch[1])
  } catch (err) {
    throw new Error('extractInnertube: failed to parse INNERTUBE_CONTEXT JSON', { cause: err })
  }
  return { apiKey: keyMatch[1], context }
}

/** Reads the duration badge ("1:16:28") off a lockup's thumbnail overlay, if present. */
function readLockupDurationText(lockup: LockupViewModel): string | undefined {
  const overlays = lockup.contentImage?.thumbnailViewModel?.overlays ?? []
  for (const overlay of overlays) {
    const text = overlay.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel?.text
    if (text) return text
  }
  return undefined
}

/** Parses a duration badge like "1:16:28" or "3:07" into seconds. */
function parseDurationText(text: string): number | undefined {
  const parts = text.split(':').map((p) => Number(p))
  if (parts.some((n) => !Number.isFinite(n))) return undefined
  let seconds = 0
  for (const part of parts) {
    seconds = seconds * 60 + part
  }
  return seconds
}

/** Reads the channel name off a lockup's first metadata row (uploader byline). */
function readLockupChannelText(lockup: LockupViewModel): string | undefined {
  const rows =
    lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows
  const firstPart = rows?.[0]?.metadataParts?.[0]?.text?.content
  return firstPart || undefined
}

function readRunsText(field: RunsText | undefined): string | undefined {
  return field?.runs?.[0]?.text ?? field?.simpleText
}

/** Converts one `lockupViewModel` playlist row into a VideoEntry, given its 0-based position fallback. */
function lockupToVideoEntry(
  lockup: LockupViewModel,
  fallbackIndex: number,
): VideoEntry | undefined {
  const watchEndpoint =
    lockup.rendererContext?.commandContext?.onTap?.innertubeCommand?.watchEndpoint
  const videoId = lockup.contentId ?? watchEndpoint?.videoId
  if (!videoId) return undefined

  const title = lockup.metadata?.lockupMetadataViewModel?.title?.content ?? '(untitled video)'
  const channel = readLockupChannelText(lockup)
  const durationText = readLockupDurationText(lockup)
  const durationSeconds = durationText ? parseDurationText(durationText) : undefined
  const index =
    typeof watchEndpoint?.index === 'number' ? watchEndpoint.index + 1 : fallbackIndex + 1

  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    index,
    ...(channel !== undefined ? { channel } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  }
}

/** Converts one legacy `playlistVideoRenderer` row into a VideoEntry, given its 0-based position fallback. */
function playlistVideoRendererToVideoEntry(
  renderer: PlaylistVideoRenderer,
  fallbackIndex: number,
): VideoEntry | undefined {
  const videoId = renderer.videoId ?? renderer.navigationEndpoint?.watchEndpoint?.videoId
  if (!videoId) return undefined

  const title = readRunsText(renderer.title) ?? '(untitled video)'
  const channel = readRunsText(renderer.shortBylineText)
  const durationSeconds = renderer.lengthSeconds ? Number(renderer.lengthSeconds) : undefined
  const endpointIndex = renderer.navigationEndpoint?.watchEndpoint?.index
  const textIndex = readRunsText(renderer.index as RunsText | undefined)
  const parsedTextIndex = textIndex ? Number(textIndex) : undefined
  const index =
    typeof endpointIndex === 'number'
      ? endpointIndex + 1
      : Number.isFinite(parsedTextIndex)
        ? (parsedTextIndex as number)
        : fallbackIndex + 1

  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    index,
    ...(channel !== undefined ? { channel } : {}),
    ...(durationSeconds !== undefined && Number.isFinite(durationSeconds)
      ? { durationSeconds }
      : {}),
  }
}

/** Converts one watch-page `playlistPanelVideoRenderer` row into a VideoEntry, given its 0-based position fallback. */
function playlistPanelVideoRendererToVideoEntry(
  renderer: PlaylistPanelVideoRenderer,
  fallbackIndex: number,
): VideoEntry | undefined {
  const watchEndpoint = renderer.navigationEndpoint?.watchEndpoint
  const videoId = renderer.videoId ?? watchEndpoint?.videoId
  if (!videoId) return undefined

  const title = readRunsText(renderer.title) ?? '(untitled video)'
  const channel = readRunsText(renderer.longBylineText) ?? readRunsText(renderer.shortBylineText)
  const durationText = readRunsText(renderer.lengthText)
  const durationSeconds = durationText ? parseDurationText(durationText) : undefined
  const index =
    typeof watchEndpoint?.index === 'number' ? watchEndpoint.index + 1 : fallbackIndex + 1

  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    index,
    ...(channel !== undefined ? { channel } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  }
}

/** True when a `lockupViewModel` node's `contentType` marks it as a video row (vs. a playlist/channel lockup). */
function isVideoLockup(lockup: LockupViewModel): boolean {
  return lockup.contentType === undefined || lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO'
}

interface ScanResult {
  videos: VideoEntry[]
  continuation?: string
}

/**
 * Bounded recursive scan of the `ytInitialData` tree: collects every row node
 * (`playlistVideoRenderer`, video-typed `lockupViewModel`, `playlistPanelVideoRenderer`,
 * each optionally wrapped in `richItemRenderer`) plus every continuation token
 * (`continuationItemRenderer` / `continuationItemViewModel`), in document order.
 * Depth-capped so a pathological/cyclic-looking structure can't hang the walk.
 */
function scanForRows(node: unknown, depth: number, result: ScanResult): void {
  if (depth > MAX_SCAN_DEPTH) return

  const arr = asArray(node)
  if (arr) {
    for (const item of arr) scanForRows(item, depth + 1, result)
    return
  }

  const obj = asObject(node)
  if (!obj) return

  const richItem = asObject(obj.richItemRenderer)
  if (richItem) {
    scanForRows(richItem.content, depth + 1, result)
  }

  const legacyRenderer = asObject(obj.playlistVideoRenderer) as PlaylistVideoRenderer | undefined
  if (legacyRenderer) {
    const entry = playlistVideoRendererToVideoEntry(legacyRenderer, result.videos.length)
    if (entry) result.videos.push(entry)
  }

  const panelRenderer = asObject(obj.playlistPanelVideoRenderer) as
    | PlaylistPanelVideoRenderer
    | undefined
  if (panelRenderer) {
    const entry = playlistPanelVideoRendererToVideoEntry(panelRenderer, result.videos.length)
    if (entry) result.videos.push(entry)
  }

  const lockup = asObject(obj.lockupViewModel) as LockupViewModel | undefined
  if (lockup && isVideoLockup(lockup)) {
    const entry = lockupToVideoEntry(lockup, result.videos.length)
    if (entry) result.videos.push(entry)
  }

  const legacyContinuation = asObject(obj.continuationItemRenderer)
  if (legacyContinuation) {
    const token = asObject(
      asObject(legacyContinuation.continuationEndpoint)?.continuationCommand,
    )?.token
    if (typeof token === 'string' && token) result.continuation = token
  }

  const vmContinuation = asObject(obj.continuationItemViewModel)
  if (vmContinuation) {
    const token = asObject(
      asObject(asObject(vmContinuation.continuationCommand)?.innertubeCommand)?.continuationCommand,
    )?.token
    if (typeof token === 'string' && token) result.continuation = token
  }

  // Recurse into every remaining field — rows can be wrapped arbitrarily
  // deeply (itemSectionRenderer, richGridRenderer, tab/content wrappers).
  for (const [key, value] of Object.entries(obj)) {
    if (
      key === 'richItemRenderer' ||
      key === 'playlistVideoRenderer' ||
      key === 'playlistPanelVideoRenderer' ||
      key === 'lockupViewModel'
    ) {
      continue
    }
    if (typeof value === 'object' && value !== null) {
      scanForRows(value, depth + 1, result)
    }
  }
}

function scanTree(node: unknown): ScanResult {
  const result: ScanResult = { videos: [] }
  scanForRows(node, 0, result)
  return result
}

/** Extracts "84" from a sidebar stats run like `[{text:"84"},{text:" episodes"}]` or a simpleText fallback. */
function readVideoCountFromStats(stats: unknown): number | undefined {
  const arr = asArray(stats)
  if (!arr) return undefined
  for (const raw of arr) {
    const stat = asObject(raw) as RunsText | undefined
    if (!stat) continue
    const text = stat.runs?.[0]?.text ?? stat.simpleText
    if (!text) continue
    const digits = text.replace(/[^\d]/g, '')
    if (digits) {
      const n = Number(digits)
      if (Number.isFinite(n)) return n
    }
  }
  return undefined
}

interface PlaylistHeaderInfo {
  title?: string
  channel?: string
  videoCount?: number
}

/** Best-effort read of playlist title/channel/count from `header` + `sidebar` — several layout variants exist. */
function readPlaylistHeaderInfo(data: unknown): PlaylistHeaderInfo {
  const root = asObject(data)
  if (!root) return {}

  const info: PlaylistHeaderInfo = {}

  const headerObj = asObject(root.header)
  const pageHeaderTitle = asObject(headerObj?.pageHeaderRenderer)?.pageTitle
  if (typeof pageHeaderTitle === 'string' && pageHeaderTitle) info.title = pageHeaderTitle

  const playlistHeaderRenderer = asObject(headerObj?.playlistHeaderRenderer)
  if (playlistHeaderRenderer) {
    if (!info.title) {
      const t = readRunsText(playlistHeaderRenderer.title as RunsText | undefined)
      if (t) info.title = t
    }
    const ownerText = readRunsText(playlistHeaderRenderer.ownerText as RunsText | undefined)
    if (ownerText) info.channel = ownerText
    const count = readVideoCountFromStats(playlistHeaderRenderer.stats)
    if (count !== undefined) info.videoCount = count
  }

  const sidebarItems = asArray(asObject(asObject(root.sidebar)?.playlistSidebarRenderer)?.items)
  for (const raw of sidebarItems ?? []) {
    const item = asObject(raw)
    if (!item) continue

    const primary = asObject(item.playlistSidebarPrimaryInfoRenderer)
    if (primary) {
      if (!info.title) {
        const runsTitle = asObject(primary.title) as RunsText | undefined
        const t = runsTitle?.runs?.[0]?.text
        if (t) info.title = t
      }
      const count = readVideoCountFromStats(primary.stats)
      if (count !== undefined) info.videoCount = count
    }

    const secondary = asObject(item.playlistSidebarSecondaryInfoRenderer)
    if (secondary) {
      const owner = asObject(asObject(secondary.videoOwner)?.videoOwnerRenderer)
      const runsTitle = asObject(owner?.title) as RunsText | undefined
      const channel = runsTitle?.runs?.[0]?.text
      if (channel) info.channel = channel
    }
  }

  // Watch-page shape: title/owner/count live on twoColumnWatchNextResults.playlist.playlist.
  const watchPlaylist = asObject(
    asObject(asObject(root.contents)?.twoColumnWatchNextResults)?.playlist,
  )
  const watchPlaylistInner = asObject(watchPlaylist?.playlist)
  if (watchPlaylistInner) {
    if (!info.title && typeof watchPlaylistInner.title === 'string') {
      info.title = watchPlaylistInner.title
    }
    if (!info.channel) {
      const ownerName = readRunsText(watchPlaylistInner.ownerName as RunsText | undefined)
      if (ownerName) info.channel = ownerName
    }
    if (info.videoCount === undefined && typeof watchPlaylistInner.totalVideos === 'number') {
      info.videoCount = watchPlaylistInner.totalVideos
    }
  }

  return info
}

/**
 * Parses a playlist page's `ytInitialData` into a `Playlist` (first page,
 * up to ~100 videos) plus an optional continuation token for the rest.
 * Tolerant of any live row shape (see module doc): once at least one video is
 * found, missing header fields fall back to sensible defaults rather than
 * throwing. If the scan finds zero rows, the error lists the top-level
 * `ytInitialData` keys to help diagnose a future shape drift.
 */
export function parsePlaylistPage(
  data: unknown,
  playlistId: string,
): { playlist: Playlist; continuation?: string } {
  const root = asObject(data)
  if (!root) {
    throw new Error('parsePlaylistPage: expected a JSON object')
  }

  const { videos, continuation } = scanTree(root)
  if (videos.length === 0) {
    throw new Error(
      `parsePlaylistPage: no videos found in playlist page (top-level keys: ${Object.keys(root).join(', ')})`,
    )
  }

  const header = readPlaylistHeaderInfo(root)

  const playlist: Playlist = {
    playlistId,
    url: `https://www.youtube.com/playlist?list=${playlistId}`,
    title: header.title ?? `Playlist ${playlistId}`,
    videoCount: header.videoCount ?? videos.length,
    videos,
    ...(header.channel !== undefined ? { channel: header.channel } : {}),
  }

  return { playlist, ...(continuation !== undefined ? { continuation } : {}) }
}

/**
 * Parses an InnerTube `browse` continuation response (`youtubei/v1/browse`)
 * into the next batch of videos plus an optional further continuation.
 */
export function parseContinuation(data: unknown): { videos: VideoEntry[]; continuation?: string } {
  const root = asObject(data)
  if (!root) return { videos: [] }

  const actions = asArray(root.onResponseReceivedActions) ?? []
  const videos: VideoEntry[] = []
  let continuation: string | undefined

  for (const raw of actions) {
    const action = asObject(raw)
    const appendAction = asObject(action?.appendContinuationItemsAction)
    const items = asArray(appendAction?.continuationItems)
    if (!items) continue

    const result = scanTree(items)
    videos.push(...result.videos)
    if (result.continuation) continuation = result.continuation
  }

  return { videos, ...(continuation !== undefined ? { continuation } : {}) }
}
