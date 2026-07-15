/** Pure support for best-effort YouTube transcript enrichment. */

import { frontmatterBlock } from '../../format/frontmatter'

const MAX_SCAN_DEPTH = 30

export interface CaptionTrack {
  url: string
  languageCode?: string
  kind?: string
  label?: string
}

export interface TranscriptCue {
  startMs: number
  durationMs?: number
  text: string
}

export interface TranscriptChapter {
  startMs: number
  title: string
}

export interface TranscriptVideo {
  videoId: string
  url: string
  title: string
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function readText(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const object = asObject(value)
  if (!object) return undefined
  if (typeof object.simpleText === 'string') return object.simpleText
  const runs = Array.isArray(object.runs) ? object.runs : []
  const text = runs
    .map((run) => asObject(run)?.text)
    .filter((part): part is string => typeof part === 'string')
    .join('')
  return text || undefined
}

/** Finds the end of a JSON object while respecting JSON string escapes. */
function findMatchingBrace(html: string, openBraceIndex: number): number | undefined {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = openBraceIndex; index < html.length; index++) {
    const char = html[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) return index
    }
  }
  return undefined
}

/**
 * Extracts the player response embedded in a watch page. Watch-page drift is
 * expected here, so every failure deliberately becomes an absent response.
 */
export function extractYtInitialPlayerResponse(html: string): unknown | undefined {
  const assignment = /(?:window\["ytInitialPlayerResponse"\]|ytInitialPlayerResponse)\s*=\s*{/.exec(
    html,
  )
  if (!assignment || assignment.index === undefined) return undefined

  const openBraceIndex = assignment.index + assignment[0].length - 1
  const closeBraceIndex = findMatchingBrace(html, openBraceIndex)
  if (closeBraceIndex === undefined) return undefined

  try {
    return JSON.parse(html.slice(openBraceIndex, closeBraceIndex + 1))
  } catch {
    return undefined
  }
}

/** Reads all usable caption tracks from a parsed player response. */
export function parseCaptionTracks(playerResponse: unknown): CaptionTrack[] {
  const root = asObject(playerResponse)
  const captions = asObject(root?.captions)
  const tracklist = asObject(captions?.playerCaptionsTracklistRenderer)
  const rawTracks = Array.isArray(tracklist?.captionTracks) ? tracklist.captionTracks : []
  const tracks: CaptionTrack[] = []

  for (const rawTrack of rawTracks) {
    const track = asObject(rawTrack)
    if (!track || typeof track.baseUrl !== 'string' || track.baseUrl === '') continue
    const languageCode = typeof track.languageCode === 'string' ? track.languageCode : undefined
    const kind = typeof track.kind === 'string' ? track.kind : undefined
    const label = readText(track.name)
    tracks.push({
      url: track.baseUrl,
      ...(languageCode !== undefined ? { languageCode } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(label !== undefined ? { label } : {}),
    })
  }
  return tracks
}

function isEnglish(track: CaptionTrack): boolean {
  return (
    track.languageCode?.toLowerCase() === 'en' ||
    track.languageCode?.toLowerCase().startsWith('en-') === true
  )
}

function isAsr(track: CaptionTrack): boolean {
  return track.kind?.toLowerCase() === 'asr'
}

/** Prefers manual English, then English ASR, then the source's first track. */
export function selectCaptionTrack(tracks: CaptionTrack[]): CaptionTrack | undefined {
  return (
    tracks.find((track) => isEnglish(track) && !isAsr(track)) ??
    tracks.find((track) => isEnglish(track) && isAsr(track)) ??
    tracks[0]
  )
}

function cleanCueText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text || undefined
}

/** Parses a json3 response, discarding timing-only and empty caption events. */
export function parseJson3Cues(input: unknown): TranscriptCue[] {
  let root: unknown = input
  if (typeof input === 'string') {
    try {
      root = JSON.parse(input)
    } catch {
      return []
    }
  }
  const rootObject = asObject(root)
  const events = Array.isArray(rootObject?.events) ? rootObject.events : []
  const cues: TranscriptCue[] = []

  for (const rawEvent of events) {
    const event = asObject(rawEvent)
    if (!event) continue
    const startMs = asFiniteNumber(event.tStartMs)
    if (startMs === undefined || startMs < 0) continue
    const segments = Array.isArray(event.segs) ? event.segs : []
    const text = cleanCueText(
      segments
        .map((segment) => asObject(segment)?.utf8)
        .filter((part): part is string => typeof part === 'string')
        .join(''),
    )
    if (!text) continue
    const durationMs = asFiniteNumber(event.dDurationMs)
    cues.push({
      startMs,
      ...(durationMs !== undefined && durationMs >= 0 ? { durationMs } : {}),
      text,
    })
  }
  return cues
}

function readChapter(node: unknown): TranscriptChapter | undefined {
  const renderer = asObject(asObject(node)?.chapterRenderer)
  if (!renderer) return undefined
  const startMs = asFiniteNumber(renderer.timeRangeStartMillis)
  const title = readText(renderer.title)?.trim()
  return startMs !== undefined && startMs >= 0 && title ? { startMs, title } : undefined
}

function findChapterRenderers(
  node: unknown,
  depth: number,
  seen: WeakSet<object>,
  chapters: TranscriptChapter[],
): void {
  if (depth > MAX_SCAN_DEPTH || node === null || typeof node !== 'object') return
  if (seen.has(node)) return
  seen.add(node)

  const chapter = readChapter(node)
  if (chapter) chapters.push(chapter)

  if (Array.isArray(node)) {
    for (const item of node) findChapterRenderers(item, depth + 1, seen, chapters)
    return
  }
  for (const value of Object.values(node)) findChapterRenderers(value, depth + 1, seen, chapters)
}

function autoChaptersFromMarkerBar(value: unknown): TranscriptChapter[] {
  const markerBar = asObject(value)
  const markers = Array.isArray(markerBar?.markersMap) ? markerBar.markersMap : []
  const chapters: TranscriptChapter[] = []
  for (const marker of markers) {
    const entry = asObject(marker)
    if (entry?.key !== 'AUTO_CHAPTERS') continue
    findChapterRenderers(entry.value, 0, new WeakSet(), chapters)
  }
  return chapters
}

/**
 * Extracts automatic chapters from any nested `multiMarkersPlayerBarRenderer`
 * shape. It deliberately only reads AUTO_CHAPTERS marker maps, not arbitrary
 * `chapterRenderer` nodes elsewhere in initial data.
 */
export function parseAutoChapters(initialData: unknown): TranscriptChapter[] {
  const found: TranscriptChapter[] = []
  const seen = new WeakSet<object>()

  function visit(node: unknown, depth: number): void {
    if (depth > MAX_SCAN_DEPTH || node === null || typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'multiMarkersPlayerBarRenderer') {
        found.push(...autoChaptersFromMarkerBar(value))
      }
      visit(value, depth + 1)
    }
  }

  visit(initialData, 0)
  const unique = new Map<string, TranscriptChapter>()
  for (const chapter of found) unique.set(`${chapter.startMs}:${chapter.title}`, chapter)
  return [...unique.values()].toSorted((left, right) => left.startMs - right.startMs)
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Renders a NotebookLM text source. No nonempty captions means no transcript
 * source should replace the video's canonical YouTube URL.
 */
export function renderTranscriptMarkdown(
  video: TranscriptVideo,
  cues: TranscriptCue[],
  chapters: TranscriptChapter[] = [],
): string | undefined {
  if (cues.length === 0) return undefined
  const frontmatter = frontmatterBlock([
    ['source', 'youtube'],
    ['url', video.url],
    ['title', video.title],
    ['video_id', video.videoId],
  ])
  const chapterLines = chapters.map(
    (chapter) => `- ${formatTimestamp(chapter.startMs)} — ${chapter.title}`,
  )
  const transcriptLines = cues.map((cue) => `[${formatTimestamp(cue.startMs)}] ${cue.text}`)
  return [
    ...frontmatter,
    '',
    `# ${video.title}`,
    ...(chapterLines.length > 0 ? ['', '## Chapters', '', ...chapterLines] : []),
    '',
    '## Transcript',
    '',
    ...transcriptLines,
  ].join('\n')
}
