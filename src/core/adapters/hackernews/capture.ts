import type { Capture } from '../../model/types'

/**
 * Capture a Hacker News discussion via the Algolia items API
 * (`https://hn.algolia.com/api/v1/items/{id}`), which returns the whole
 * nested comment tree in one request.
 *
 * TODO(codegen): implement per docs/superpowers/specs design §HackerNews.
 */
export async function captureHnThread(url: string): Promise<Capture> {
  throw new Error(`not implemented: captureHnThread(${url})`)
}
