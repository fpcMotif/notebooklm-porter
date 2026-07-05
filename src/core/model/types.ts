/**
 * Domain model. Everything the extension captures — a social thread or a
 * YouTube playlist — normalizes into these shapes before formatting, and
 * everything NotebookLM receives is rendered FROM these shapes. Extractors
 * (per-site adapters) produce them; formatters consume them; nothing else
 * in the pipeline knows site-specific structure.
 */

export type SiteId = 'youtube' | 'x' | 'reddit' | 'hackernews'

export interface Author {
  /** Display name as shown on the site ("Paul Graham"). */
  name: string
  /** Stable handle when the site has one ("@paulg", "u/spez"); omitted for HN where name IS the handle. */
  handle?: string
}

export interface MediaRef {
  kind: 'image' | 'video' | 'link-card'
  url: string
  /** Alt text / card title — kept because it carries meaning into a text-only source. */
  alt?: string
}

/**
 * One post in a discussion. Threads are stored FLAT in reading order with
 * `depth` carrying the tree shape — formatters render nesting from depth
 * alone, so no formatter ever recurses over a reply tree.
 */
export interface Post {
  id: string
  author: Author
  /** ISO 8601; optional because some surfaces (X DOM without hover) only expose relative time. */
  createdAt?: string
  /** 0 = the root post / OP. A root-author thread continuation stays depth 0. */
  depth: number
  /** Plain text with paragraph breaks preserved. Markdown-escaped at FORMAT time, not here. */
  text: string
  score?: number
  parentId?: string
  /** True for every post authored by the thread's root author (the "thread" proper on X). */
  byOp: boolean
  media?: MediaRef[]
  /** Outbound links found in the post, absolute URLs, in appearance order. */
  links?: string[]
}

export interface Thread {
  site: SiteId
  /** Canonical permalink of the root post. */
  url: string
  title: string
  author: Author
  createdAt?: string
  posts: Post[]
  stats?: {
    score?: number
    replyCount?: number
  }
  /**
   * True when the capture is known to be partial (collapsed "more replies"
   * stubs left unexpanded, X pagination stopped early). Formatters surface
   * this in the document header so NotebookLM answers don't silently treat
   * a fragment as the whole discussion.
   */
  truncated?: boolean
}

export interface VideoEntry {
  videoId: string
  /** Canonical watch URL WITHOUT playlist params — NotebookLM should see one video per source. */
  url: string
  title: string
  channel?: string
  durationSeconds?: number
  /** 1-based position in the playlist. */
  index: number
  /**
   * Whether the video exposes captions — NotebookLM ingests YouTube via
   * transcript, so a caption-less video will fail there. Undefined = unknown
   * (we only learn it by probing the watch page, which is opt-in).
   */
  hasCaptions?: boolean
}

export interface Playlist {
  playlistId: string
  url: string
  title: string
  channel?: string
  videoCount: number
  videos: VideoEntry[]
  /** True when continuation fetching stopped before the full list was resolved. */
  truncated?: boolean
}

/** What an adapter produced from one capture action. */
export type Capture = { kind: 'thread'; thread: Thread } | { kind: 'playlist'; playlist: Playlist }

/**
 * A NotebookLM-ready document: the unit that gets ingested (pasted text /
 * .md file) or exported. Rendered once at capture time and stored, so
 * ingest/export never needs the original Thread.
 */
export interface SourceDoc {
  /** Stable id: `${site}:${nativeId}` — used for dedup across re-captures. */
  id: string
  site: SiteId
  kind: 'thread' | 'playlist'
  title: string
  canonicalUrl: string
  capturedAt: string
  markdown: string
  /** JSONL rendering (one JSON object per post/video per line); produced on demand for power users. */
  jsonl?: string
  wordCount: number
  truncated: boolean
}
