import type { SourceAdapter } from './types'
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
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return undefined
  }
  return ALL_ADAPTERS.find((a) =>
    a.hostMatch.some((pattern) => hostMatchesHostname(pattern, hostname)),
  )
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

/** Whether a `https://host/*` pattern's host segment covers `hostname` (exact or `*.` wildcard). */
function hostMatchesHostname(pattern: string, hostname: string): boolean {
  const host = pattern.split('://')[1]?.split('/')[0] ?? pattern
  if (host.startsWith('*.')) {
    const base = host.slice(2)
    return hostname === base || hostname.endsWith(`.${base}`)
  }
  return hostname === host
}
