import type { Effect } from 'effect'
import type { PorterError } from '../fx/errors'
import type { DebugLog, Http } from '../fx/services'
import type { Capture, SiteId } from '../model/types'

/**
 * What a URL offers for capture, decided synchronously from the URL alone
 * so the popup can label its button without touching the page. Capabilities
 * are declared here so no caller ever switches on platform id to discover
 * them.
 */
export interface Capturable {
  kind: 'thread' | 'playlist' | 'video'
  label: string
  /** Present when this capture can attach transcript snapshots (`CaptureOptions.enrichTranscripts`). */
  canEnrichTranscripts?: true
}

/** Adapter-interpreted options for one capture — named after the capability, never the platform. */
export interface CaptureOptions {
  enrichTranscripts?: true
}

/**
 * How a platform captures. Exactly one mode per adapter, enforced by the
 * union (previously two optional fields whose mutual exclusion lived in a
 * doc comment):
 *
 * - `url` — background-side: the adapter fetches public JSON/HTML itself
 *   (Reddit `.json`, HN Algolia, YouTube playlist page + InnerTube).
 *   Preferred: no content script, no injection surface, works on any tab.
 *
 * - `content-script` — the site needs page context (X: logged-in DOM /
 *   intercepted GraphQL). The matching `src/entrypoints/*.content.ts` script
 *   owns extraction; the background relays to it via `captureSource` in
 *   ./capture.ts, which needs the captured tab's id.
 */
export type CaptureStrategy =
  | {
      mode: 'url'
      capture: (
        url: string,
        options?: CaptureOptions,
      ) => Effect.Effect<Capture, PorterError, Http | DebugLog>
    }
  | { mode: 'content-script' }

/**
 * One platform's capture strategy.
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
  strategy: CaptureStrategy
}
