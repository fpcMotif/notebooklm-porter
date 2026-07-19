/** Pure normalization for page, selection, and link context-menu captures. */

import { sha256Base64Url } from '../crypto'
import type { WebCapture as DomainWebCapture } from '../model/types'

/** Page text is bounded before it becomes a persisted extension document. */
export const MAX_PAGE_TEXT_LENGTH = 100_000

export type WebCaptureMode = 'selection' | 'page' | 'link'

/** The small, browser-derived input accepted by the context-menu handler. */
export interface WebCaptureInput {
  url: string
  title?: string
  mode: WebCaptureMode
  text: string
}

/** Shared domain shape built from untrusted browser context-menu input. */
export type WebCapture = DomainWebCapture

function normalizeInlineWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Returns a canonical HTTP(S) URL, or undefined for non-web/invalid input. */
export function normalizeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

/** Collapses title whitespace and uses a caller-provided nonempty fallback. */
export function normalizeWebTitle(value: string | undefined, fallback: string): string {
  return value === undefined ? fallback : normalizeInlineWhitespace(value) || fallback
}

/**
 * Normalizes horizontal whitespace while retaining single line breaks and one
 * blank line between paragraphs. Leading/trailing whitespace is removed.
 */
export function normalizeWebText(value: string): string {
  const lines = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\r\n]+/g, ' ').trim())

  const normalized: string[] = []
  let sawParagraphBreak = false

  for (const line of lines) {
    if (line === '') {
      sawParagraphBreak = normalized.length > 0
      continue
    }
    if (sawParagraphBreak) normalized.push('')
    normalized.push(line)
    sawParagraphBreak = false
  }

  return normalized.join('\n')
}

function pageText(value: string): string {
  return value.length > MAX_PAGE_TEXT_LENGTH
    ? value.slice(0, MAX_PAGE_TEXT_LENGTH).trimEnd()
    : value
}

/**
 * Stable ids replace repeated page/link snapshots, while distinct selections
 * from the same page remain independently capturable.
 */
export async function webCaptureId(
  mode: WebCaptureMode,
  url: string,
  text: string,
): Promise<string> {
  const fingerprint = mode === 'selection' ? `${url}\n${text}` : url
  return `${mode}:${await sha256Base64Url(fingerprint)}`
}

/**
 * Validates and normalizes a browser context-menu payload. Undefined means
 * that it is not safe or useful to persist as a generic web source.
 */
export async function createWebCapture(input: WebCaptureInput): Promise<WebCapture | undefined> {
  const url = normalizeHttpUrl(input.url)
  if (!url) return undefined

  const normalizedText = normalizeWebText(input.text)
  const text = input.mode === 'page' ? pageText(normalizedText) : normalizedText
  if (!text) return undefined

  return {
    id: await webCaptureId(input.mode, url, text),
    url,
    title: normalizeWebTitle(input.title, new URL(url).hostname),
    mode: input.mode,
    text,
  }
}
