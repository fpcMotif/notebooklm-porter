/**
 * Pure formatting for the "drain burst settled" notification (design: one
 * notification per burst summarizing what happened, never one per job).
 */

export interface DrainBurstCounts {
  sent: number
  retrying: number
  failed: number
  blocked: number
  uncertain: number
}

export function emptyDrainBurstCounts(): DrainBurstCounts {
  return { sent: 0, retrying: 0, failed: 0, blocked: 0, uncertain: 0 }
}

export interface DrainNotification {
  title: string
  message: string
}

/** A burst worth surfacing: it ran into trouble, or it finished real work. */
const NOTIFY_SENT_THRESHOLD = 5

export function shouldNotifyDrainBurst(counts: DrainBurstCounts): boolean {
  return (
    counts.failed > 0 ||
    counts.blocked > 0 ||
    counts.uncertain > 0 ||
    counts.sent >= NOTIFY_SENT_THRESHOLD
  )
}

/** Returns undefined when the burst isn't worth a notification. */
export function formatDrainBurstNotification(
  counts: DrainBurstCounts,
): DrainNotification | undefined {
  if (!shouldNotifyDrainBurst(counts)) return undefined

  const parts: string[] = []
  if (counts.sent > 0) parts.push(`${counts.sent} synced`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.blocked > 0) parts.push(`${counts.blocked} blocked`)
  if (counts.uncertain > 0) parts.push(`${counts.uncertain} uncertain`)

  return {
    title: 'NotebookLM Porter',
    message: parts.length > 0 ? `Porter: ${parts.join(', ')}` : 'Porter: drain finished',
  }
}
