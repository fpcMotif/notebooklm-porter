import type { Author, Post, Thread } from '../../model/types'

/**
 * Raw shape of an Algolia HN item (`https://hn.algolia.com/api/v1/items/{id}`).
 * Only the fields we read; the real payload has more (`options`, `parent_id` on
 * children, etc.) that we don't need.
 */
interface HnAlgoliaItem {
  id: number | string
  created_at?: string
  author?: string | null
  title?: string | null
  url?: string | null
  points?: number | null
  text?: string | null
  type?: string
  children?: HnAlgoliaItem[] | null
}

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#x27': "'",
  '#x2F': '/',
  '#x2f': '/',
  '#39': "'",
  '#47': '/',
}

/** Decode the small set of HTML entities HN's Algolia `text` field actually uses. */
function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    const key = body.toLowerCase().startsWith('#x') ? `#x${body.slice(2)}` : body
    if (key in ENTITY_MAP) return ENTITY_MAP[key] as string
    if (/^#\d+$/.test(body)) {
      const code = Number(body.slice(1))
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (/^#x[0-9a-fA-F]+$/i.test(body)) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return whole
  })
}

/**
 * Converts HN's comment/story HTML (always a small, consistent subset: `<p>`,
 * `<a href>`, `<i>`, `<pre><code>`) into plain text, collecting outbound link
 * hrefs along the way. Pure — no DOM, so it works in the service worker.
 */
export function htmlToText(html: string | null | undefined): { text: string; links: string[] } {
  if (!html) return { text: '', links: [] }

  const links: string[] = []

  // Links first, before other tags are stripped, so we still have the href.
  let working = html.replace(
    /<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, inner: string) => {
      const decodedHref = decodeEntities(href)
      const label = decodeEntities(inner.replace(/<[^>]+>/g, '')).trim()
      links.push(decodedHref)
      if (!label || label === decodedHref) return decodedHref
      return `${label} (${decodedHref})`
    },
  )

  working = working.replace(
    /<pre>\s*<code>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_m, code: string) => code,
  )
  working = working.replace(/<\/?(i|em|b|strong|code)>/gi, '')
  working = working.replace(/<p>/gi, '\n\n')
  working = working.replace(/<\/p>/gi, '')
  // Any remaining tags (e.g. stray <pre>/<code> without pairing) — drop the markup, keep content.
  working = working.replace(/<[^>]+>/g, '')

  working = decodeEntities(working)
  working = working.replace(/\n{3,}/g, '\n\n').trim()

  return { text: working, links }
}

function toAuthor(name: string | null | undefined): Author {
  return { name: name ?? '[deleted]' }
}

/** Depth-first flatten of one item's children into Posts, given the root author for `byOp`. */
function flattenChildren(
  children: HnAlgoliaItem[],
  parentId: string,
  depth: number,
  rootAuthor: string | null | undefined,
  out: Post[],
): void {
  for (const child of children) {
    if (!child) continue
    const id = String(child.id)
    const { text, links } = htmlToText(child.text)
    const post: Post = {
      id,
      author: toAuthor(child.author),
      depth,
      text,
      parentId,
      byOp: child.author != null && child.author === rootAuthor,
    }
    if (child.created_at) post.createdAt = child.created_at
    if (typeof child.points === 'number') post.score = child.points
    if (links.length > 0) post.links = links
    out.push(post)

    if (child.children && child.children.length > 0) {
      flattenChildren(child.children, id, depth + 1, rootAuthor, out)
    }
  }
}

/** Derives an Ask-HN-style title from the story body when `title` is absent. */
function deriveTitle(root: HnAlgoliaItem, bodyText: string): string {
  if (root.title) return root.title
  const firstLine = bodyText.split('\n').find((line) => line.trim().length > 0)
  return firstLine?.trim() ?? `HN item ${root.id}`
}

/**
 * Pure parse of an Algolia HN item tree into a Thread. `json` is `unknown`
 * because it comes straight from `JSON.parse` on a fetch response.
 */
export function parseHnItem(json: unknown, url: string): Thread {
  const root = json as HnAlgoliaItem

  const { text: rootText, links: rootLinks } = htmlToText(root.text)
  const rootId = String(root.id)

  const links = [...rootLinks]
  if (root.url) links.unshift(root.url)

  const rootPost: Post = {
    id: rootId,
    author: toAuthor(root.author),
    depth: 0,
    text: root.url && !root.text ? '' : rootText,
    byOp: true,
  }
  if (root.created_at) rootPost.createdAt = root.created_at
  if (typeof root.points === 'number') rootPost.score = root.points
  if (links.length > 0) rootPost.links = links

  const posts: Post[] = [rootPost]
  if (root.children && root.children.length > 0) {
    flattenChildren(root.children, rootId, 1, root.author, posts)
  }

  const thread: Thread = {
    site: 'hackernews',
    url,
    title: deriveTitle(root, rootText),
    author: toAuthor(root.author),
    posts,
  }
  if (root.created_at) thread.createdAt = root.created_at

  return thread
}
