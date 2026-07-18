/**
 * The one module that owns the YAML frontmatter contract shared by every
 * Markdown writer (thread/playlist/web/video/transcript) and the two readers
 * that re-scan it (word count, ingest content hash). Rendering and parsing
 * stay next to each other so the boundary they agree on — a leading
 * `---\n...\n---` block — can't drift between "what we write" and "what we
 * scan back out".
 */

/** The frontmatter key that records when Porter captured a source. */
export const CAPTURED_AT_KEY = 'captured_at'

/** Minimal YAML scalar escaping — wrap in double quotes if it needs it. */
export function yamlScalar(value: string): string {
  if (value === '') return '""'
  const needsQuoting = /[:#?\-[\]{}&*!|>'"%@`\n]/.test(value) || /^\s|\s$/.test(value)
  if (!needsQuoting) return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export type FrontmatterValue = string | number | boolean

/**
 * Renders a `---`-delimited frontmatter block. String values are escaped via
 * `yamlScalar`; number/boolean values are stringified as-is. A field whose
 * value is `undefined` is omitted entirely (used for optional metadata like
 * a post's score).
 */
export function frontmatterBlock(
  fields: ReadonlyArray<readonly [string, FrontmatterValue | undefined]>,
): string[] {
  const lines = ['---']
  for (const [key, value] of fields) {
    if (value === undefined) continue
    lines.push(`${key}: ${typeof value === 'string' ? yamlScalar(value) : String(value)}`)
  }
  lines.push('---')
  return lines
}

export interface FrontmatterSplit {
  /** Lines from (and including) the opening `---` up to, but not including, the closing `---`. */
  frontmatterLines: string[]
  /** Everything after the closing `---` line, unaltered (not trimmed). */
  body: string
}

/**
 * Splits a leading `---\n...\n---` frontmatter block from the rest of the
 * document. Returns undefined both when there is no leading `---\n` and
 * when the frontmatter is unterminated (no closing `\n---` found) — in
 * both cases callers fall back to treating the whole input as undifferentiated
 * content, matching this module's two readers' pre-existing behavior.
 */
export function splitFrontmatter(markdown: string): FrontmatterSplit | undefined {
  if (!markdown.startsWith('---\n')) return undefined
  const closingIndex = markdown.indexOf('\n---', 4)
  if (closingIndex === -1) return undefined
  return {
    frontmatterLines: markdown.slice(0, closingIndex).split('\n'),
    body: markdown.slice(closingIndex + 4),
  }
}
