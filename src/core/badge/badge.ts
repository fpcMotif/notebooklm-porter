/**
 * Pure badge-state decisions for the extension action icon. Two badge
 * contexts compete for the same visible badge: a per-tab "this page is
 * capturable" hint, and a durable "queue needs attention" count. The queue
 * always wins while it has anything worth surfacing, so a failed or pending
 * ingest is never hidden behind an unrelated tab's capturable dot.
 */
import type { Capturable } from '../adapters/types'

export interface BadgeQueueCounts {
  /** Jobs still pending delivery (queued, retrying, or in flight). */
  queued: number
  /** Jobs that need human review (failed, blocked, or uncertain). */
  failed: number
}

export interface BadgeState {
  text: string
  color: string
}

const QUEUE_FAILED_COLOR = '#dc2626' // red-600
const QUEUE_QUEUED_COLOR = '#6b7280' // gray-500
const CAPTURABLE_COLOR = '#2563eb' // blue-600
const CAPTURE_SUCCESS_COLOR = '#16a34a' // green-600

const CAPTURABLE_LETTERS: Record<Capturable['kind'], string> = {
  thread: 'T',
  playlist: 'P',
  video: 'V',
}

const MAX_BADGE_COUNT = 99

function formatCount(count: number): string {
  return count > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : String(count)
}

/**
 * Decides what the action badge should show for one tab. Priority: failed
 * queue jobs, then queued/in-flight jobs, then the tab's own capturable
 * hint. `undefined` means "clear the badge" — nothing worth showing.
 */
export function decideBadge(
  capturable: Capturable | null,
  queue: BadgeQueueCounts,
): BadgeState | undefined {
  if (queue.failed > 0) return { text: formatCount(queue.failed), color: QUEUE_FAILED_COLOR }
  if (queue.queued > 0) return { text: formatCount(queue.queued), color: QUEUE_QUEUED_COLOR }
  if (capturable === null) return undefined
  return { text: CAPTURABLE_LETTERS[capturable.kind], color: CAPTURABLE_COLOR }
}

/** Badge flashed on a tab right after a successful command/omnibox capture. */
export function captureSuccessBadge(): BadgeState {
  return { text: '✓', color: CAPTURE_SUCCESS_COLOR }
}
