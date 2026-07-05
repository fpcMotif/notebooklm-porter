import type { Capture } from '../../model/types'

/**
 * Capture a Reddit discussion via the public `.json` view of the post URL,
 * flattening the t3 (post) + t1 (comment) tree into ordered Posts and
 * expanding `more` stubs up to a budget.
 *
 * TODO(codegen): implement per docs/superpowers/specs design §Reddit.
 */
export async function captureRedditThread(url: string): Promise<Capture> {
  throw new Error(`not implemented: captureRedditThread(${url})`)
}
