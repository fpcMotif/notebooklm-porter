import type { Playlist, Post, Thread } from '../model/types'

/**
 * One JSON object per Post per line, in the thread's existing flat reading
 * order (no re-sorting, no depth filtering — that's the Markdown renderer's
 * job via FormatOptions). Power-user export only; never fed to NotebookLM.
 */
export function threadToJsonl(thread: Thread): string {
  return thread.posts.map((post) => JSON.stringify(postToRecord(post))).join('\n')
}

function postToRecord(post: Post) {
  return {
    id: post.id,
    author: post.author,
    depth: post.depth,
    byOp: post.byOp,
    createdAt: post.createdAt,
    text: post.text,
    score: post.score,
    parentId: post.parentId,
  }
}

/** One JSON object per VideoEntry per line, in playlist order. */
export function playlistToJsonl(playlist: Playlist): string {
  return playlist.videos.map((video) => JSON.stringify(video)).join('\n')
}
