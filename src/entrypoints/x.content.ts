/**
 * X/Twitter thread extractor. Runs on status pages; on 'porter/extract-thread'
 * it walks the loaded conversation (article[data-testid="tweet"] DOM) and
 * returns a Capture { kind: 'thread' }.
 *
 * DOM-walk variant (design §5.4's pragmatic "ships today" tier — the
 * GraphQL tee is the roadmap primary). All parsing/assembly is pure and
 * lives in `core/adapters/x/extract.ts`; this file is scrape-and-glue only.
 */
import {
  assembleThread,
  parseStatusUrl,
  renderTweetTextNodes,
  type RawTweet,
  type TweetTextNode,
} from '../core/adapters/x/extract'
import { X_CONTENT_MATCHES } from '../core/adapters/x/adapter'
import { X_GRAPHQL_TEE_EVENT, createXThreadEvidence } from '../core/adapters/x/graphql'
import { hasMessageType } from '../core/messaging'
import type { ExtractResponse } from '../core/messaging'

/**
 * Every CSS selector this scraper depends on — the single drift surface for
 * when X changes its markup. Nothing else in this file should contain a raw
 * `data-testid` string.
 */
const SELECTORS = {
  tweetArticle: 'article[data-testid="tweet"]', // one rendered tweet/reply in the timeline
  promotedAncestor: '[data-testid="placementTracking"]', // wraps promoted/ad tweets — skip these entirely
  userNameBlock: '[data-testid="User-Name"]', // display-name + handle block; 2nd one (if any) belongs to a quote-tweet embed
  handleLink: 'a[href^="/"]', // profile links inside User-Name; the handle is the href's path segment
  tweetText: '[data-testid="tweetText"]', // tweet body; 2nd one (if any) is a quote-tweet's body
  time: 'time[datetime]', // this tweet's own ISO timestamp
  showMore: '[data-testid="tweet-text-show-more-link"]', // clipped long-post text we deliberately don't click
} as const

const SCROLL_STEP_PX = 1600
const SCROLL_WAIT_MS = 350
const MAX_SCROLL_STEPS = 25
const STALL_LIMIT = 3

const threadEvidence = createXThreadEvidence()

function eventDetail(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'detail' in value ? value.detail : undefined
}

function receiveGraphqlResponse(event: Event): void {
  threadEvidence.observe(eventDetail(event))
}

export default defineContentScript({
  matches: [...X_CONTENT_MATCHES],
  runAt: 'document_start',
  main() {
    document.addEventListener(X_GRAPHQL_TEE_EVENT, receiveGraphqlResponse)
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!hasMessageType(message, 'porter/extract-thread')) return
      // A rejection here would otherwise hang the popup's capture forever.
      extractThread().then(sendResponse, (err: unknown) => {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
      })
      return true
    })
  },
})

