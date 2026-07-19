/**
 * Pure input→intent parsing and suggestion building for the "nlm" omnibox
 * keyword (design: omnibox mirrors the popup's two entry points — capture a
 * URL, or jump to something already captured — without needing an open tab).
 */
import { adapterForUrl } from '../adapters/registry'
import type { Capturable } from '../adapters/types'

export type OmniboxIntent = { kind: 'url'; url: string } | { kind: 'query'; query: string }

/** Doc suggestions are content-prefixed so `onInputEntered` can tell them from URLs. */
const DOC_SUGGESTION_PREFIX = 'doc:'

export interface OmniboxSuggestion {
  content: string
  description: string
}

export interface OmniboxDocCandidate {
  id: string
  title: string
}

export type EnteredOmniboxIntent =
  | { kind: 'capture'; url: string }
  | { kind: 'open-doc'; docId: string }
  | { kind: 'open-url'; url: string }
  | { kind: 'noop' }

function isHttpUrl(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

/**
 * Parses `text` as-is first so an explicit non-http(s) scheme (mailto:,
 * chrome:, javascript:) is rejected rather than mistaken for a bare host
 * once `https://` gets prepended — only text with NO scheme at all falls
 * through to the schemeless-host fallback.
 */
function tryParseUrl(text: string): URL | undefined {
  try {
    const direct = new URL(text)
    return isHttpUrl(direct) ? direct : undefined
  } catch {
    // Not a URL on its own — fall through to the schemeless-host guess below.
  }
  try {
    const withScheme = new URL(`https://${text}`)
    return isHttpUrl(withScheme) ? withScheme : undefined
  } catch {
    return undefined
  }
}

/** What the user is typing: a navigable URL, or a search-style query. */
export function parseOmniboxInput(raw: string): OmniboxIntent {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { kind: 'query', query: '' }
  const url = tryParseUrl(trimmed)
  return url === undefined
    ? { kind: 'query', query: trimmed }
    : { kind: 'url', url: url.toString() }
}

/**
 * What accepting the current omnibox text should do. A capturable, url-mode
 * URL (the adapter fetches from the background — no tab needed) captures
 * directly; a content-script-only adapter (e.g. X) or any other URL just
 * navigates there, since extraction needs real page context.
 */
export function classifyEnteredOmniboxText(raw: string): EnteredOmniboxIntent {
  if (raw.startsWith(DOC_SUGGESTION_PREFIX)) {
    return { kind: 'open-doc', docId: raw.slice(DOC_SUGGESTION_PREFIX.length) }
  }
  const intent = parseOmniboxInput(raw)
  if (intent.kind !== 'url') return { kind: 'noop' }
  const adapter = adapterForUrl(intent.url)
  const capturable = adapter?.detect(intent.url) ?? null
  // "url mode" = the adapter fetches from the background itself (no tab needed);
  // a content-script adapter (X) needs real page context, so just navigate there.
  const urlModeCapturable = capturable !== null && adapter?.strategy.mode === 'url'
  return urlModeCapturable
    ? { kind: 'capture', url: intent.url }
    : { kind: 'open-url', url: intent.url }
}

/** Escapes the five XML entities the omnibox suggestion description requires. */
export function escapeOmniboxXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Suggestion offering to capture the URL currently typed in the omnibox. */
export function buildCaptureSuggestion(url: string, capturable: Capturable): OmniboxSuggestion {
  return { content: url, description: `Capture: ${escapeOmniboxXml(capturable.label)}` }
}

/** Suggestion offering to jump to an already-captured doc. */
export function buildDocSuggestion(doc: OmniboxDocCandidate): OmniboxSuggestion {
  return {
    content: `${DOC_SUGGESTION_PREFIX}${doc.id}`,
    description: `Open: ${escapeOmniboxXml(doc.title)}`,
  }
}

/** Smallest window in `haystack` containing `needle` as an in-order subsequence, or undefined. */
function subsequenceSpan(haystack: string, needle: string): number | undefined {
  let start = -1
  let needleIndex = 0
  for (let i = 0; i < haystack.length; i++) {
    if (haystack[i] === needle[needleIndex]) {
      if (needleIndex === 0) start = i
      needleIndex++
      if (needleIndex === needle.length) return i - start + 1
    }
  }
  return undefined
}

/**
 * Subsequence fuzzy match against captured doc titles: every query
 * character must appear in title order (case-insensitive), ranked by how
 * tightly the match clusters so a tight match beats a scattered one.
 * An empty query returns the most-recent docs (callers pass already
 * recency-sorted lists) up to `limit`.
 */
export function fuzzyMatchDocs<T extends OmniboxDocCandidate>(
  docs: readonly T[],
  query: string,
  limit = 5,
): T[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return docs.slice(0, limit)

  const scored: { doc: T; span: number }[] = []
  for (const doc of docs) {
    const span = subsequenceSpan(doc.title.toLowerCase(), needle)
    if (span !== undefined) scored.push({ doc, span })
  }
  return scored
    .toSorted((a, b) => a.span - b.span)
    .slice(0, limit)
    .map((entry) => entry.doc)
}
