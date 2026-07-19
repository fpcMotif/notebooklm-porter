import type { Playlist, Post, Thread } from '../model/types'

/**
 * One JSON object per Post per line, in the thread's existing flat reading
 * order (no re-sorting, no depth filtering — that's the Markdown renderer's
 * job via FormatOptions). Power-user export only; never fed to NotebookLM.
 */
export function threadToJsonl(thread: Thread): string {
  return thread.posts.map((post) => JSON.stringify(postToJsonlRecord(post))).join('\n')
}

function postToJsonlRecord(post: Post): Post {
  return {
    ...post,
    author: { ...post.author },
    ...(post.media !== undefined ? { media: post.media.map((media) => ({ ...media })) } : {}),
    ...(post.links !== undefined ? { links: [...post.links] } : {}),
  }
}

/** One JSON object per VideoEntry per line, in playlist order. */
export function playlistToJsonl(playlist: Playlist): string {
  return playlist.videos.map((video) => JSON.stringify(video)).join('\n')
}
