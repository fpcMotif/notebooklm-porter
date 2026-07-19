import { isResolvedUrlCapturable } from '../adapters/capture'
import { resolveCapturable } from '../adapters/registry'
import type { SourceDoc } from '../model/types'

/** Kinds a watch may bind: sources that grow over time. A static video never changes. */
export const WATCHABLE_KINDS: ReadonlySet<SourceDoc['kind']> = new Set(['thread', 'playlist'])

/**
 * Whether a captured source supports unattended background resync: its kind
 * is watchable, its adapter captures from the URL alone (no content script),
 * and the URL still detects as the kind it was captured as. Pure and
 * synchronous so the popup can hint eligibility without a round-trip.
 */
export function canWatchSource(doc: Pick<SourceDoc, 'site' | 'kind' | 'canonicalUrl'>): boolean {
  if (!WATCHABLE_KINDS.has(doc.kind)) return false
  const resolved = resolveCapturable(doc.canonicalUrl)
  return (
    resolved !== undefined &&
    resolved.adapter.id === doc.site &&
    isResolvedUrlCapturable(resolved) &&
    resolved.capturable.kind === doc.kind
  )
}
