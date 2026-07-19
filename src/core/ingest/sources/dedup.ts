/**
 * Pure duplicate detection for a notebook's sources. Two sources are the "same"
 * only when their URLs resolve to the same validated YouTube video identity.
 * Titles and generic URLs are display-only: they never auto-group or delete.
 *
 * The console auto-removes duplicates, so grouping picks ONE keeper per group
 * (a ready copy beats a broken one, then earliest input order) and marks the
 * rest for deletion. Input order is the stable tiebreak throughout.
 */
import { youtubeVideoIdentity } from '../../adapters/youtube/video'
import type { NotebookSource, SourceLoadStatus } from './model'

/** Dedup key: a validated YouTube video identity, or no key. */
export function sourceDedupeKey(source: NotebookSource): string | undefined {
  if (source.url === undefined) return undefined
  const youtube = youtubeVideoIdentity(source.url)
  return youtube === undefined ? undefined : `youtube:${youtube.videoId}`
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
    if (key === undefined) return
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
export function pickKeeper(bucket: readonly NotebookSource[]): NotebookSource {
  return bucket.reduce((best, candidate) =>
    STATUS_KEEP_RANK[candidate.status] < STATUS_KEEP_RANK[best.status] ? candidate : best,
  )
}

/** Every source id the console would delete, flattened across all groups. */
export function duplicateRemovalIds(groups: readonly DuplicateGroup[]): string[] {
  return groups.flatMap((group) => group.remove.map((source) => source.id))
}
