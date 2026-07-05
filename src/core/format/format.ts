import type { Capture, SourceDoc } from '../model/types'
import type { FormatOptions } from './types'

/**
 * Render a Capture into its stored SourceDoc (markdown + jsonl + counts).
 *
 * TODO(codegen): implement per docs/superpowers/specs design §Formatting —
 * thread renders and playlist renders live in ./markdown.ts and ./jsonl.ts.
 */
export function formatCapture(capture: Capture, options?: FormatOptions): SourceDoc {
  void options
  throw new Error(`not implemented: formatCapture(${capture.kind})`)
}
