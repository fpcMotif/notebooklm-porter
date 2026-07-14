/**
 * Pure duplicate detection for a notebook's sources. Two sources are the "same"
 * when their normalized URL matches (tracking params stripped, YouTube collapsed
 * to video identity), falling back to a normalized title for URL-less sources.
 *
 * The console auto-removes duplicates, so grouping picks ONE keeper per group
 * (a ready copy beats a broken one, then earliest input order) and marks the
 * rest for deletion. Input order is the stable tiebreak throughout.
 */
import { youtubeVideoIdentity } from '../../adapters/youtube/video'
import type { NotebookSource, SourceLoadStatus } from './model'

/** Query keys dropped before comparing URLs — analytics + share noise. */
const TRACKING_PARAM_PREFIXES = ['utm_'] as const
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'si',
  'ref',
  'ref_src',
  'ref_url',
  'feature',
  'spm',
  'yclid',
  '_hsenc',
  '_hsmi',
])

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase()
  return (
    TRACKING_PARAMS.has(lower) || TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix))
  )
}

/**
 * Canonical comparison key for a source URL. YouTube URLs collapse to
 * `youtube:${videoId}` (so playlist/short/watch forms of one video match);
 * every other URL becomes `host/path?sortedNonTrackingParams` with `www.`,
 * fragment, and trailing slash removed. A non-URL string falls back to its
 * trimmed lowercase form.
 */
export function normalizeSourceUrl(raw: string): string {
  const youtube = youtubeVideoIdentity(raw)
  if (youtube !== undefined) return `youtube:${youtube.videoId}`

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return raw.trim().toLowerCase()
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const params: { key: string; value: string }[] = []
  for (const [key, value] of parsed.searchParams) {
    if (!isTrackingParam(key)) params.push({ key, value })
  }
  params.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.value < b.value ? -1 : 1))
  const query = params.map(({ key, value }) => `${key}=${value}`).join('&')
  const path = parsed.pathname.replace(/\/+$/, '') || '/'
  return `${host}${path}${query !== '' ? `?${query}` : ''}`
}

/** Dedup key: the normalized URL when present, else the normalized title. */
export function sourceDedupeKey(source: NotebookSource): string {
  if (source.url !== undefined && source.url.trim() !== '') {
    return `url:${normalizeSourceUrl(source.url)}`
  }
  return `title:${source.title.trim().toLowerCase()}`
}

/** Keeper preference — a usable copy is kept over a broken/incomplete one. */
const STATUS_KEEP_RANK: Readonly<Record<SourceLoadStatus, number>> = {
  ready: 0,
  processing: 1,
  preparing: 2,
  unknown: 3,
  error: 4,
}

export interface DuplicateGroup {
  /** The shared dedupe key. */
  key: string
  /** The copy the console keeps (best status, then earliest input order). */
  keep: NotebookSource
  /** The redundant copies the console removes. */
  remove: NotebookSource[]
}

/**
 * Groups sources by dedupe key; every key with more than one source yields a
 * `DuplicateGroup` whose keeper has the best load status (earliest input order
 * breaking ties) and whose `remove` list is the rest. Groups are returned in
 * first-appearance order for stable, reviewable output.
 */
export function findDuplicateGroups(sources: readonly NotebookSource[]): DuplicateGroup[] {
  const buckets = new Map<string, NotebookSource[]>()
  const firstSeen = new Map<string, number>()
  sources.forEach((source, index) => {
    const key = sourceDedupeKey(source)
    const bucket = buckets.get(key)
    if (bucket === undefined) {
      buckets.set(key, [source])
      firstSeen.set(key, index)
    } else {
      bucket.push(source)
    }
  })

  const groups: DuplicateGroup[] = []
  for (const [key, bucket] of buckets) {
    if (bucket.length < 2) continue
    const keep = pickKeeper(bucket)
    const remove = bucket.filter((source) => source !== keep)
    groups.push({ key, keep, remove })
  }
  groups.sort((a, b) => (firstSeen.get(a.key) ?? 0) - (firstSeen.get(b.key) ?? 0))
  return groups
}

/** The best copy to keep. `reduce` with no seed is safe — callers pass ≥1 source. */
function pickKeeper(bucket: readonly NotebookSource[]): NotebookSource {
  return bucket.reduce((best, candidate) =>
    STATUS_KEEP_RANK[candidate.status] < STATUS_KEEP_RANK[best.status] ? candidate : best,
  )
}

/** Every source id the console would delete, flattened across all groups. */
export function duplicateRemovalIds(groups: readonly DuplicateGroup[]): string[] {
  return groups.flatMap((group) => group.remove.map((source) => source.id))
}
