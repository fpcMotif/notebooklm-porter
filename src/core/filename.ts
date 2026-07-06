/**
 * Shared filesystem-safe filename sanitizer. Extracted so every place that
 * turns a free-text title into a download/upload filename (local export,
 * Drive backup) agrees on what "hostile" means, without forcing them to
 * share a cap or fallback — those stay call-site config.
 */

// Path separators + Windows-reserved glyphs, plus non-whitespace C0 control
// chars and DEL. Tab/newline/CR are handled by the whitespace collapse below
// instead of being turned into visible hyphens.
// eslint-disable-next-line no-control-regex
const FILESYSTEM_HOSTILE = /[/\\:*?"<>|\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/**
 * Collapses whitespace, replaces hostile characters with '-', trims, and
 * caps length. Returns '' when nothing survives — callers supply their own
 * fallback name.
 */
export function sanitizeFilenameBase(title: string, capLength: number): string {
  return title
    .replace(/\s+/g, ' ')
    .replace(FILESYSTEM_HOSTILE, '-')
    .trim()
    .slice(0, capLength)
    .trim()
}
