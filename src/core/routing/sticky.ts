/**
 * Sticky notebook routing: remember the last NotebookLM destination (and
 * account) a site successfully delivered to, so the popup can preselect it
 * next time instead of making the user re-pick every capture. Pure reducers
 * only — the router persists through `recordRoute` on a successful enqueue,
 * the popup reads through `preferredRoute` / `preferredRouteForDocs`.
 *
 * Keyed by `stickyRouteKey`, not raw `SiteId`: every non-web site has one
 * fixed key, but `web` captures span arbitrary domains, so they key by
 * hostname instead — otherwise one page's target would leak onto every
 * other site the context-menu capture ever touches.
 */
import type { SiteId } from '../model/types'

export interface StickyTarget {
  notebookId: string
  authuser: number
  /** ISO 8601 timestamp of the enqueue that produced this target — the eviction clock. */
  updatedAt: string
}

export type StickyRouteMap = Record<string, StickyTarget>

/** Bounds the map so an open-ended stream of `web` domains can't grow settings without limit. */
export const STICKY_ROUTE_LIMIT = 50

export function emptyStickyRoutes(): StickyRouteMap {
  return {}
}

/** Site key for sticky routing — the SiteId itself, except `web`, which keys by hostname. */
export function stickyRouteKey(site: SiteId, canonicalUrl: string): string {
  if (site !== 'web') return site
  try {
    const hostname = new URL(canonicalUrl).hostname
    return hostname === '' ? site : hostname
  } catch {
    return site
  }
}

/**
 * Records (or overwrites) the target for one route key. Once the map grows
 * past `STICKY_ROUTE_LIMIT`, the single least-recently-updated OTHER entry
 * is evicted — one write can only ever push the map one over the limit, so
 * evicting one always restores the bound.
 */
export function recordRoute(
  map: StickyRouteMap,
  siteKey: string,
  target: StickyTarget,
): StickyRouteMap {
  const next: StickyRouteMap = { ...map, [siteKey]: target }
  const keys = Object.keys(next)
  if (keys.length <= STICKY_ROUTE_LIMIT) return next

  const oldestKey = keys
    .filter((key) => key !== siteKey)
    .toSorted((a, b) => {
      const left = next[a]?.updatedAt ?? ''
      const right = next[b]?.updatedAt ?? ''
      return left.localeCompare(right)
    })[0]
  if (oldestKey === undefined) return next
  const { [oldestKey]: _evicted, ...pruned } = next
  return pruned
}

/** The remembered target for one route key, if any. */
export function preferredRoute(map: StickyRouteMap, siteKey: string): StickyTarget | undefined {
  return map[siteKey]
}

/**
 * The remembered target shared by every doc in a staged set, or undefined
 * when any doc lacks a sticky entry or the set disagrees on notebook/account
 * — mirrors `resolveNotebookTarget`'s all-or-nothing consensus so a mixed
 * capture batch never silently routes to only one doc's remembered target.
 */
export function preferredRouteForDocs(
  map: StickyRouteMap,
  docs: readonly { site: SiteId; canonicalUrl: string }[],
): StickyTarget | undefined {
  let candidate: StickyTarget | undefined
  for (const doc of docs) {
    const target = preferredRoute(map, stickyRouteKey(doc.site, doc.canonicalUrl))
    if (target === undefined) return undefined
    if (candidate === undefined) {
      candidate = target
    } else if (
      candidate.notebookId !== target.notebookId ||
      candidate.authuser !== target.authuser
    ) {
      return undefined
    }
  }
  return candidate
}
