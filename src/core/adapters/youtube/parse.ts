import type { Playlist, VideoEntry } from '../../model/types'

/**
 * YouTube's current (2026) playlist page renders each row as a
 * `lockupViewModel` inside `itemSectionRenderer.contents[]` — the older
 * `playlistVideoRenderer`/`playlistVideoListRenderer` shape documented in
 * older scraping writeups no longer appears on the live page (confirmed by
 * curling a real playlist; see parse.test.ts fixtureNote). Types below are
 * narrowed just enough to walk that shape; every field read is guarded.
 */

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

interface ContinuationItemViewModel {
  continuationCommand?: {
    innertubeCommand?: { continuationCommand?: { token?: string } }
  }
}

type SectionItem =
  | { lockupViewModel: LockupViewModel }
  | { continuationItemViewModel: ContinuationItemViewModel }
  | Record<string, unknown>

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
function readDurationText(lockup: LockupViewModel): string | undefined {
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
function readChannelText(lockup: LockupViewModel): string | undefined {
  const rows =
    lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows
  const firstPart = rows?.[0]?.metadataParts?.[0]?.text?.content
  return firstPart || undefined
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
  const channel = readChannelText(lockup)
  const durationText = readDurationText(lockup)
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

/** Reads the continuation token off a `continuationItemViewModel` section entry, if present. */
function readContinuationToken(item: ContinuationItemViewModel): string | undefined {
  return item.continuationCommand?.innertubeCommand?.continuationCommand?.token
}

/** Walks `sectionListRenderer.contents[]`-shaped items into videos + an optional continuation token. */
function walkSectionItems(items: unknown[]): { videos: VideoEntry[]; continuation?: string } {
  const videos: VideoEntry[] = []
  let continuation: string | undefined

  for (const raw of items) {
    const item = asObject(raw) as SectionItem | undefined
    if (!item) continue

    const isr = asObject((item as { itemSectionRenderer?: unknown }).itemSectionRenderer)
    if (isr) {
      const nested = asArray(isr.contents) ?? []
      const result = walkSectionItems(nested)
      videos.push(...result.videos)
      if (result.continuation) continuation = result.continuation
      continue
    }

    const lockup = asObject((item as { lockupViewModel?: unknown }).lockupViewModel) as
      | LockupViewModel
      | undefined
    if (lockup) {
      const entry = lockupToVideoEntry(lockup, videos.length)
      if (entry) videos.push(entry)
      continue
    }

    const contItem = asObject(
      (item as { continuationItemViewModel?: unknown }).continuationItemViewModel,
    ) as ContinuationItemViewModel | undefined
    if (contItem) {
      const token = readContinuationToken(contItem)
      if (token) continuation = token
    }
  }

  return { videos, ...(continuation !== undefined ? { continuation } : {}) }
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

  const pageHeaderTitle = asObject(asObject(root.header)?.pageHeaderRenderer)?.pageTitle
  if (typeof pageHeaderTitle === 'string' && pageHeaderTitle) info.title = pageHeaderTitle

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

  return info
}

/**
 * Parses a playlist page's `ytInitialData` into a `Playlist` (first page,
 * up to ~100 videos) plus an optional continuation token for the rest.
 * Defensive by design: once at least one video is found, missing header
 * fields fall back to sensible defaults rather than throwing.
 */
export function parsePlaylistPage(
  data: unknown,
  playlistId: string,
): { playlist: Playlist; continuation?: string } {
  const root = asObject(data)
  if (!root) {
    throw new Error('parsePlaylistPage: expected a JSON object')
  }

  const tabs = asArray(
    asObject(asObject(asObject(root.contents)?.twoColumnBrowseResultsRenderer))?.tabs,
  )
  const tab0 = asObject(tabs?.[0])
  const tabRenderer = asObject(tab0?.tabRenderer)
  const sectionListContents = asArray(
    asObject(asObject(tabRenderer?.content)?.sectionListRenderer)?.contents,
  )

  if (!sectionListContents) {
    throw new Error('parsePlaylistPage: could not find sectionListRenderer.contents')
  }

  const { videos, continuation } = walkSectionItems(sectionListContents)
  if (videos.length === 0) {
    throw new Error('parsePlaylistPage: no videos found in playlist page')
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

    const result = walkSectionItems(items)
    videos.push(...result.videos)
    if (result.continuation) continuation = result.continuation
  }

  return { videos, ...(continuation !== undefined ? { continuation } : {}) }
}
