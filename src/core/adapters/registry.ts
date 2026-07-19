import type { Capturable, SourceAdapter } from './types'
import { youtubeAdapter } from './youtube/adapter'
import { xAdapter } from './x/adapter'
import { redditAdapter } from './reddit/adapter'
import { hackernewsAdapter } from './hackernews/adapter'

/**
 * Every registered platform adapter. Adding a platform is: implement
 * `SourceAdapter` in its own folder, add one entry here — the manifest
 * host permissions, popup detection, and capture dispatch all derive
 * from this list.
 */
export const ALL_ADAPTERS: readonly SourceAdapter[] = [
  youtubeAdapter,
  xAdapter,
  redditAdapter,
  hackernewsAdapter,
]

export function adapterForUrl(url: string): SourceAdapter | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  return ALL_ADAPTERS.find((a) =>
    a.hostMatch.some((pattern) => hostPatternMatchesUrl(pattern, parsed)),
  )
}

/** A URL whose registered adapter has confirmed a concrete capture offer. */
export interface ResolvedCapturable {
  url: string
  adapter: SourceAdapter
  capturable: Capturable
}

/** Resolves host ownership and URL eligibility together, once. */
export function resolveCapturable(url: string): ResolvedCapturable | undefined {
  const adapter = adapterForUrl(url)
  if (adapter === undefined) return undefined
  const capturable = adapter.detect(url)
  return capturable === null ? undefined : { url, adapter, capturable }
}

/**
 * Manifest `host_permissions` for every adapter page origin plus every
 * background-fetched API origin — wxt.config.ts's only permissions source.
 */
export function allHostPermissions(): string[] {
  const hosts = new Set<string>()
  for (const a of ALL_ADAPTERS) {
    for (const h of a.hostMatch) hosts.add(h)
    for (const h of a.apiHosts ?? []) hosts.add(h)
  }
  return [...hosts]
}

/** Whether one origin match pattern covers a URL (exact host or `*.` wildcard). */
function hostPatternMatchesUrl(pattern: string, url: URL): boolean {
  const [scheme, remainder] = pattern.split('://')
  if (scheme === undefined || remainder === undefined || url.protocol !== `${scheme}:`) return false
  const host = remainder.split('/')[0] ?? remainder
  if (host.startsWith('*.')) {
    const base = host.slice(2)
    return url.hostname === base || url.hostname.endsWith(`.${base}`)
  }
  return url.hostname === host
}
