import type { Capture } from '../../model/types'

/**
 * Capture a YouTube playlist from its URL: fetch the playlist page,
 * parse ytInitialData for the first ~100 entries, then walk InnerTube
 * browse continuations for the rest.
 *
 * TODO(codegen): implement per docs/superpowers/specs design §YouTube.
 */
export async function capturePlaylist(url: string): Promise<Capture> {
  throw new Error(`not implemented: capturePlaylist(${url})`)
}
