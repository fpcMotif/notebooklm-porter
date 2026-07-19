/**
 * Pure reconciliation of planned ingest units against a notebook's ACTUAL
 * server-side sources — the source of truth the sync ledger only approximates.
 * NotebookLM sources are append-only with no server-side dedup, so before
 * mutating, the drain/enqueue paths consult this partition: `present` units
 * are skipped + receipted, only `absent` units may be sent.
 *
 * Matching is by validated YouTube identity (`sourceDedupeKey`). A playlist
 * video Porter would paste as a transcript text unit shares the video's
 * identity — a server-side YouTube link suppresses it, mirroring the receipt
 * identity `planIngestUnits` assigns both unit kinds. URL-less text units
 * (playlist ToC, threads) can never match: NotebookLM text sources carry no
 * canonical URL and title matching breaks on renames, so they keep
 * ledger-only protection. This module only prevents duplicates; deletion
 * stays with the console's dedup.
 */
import { youtubeVideoIdentity } from '../../adapters/youtube/video'
import type { IngestUnit } from '../units'
import { pickKeeper, sourceDedupeKey } from './dedup'
import { isFailedSource, type NotebookSource } from './model'

export interface PresentMatch {
  unit: IngestUnit
  /** The best server row sharing the unit's identity (usable beats broken). */
  source: NotebookSource
  /** True when that best row failed to load — the console's refresh target. */
  errored: boolean
}

export interface ReconcileResult {
  /** Units the notebook already has, in input order. */
  present: PresentMatch[]
  /** Units the notebook still needs, in input order. */
  absent: IngestUnit[]
}

/**
 * Transcript text units carry their video identity in the unit id; the
 * convention's owner is `planIngestUnits` (`youtube:<videoId>`, distinct from
 * the `:toc` overview suffix).
 */
const TRANSCRIPT_UNIT_ID_RE = /^youtube:([\w-]{11})$/

/** Server-visible identity of a unit, or undefined when it can never match. */
function unitIdentity(unit: IngestUnit): string | undefined {
  if (unit.kind === 'youtube') {
    const youtube = youtubeVideoIdentity(unit.url)
    return youtube === undefined ? undefined : `youtube:${youtube.videoId}`
  }
  const videoId = TRANSCRIPT_UNIT_ID_RE.exec(unit.id)?.[1]
  return videoId === undefined ? undefined : `youtube:${videoId}`
}

/**
 * Partitions `units` against the notebook's live `sources`. When duplicate
 * server rows share an identity, the match reports the best copy (the
 * console's keeper preference) so `errored` reflects the row the user would
 * actually keep.
 */
export function reconcileUnits(
  units: readonly IngestUnit[],
  sources: readonly NotebookSource[],
): ReconcileResult {
  const bucketsByIdentity = new Map<string, NotebookSource[]>()
  for (const source of sources) {
    const identity = sourceDedupeKey(source)
    if (identity === undefined) continue
    const bucket = bucketsByIdentity.get(identity)
    if (bucket === undefined) bucketsByIdentity.set(identity, [source])
    else bucket.push(source)
  }
  const bestByIdentity = new Map<string, NotebookSource>()
  for (const [identity, bucket] of bucketsByIdentity) {
    bestByIdentity.set(identity, pickKeeper(bucket))
  }

  const present: PresentMatch[] = []
  const absent: IngestUnit[] = []
  for (const unit of units) {
    const identity = unitIdentity(unit)
    const source = identity === undefined ? undefined : bestByIdentity.get(identity)
    if (source === undefined) {
      absent.push(unit)
    } else {
      present.push({ unit, source, errored: isFailedSource(source) })
    }
  }
  return { present, absent }
}
