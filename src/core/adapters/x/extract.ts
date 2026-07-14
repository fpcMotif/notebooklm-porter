import type { Author, MediaRef, Post, Thread } from '../../model/types'

/**
 * Minimal intermediate the content script scrapes one DOM `article` into.
 * Deliberately flat/untyped-tree — X's real reply graph isn't observable
 * from a single conversation-page DOM walk, so we don't pretend to have it
 * (see `assembleThread`). This is also the seam the future GraphQL tee
 * (design §5.4) would populate instead of the DOM walker.
 */
export interface RawTweet {
  id: string
  authorHandle: string
  authorName: string
  /** Plain text, already de-duplicated of the DOM's own emoji/newline markup. */
  text: string
  timestamp?: string
  /** GraphQL conversation root; absent for DOM-only rows. */
  conversationId?: string
  /** Author + text of a quote-tweet embed, when this tweet quotes another. */
  quotedAuthorHandle?: string
  quotedText?: string
  links?: string[]
  media?: MediaRef[]
}

export interface AssembleThreadOptions {
  /** Scroll-drain hit its step cap, or a tweet's text was visibly clipped ("Show more") and left uncaptured. */
  truncated?: boolean
}

export interface StatusUrlParts {
  handle: string
  statusId: string
}

/** Parses `/<handle>/status/<id>` out of an X permalink; null for anything else. */
export function parseStatusUrl(pageUrl: string): StatusUrlParts | null {
  let parsed: URL
  try {
    parsed = new URL(pageUrl)
  } catch {
    return null
  }
  const match = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/)
  const handle = match?.[1]
  const statusId = match?.[2]
  if (!handle || !statusId) return null
  return { handle, statusId }
}

function stripAt(handle: string): string {
  return handle.startsWith('@') ? handle.slice(1) : handle
}

function normalizeHandle(handle: string): string {
  return stripAt(handle).toLowerCase()
}

function formatHandle(handle: string): string {
  return `@${stripAt(handle)}`
}

/**
 * Strips a trailing `https://t.co/xxxx` link off tweet text. X always
 * appends the shortened link for an attached card/quote/media at the end of
 * the raw text even though the card renders it separately — left in, it
 * shows up as a redundant dangling URL in the Markdown source.
 */
export function stripTrailingTco(text: string): string {
  return text.replace(/\s*https:\/\/t\.co\/\w+\s*$/, '')
}

/** One child-node of a tweetText container, pre-classified by the content script. */
export type TweetTextNode =
  | { kind: 'text'; value: string }
  | { kind: 'emoji'; alt: string }
  | { kind: 'break' }

/**
 * Joins a tweetText container's child nodes back into a string, preserving
 * `<br>` line breaks and rendering emoji `<img alt>` as their alt text —
 * pulled out of the content script so the join logic is unit-testable
 * without a DOM.
 */
export function renderTweetTextNodes(nodes: TweetTextNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === 'text') return node.value
      if (node.kind === 'emoji') return node.alt
      return '\n'
    })
    .join('')
}

function formatQuoteBlock(raw: RawTweet): string | null {
  if (!raw.quotedText) return null
  const label = raw.quotedAuthorHandle
    ? `Quoting ${formatHandle(raw.quotedAuthorHandle)}:`
    : 'Quoting:'
  const body = raw.quotedText
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n')
  return `${label}\n${body}`
}

/** Post text = cleaned tweet text, plus the quoted tweet (if any) as a nested blockquote. */
function composeText(raw: RawTweet): string {
  const base = stripTrailingTco(raw.text)
  const quote = formatQuoteBlock(raw)
  return quote ? `${base}\n\n${quote}` : base
}

function deriveTitle(rootText: string, opHandle: string): string {
  const firstLine = rootText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (!firstLine) return `Thread by ${formatHandle(opHandle)}`
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine
}

/** The tweet the permalink actually points at, falling back to the OP's first tweet, then the first tweet. */
function findRootTweet(rawTweets: RawTweet[], statusId: string, opHandleNorm: string): RawTweet {
  const byId = rawTweets.find((t) => t.id === statusId)
  if (byId) return byId
  const byOp = rawTweets.find((t) => normalizeHandle(t.authorHandle) === opHandleNorm)
  if (byOp) return byOp
  const first = rawTweets[0]
  if (!first) throw new Error('assembleThread: no tweets to assemble')
  return first
}

function resolveOpAuthor(rawTweets: RawTweet[], opHandleNorm: string, opHandle: string): Author {
  const found = rawTweets.find((t) => normalizeHandle(t.authorHandle) === opHandleNorm)
  if (found) return { name: found.authorName, handle: formatHandle(found.authorHandle) }
  return { name: opHandle, handle: formatHandle(opHandle) }
}

/**
 * Assembles scraped `RawTweet`s (already in DOM/conversation order) into a
 * `Thread`. Depth is NOT a real reply tree — X's conversation DOM doesn't
 * expose one — it's just `byOp` collapsed to two levels (design §5.4 house
 * style): 0 for every post by the thread's own author (self-thread
 * continuation), 1 for everyone else, in the order they were observed.
 */
export function assembleThread(
  rawTweets: RawTweet[],
  pageUrl: string,
  opts: AssembleThreadOptions = {},
): Thread {
  if (rawTweets.length === 0) {
    throw new Error('assembleThread: no tweets to assemble')
  }
  const parts = parseStatusUrl(pageUrl)
  if (!parts) {
    throw new Error(`assembleThread: "${pageUrl}" is not a /status/ page`)
  }
  const { handle: opHandle, statusId } = parts
  const opHandleNorm = normalizeHandle(opHandle)

  const posts: Post[] = rawTweets.map((raw) => {
    const byOp = normalizeHandle(raw.authorHandle) === opHandleNorm
    const links = (raw.links ?? []).filter((link) => link.length > 0)
    return {
      id: raw.id,
      author: { name: raw.authorName, handle: formatHandle(raw.authorHandle) },
      depth: byOp ? 0 : 1,
      text: composeText(raw),
      byOp,
      ...(raw.timestamp !== undefined ? { createdAt: raw.timestamp } : {}),
      ...(links.length > 0 ? { links } : {}),
      ...(raw.media !== undefined && raw.media.length > 0 ? { media: raw.media } : {}),
    }
  })

  const rootRaw = findRootTweet(rawTweets, statusId, opHandleNorm)
  const author = resolveOpAuthor(rawTweets, opHandleNorm, opHandle)

  return {
    site: 'x',
    url: pageUrl,
    title: deriveTitle(rootRaw.text, opHandle),
    author,
    posts,
    ...(rootRaw.timestamp !== undefined ? { createdAt: rootRaw.timestamp } : {}),
    ...(opts.truncated ? { truncated: true } : {}),
  }
}
