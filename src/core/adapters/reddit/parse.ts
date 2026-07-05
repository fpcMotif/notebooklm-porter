import type { Author, Post, Thread } from '../../model/types'

/**
 * Reddit's `.json` listing shapes, typed just enough to parse safely.
 * `unknown`-first because this is untrusted network JSON — every field is
 * narrowed before use.
 */
interface RedditListing {
  kind: 'Listing'
  data: { children: RedditThing[] }
}

type RedditThing = RedditPostThing | RedditCommentThing | RedditMoreThing

interface RedditPostThing {
  kind: 't3'
  data: {
    id: string
    title: string
    author: string
    selftext: string
    created_utc: number
    score?: number
    permalink: string
    num_comments?: number
    subreddit?: string
  }
}

interface RedditCommentThing {
  kind: 't1'
  data: {
    id: string
    author: string
    body: string
    created_utc: number
    score?: number
    depth?: number
    parent_id: string
    replies?: RedditListing | ''
  }
}

interface RedditMoreThing {
  kind: 'more'
  data: {
    children: string[]
    count?: number
  }
}

/**
 * Parses a Reddit `.json` post response into a flat, depth-first `Thread`.
 * Pure — no fetch, no expansion of `more` stubs (v1 marks `truncated` and
 * stops there; see design §5.2 for the budgeted `/api/morechildren` follow-up).
 */
export function parseRedditThread(json: unknown, url: string): Thread {
  const listings = asListingArray(json)
  const postListing = listings[0]
  const commentListing = listings[1]

  const postThing = findFirstOfKind(postListing, 't3')
  if (!postThing) {
    throw new Error('parseRedditThread: no t3 post found in listing[0]')
  }
  const post = postThing.data

  const opAuthor = post.author
  const author: Author = { name: opAuthor }

  let truncated = false
  const posts: Post[] = []

  posts.push({
    id: post.id,
    author,
    createdAt: toIso(post.created_utc),
    depth: 0,
    text: post.selftext ?? '',
    ...(post.score !== undefined ? { score: post.score } : {}),
    byOp: true,
  })

  const topLevelChildren = commentListing?.data.children ?? []
  for (const child of topLevelChildren) {
    truncated = walk(child, opAuthor, posts) || truncated
  }

  return {
    site: 'reddit',
    url,
    title: post.title,
    author,
    createdAt: toIso(post.created_utc),
    posts,
    stats: {
      ...(post.score !== undefined ? { score: post.score } : {}),
      ...(post.num_comments !== undefined ? { replyCount: post.num_comments } : {}),
    },
    ...(truncated ? { truncated: true } : {}),
  }
}

/**
 * Recursively flattens one comment-tree node (and its replies) into `posts`,
 * depth-first in reading order. Returns true if this subtree contains a
 * `more` stub with unexpanded children (count > 0), which marks the whole
 * thread truncated.
 */
function walk(thing: RedditThing, opAuthor: string, posts: Post[]): boolean {
  if (thing.kind === 'more') {
    return (thing.data.children?.length ?? 0) > 0
  }
  if (thing.kind !== 't1') return false

  const c = thing.data
  const depth = (c.depth ?? 0) + 1

  posts.push({
    id: c.id,
    author: { name: c.author },
    createdAt: toIso(c.created_utc),
    depth,
    text: c.body ?? '',
    ...(c.score !== undefined ? { score: c.score } : {}),
    parentId: stripPrefix(c.parent_id),
    byOp: c.author === opAuthor,
  })

  let truncated = false
  const replies = c.replies
  if (replies) {
    for (const child of replies.data.children) {
      truncated = walk(child, opAuthor, posts) || truncated
    }
  }
  return truncated
}

function stripPrefix(fullname: string): string {
  const idx = fullname.indexOf('_')
  return idx === -1 ? fullname : fullname.slice(idx + 1)
}

function toIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString()
}

function findFirstOfKind(
  listing: RedditListing | undefined,
  kind: 't3',
): RedditPostThing | undefined {
  if (!listing) return undefined
  const found = listing.data.children.find((c) => c.kind === kind)
  return found as RedditPostThing | undefined
}

function asListingArray(json: unknown): RedditListing[] {
  if (!Array.isArray(json)) {
    throw new Error('parseRedditThread: expected top-level array')
  }
  return json as RedditListing[]
}
