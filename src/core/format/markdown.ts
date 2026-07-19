import type { Playlist, Post, Thread } from '../model/types'
import { CAPTURED_AT_KEY, frontmatterBlock } from './frontmatter'
import type { FormatOptions } from './types'

/** Escape characters that would break a Markdown table cell. */
function escapeTableCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`').replace(/\n/g, ' ')
}

function authorLabel(author: Post['author']): string {
  return author.handle ? `${author.name} (${author.handle})` : author.name
}

function blockquotePrefix(depth: number): string {
  return depth > 0 ? '> '.repeat(depth) : ''
}

/** Prefix every line of a (possibly multi-paragraph) block with a blockquote marker. */
function applyBlockquote(depth: number, block: string): string {
  if (depth <= 0) return block
  const prefix = blockquotePrefix(depth)
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? `${prefix}${line}` : prefix.trimEnd()))
    .join('\n')
}

function renderPost(post: Post, options: Required<Pick<FormatOptions, 'permalinks'>>): string {
  const heading = `${blockquotePrefix(post.depth)}## ${authorLabel(post.author)} · ${post.createdAt ?? ''}`
  const body = applyBlockquote(post.depth, post.text)

  const parts = [heading, '', body]

  if (post.links && post.links.length > 0) {
    const linksBlock = post.links.map((link) => `- ${link}`).join('\n')
    parts.push('', applyBlockquote(post.depth, linksBlock))
  }

  if (post.media && post.media.length > 0) {
    const mediaBlock = post.media.map((media) => `![${media.alt ?? ''}](${media.url})`).join('\n')
    parts.push('', applyBlockquote(post.depth, mediaBlock))
  }

  if (options.permalinks) {
    parts.push('', applyBlockquote(post.depth, `[permalink](#${post.id})`))
  }

  return parts.join('\n')
}

/**
 * Filters posts per FormatOptions: minScore drops low-score posts (never
 * the OP chain — byOp posts are always kept), maxDepth drops posts nested
 * past the cap. Order is preserved (posts are already flat/depth-ordered).
 */
function filterPosts(posts: Post[], options: FormatOptions): Post[] {
  const { minScore = 0, maxDepth } = options
  return posts.filter((post) => {
    if (maxDepth !== undefined && post.depth > maxDepth) return false
    if (!post.byOp && minScore > 0 && (post.score ?? 0) < minScore) return false
    return true
  })
}

/**
 * Renders a Thread to Markdown: YAML frontmatter, then one `##` heading per
 * post with reply nesting expressed as blockquote depth (depth N => N
 * `"> "` prefixes; depth 0 = OP, no blockquote).
 */
export function threadToMarkdown(
  thread: Thread,
  capturedAt: string,
  options: FormatOptions = {},
): string {
  const posts = filterPosts(thread.posts, options)

  const fm = frontmatterBlock([
    ['source', thread.site],
    ['url', thread.url],
    ['title', thread.title],
    ['author', authorLabel(thread.author)],
    [CAPTURED_AT_KEY, capturedAt],
    ['truncated', thread.truncated ?? false],
    ['score', thread.stats?.score],
    ['reply_count', thread.stats?.replyCount],
  ])

  const permalinks = { permalinks: options.permalinks ?? false }
  const body = posts.map((post) => renderPost(post, permalinks)).join('\n\n')

  return [...fm, '', body].join('\n')
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

function captionsGlyph(hasCaptions: boolean | undefined): string {
  if (hasCaptions === true) return '✓'
  if (hasCaptions === false) return '✗'
  return '?'
}

/**
 * Renders a Playlist to Markdown: YAML frontmatter, an H1 title, and a
 * table-of-contents table (one row per video). Per-video URL sources are
 * created by the ingest layer, not here.
 */
export function playlistToMarkdown(playlist: Playlist, capturedAt: string): string {
  const fm = frontmatterBlock([
    ['source', 'youtube'],
    ['url', playlist.url],
    ['title', playlist.title],
    ['channel', playlist.channel],
    [CAPTURED_AT_KEY, capturedAt],
    ['truncated', playlist.truncated ?? false],
    ['video_count', playlist.videoCount],
  ])

  const header = `# ${playlist.title}`

  const tableHead = '| # | Title | Channel | Duration | Captions |'
  const tableSep = '|---|---|---|---|---|'
  const tableRows = playlist.videos.map((video) => {
    const duration =
      video.durationSeconds !== undefined ? formatDuration(video.durationSeconds) : ''
    const channel = video.channel ? escapeTableCell(video.channel) : ''
    return `| ${video.index} | ${escapeTableCell(video.title)} | ${channel} | ${duration} | ${captionsGlyph(video.hasCaptions)} |`
  })

  return [...fm, '', header, '', tableHead, tableSep, ...tableRows].join('\n')
}
