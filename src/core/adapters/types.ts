import type { Effect } from 'effect'
import type { PorterError } from '../fx/errors'
import type { DebugLog, Http } from '../fx/services'
import type { Capture, SiteId } from '../model/types'

/**
 * What a URL offers for capture, decided synchronously from the URL alone
 * so the popup can label its button without touching the page.
 */
export type Capturable = { kind: 'thread'; label: string } | { kind: 'playlist'; label: string }

/**
 * One platform's capture strategy. Two capture paths exist and an adapter
 * implements exactly one:
 *
 * - `captureFromUrl` — background-side: the adapter fetches public JSON/HTML
 *   itself (Reddit `.json`, HN Algolia, YouTube playlist page + InnerTube).
 *   Preferred: no content script, no injection surface, works on any tab.
 *
 * - `contentScript: true` — the site needs page context (X: logged-in DOM /
 *   intercepted GraphQL). The matching `src/entrypoints/*.content.ts` script
 *   owns extraction and ships the Capture to the background over messaging.
 *
 * `hostMatch` is the single source of truth for manifest `host_permissions`
 * (and content-script `matches` where applicable) — wxt.config.ts derives
 * from the registry, so adding a platform never edits the manifest by hand.
 */
export interface SourceAdapter {
  id: SiteId
  /** Match patterns for the site's own pages, `https://host/*` form. */
  hostMatch: readonly string[]
  /** Extra origins the adapter fetches from the background (APIs, alt domains). */
  apiHosts?: readonly string[]
  /** What this URL offers, or null when the page has nothing capturable. */
  detect(url: string): Capturable | null
  /** Background-side capture from the URL alone. Mutually exclusive with `contentScript`. */
  captureFromUrl?(url: string): Effect.Effect<Capture, PorterError, Http | DebugLog>
  /** True when a content script owns extraction for this site. */
  contentScript?: boolean
}
