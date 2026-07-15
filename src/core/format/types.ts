export interface FormatOptions {
  /**
   * Posts below this score are dropped from thread renders (never the OP
   * chain). Default 0 = keep everything.
   */
  minScore?: number
  /** Cap reply depth; deeper posts are dropped. Default: unlimited. */
  maxDepth?: number
  /** Include per-post permalinks in the render. Default false — they add noise NotebookLM doesn't need. */
  permalinks?: boolean
}