async function extractThread(): Promise<ExtractResponse> {
  const pageUrl = location.href
  const parts = parseStatusUrl(pageUrl)
  if (!parts) {
    return { ok: false, error: 'Not on an X status (thread) page' }
  }

  const drained = await scrollDrainAndScrape(parts.statusId)
  if (!drained.ok) {
    return { ok: false, error: drained.error }
  }
  const tweets = threadEvidence.resolve(parts.statusId, drained.tweets)
  const { truncated } = drained
  if (tweets.length === 0) {
    return { ok: false, error: 'No tweets found on this page after scrolling' }
  }

  try {
    const thread = assembleThread(tweets, pageUrl, { truncated })
    return { ok: true, capture: { kind: 'thread', thread } }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

type DrainResult =
  | { ok: true; tweets: RawTweet[]; truncated: boolean }
  | { ok: false; error: string }

/**
 * X keeps only ~30 articles mounted at a time, so we repeatedly scroll
 * toward the end of the conversation, scraping whatever's mounted after
 * each step, until 3 consecutive steps add no new tweet ids (or we hit the
 * step cap). Scrolls back to the top afterward so we don't strand the tab
 * mid-conversation.
 *
 * X is an SPA, so a drain (up to ~9s) can outlive the thread it started on
 * if the user navigates away mid-scroll. `statusId` pins the thread we were
 * called for; each iteration re-checks `location.href` against it *after*
 * the scroll wait (the earliest point a foreign page could have mounted)
 * and before scraping, so we never blend a different thread's tweets in —
 * we abort the whole capture instead.
 */
async function scrollDrainAndScrape(statusId: string): Promise<DrainResult> {
  const seen = new Map<string, RawTweet>()
  const flags = { showMore: false }
  let stall = 0
  let step = 0

  scrapeVisible(seen, flags)

  while (step < MAX_SCROLL_STEPS && stall < STALL_LIMIT) {
    const before = seen.size
    window.scrollBy(0, SCROLL_STEP_PX)
    // eslint-disable-next-line no-await-in-loop -- each step must wait for X to mount more DOM before scraping; sequential is the point.
    await wait(SCROLL_WAIT_MS)
    if (parseStatusUrl(location.href)?.statusId !== statusId) {
      return { ok: false, error: 'Navigated away from the thread during capture' }
    }
    scrapeVisible(seen, flags)
    step += 1
    stall = seen.size > before ? 0 : stall + 1
  }

  const hitStepCap = step >= MAX_SCROLL_STEPS && stall < STALL_LIMIT
  window.scrollTo(0, 0)

  return { ok: true, tweets: [...seen.values()], truncated: hitStepCap || flags.showMore }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function scrapeVisible(seen: Map<string, RawTweet>, flags: { showMore: boolean }): void {
  const articles = document.querySelectorAll<HTMLElement>(SELECTORS.tweetArticle)
  for (const article of articles) {
    if (article.closest(SELECTORS.promotedAncestor)) continue
    if (article.querySelector(SELECTORS.showMore)) flags.showMore = true
    const tweet = scrapeArticle(article)
    if (tweet) seen.set(tweet.id, tweet)
  }
}

function scrapeArticle(article: HTMLElement): RawTweet | null {
  const id = tweetIdFromArticle(article)
  if (!id) return null

  const nameBlocks = article.querySelectorAll(SELECTORS.userNameBlock)
  const own = extractAuthor(nameBlocks[0] ?? null)
  if (!own.handle) return null

  const textBlocks = article.querySelectorAll<HTMLElement>(SELECTORS.tweetText)
  const text = textBlocks[0] ? renderTweetTextNodes(nodesFromElement(textBlocks[0])) : ''

  const timeEl = article.querySelector<HTMLTimeElement>(SELECTORS.time)
  const timestamp = timeEl?.getAttribute('datetime') ?? undefined

  const quoteAuthor = nameBlocks.length > 1 ? extractAuthor(nameBlocks[1] ?? null) : null
  const quoteText =
    textBlocks.length > 1 && textBlocks[1]
      ? renderTweetTextNodes(nodesFromElement(textBlocks[1]))
      : ''

  return {
    id,
    authorHandle: own.handle,
    authorName: own.name,
    text,
    ...(timestamp ? { timestamp } : {}),
    ...(quoteAuthor?.handle && quoteText
      ? { quotedAuthorHandle: quoteAuthor.handle, quotedText: quoteText }
      : {}),
  }
}

/** The tweet's own status id, read off the permalink `<a>` wrapping its timestamp. */
function tweetIdFromArticle(article: HTMLElement): string | null {
  const timeEl = article.querySelector(SELECTORS.time)
  const anchor = timeEl?.closest('a[href*="/status/"]')
  const href = anchor?.getAttribute('href')
  const match = href?.match(/\/status\/(\d+)/)
  return match?.[1] ?? null
}

function extractAuthor(nameBlock: Element | null): { handle: string | null; name: string } {
  if (!nameBlock) return { handle: null, name: '' }
  let handle: string | null = null
  for (const link of nameBlock.querySelectorAll<HTMLAnchorElement>(SELECTORS.handleLink)) {
    const match = link.getAttribute('href')?.match(/^\/(\w+)$/)
    if (match?.[1]) {
      handle = match[1]
      break
    }
  }
  const name = nameBlock.querySelector('span')?.textContent?.trim() ?? handle ?? ''
  return { handle, name }
}

/** Walks a tweetText container's children, preserving `<br>`s and rendering emoji `<img alt>`. */
function nodesFromElement(el: Element): TweetTextNode[] {
  const nodes: TweetTextNode[] = []
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      nodes.push({ kind: 'text', value: child.textContent ?? '' })
    } else if (child instanceof HTMLElement) {
      if (child.tagName === 'IMG') {
        nodes.push({ kind: 'emoji', alt: child.getAttribute('alt') ?? '' })
      } else if (child.tagName === 'BR') {
        nodes.push({ kind: 'break' })
      } else {
        nodes.push(...nodesFromElement(child))
      }
    }
  }
  return nodes
}
