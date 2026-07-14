/**
 * Pure failure classification for a notebook's sources. NotebookLM's source
 * list carries a status code but no machine-readable failure *reason*, so the
 * console infers the likely cause from the source kind — the dominant real
 * failure modes are caption-less/private YouTube videos, fetch-blocked or
 * login-gated web pages, and permission-gated Drive files.
 *
 * `retry: 'refresh'` maps to the REFRESH_SOURCE RPC (re-fetch in place — only
 * URL/Drive-backed sources can be retried this way); `retry: 'manual'` marks
 * sources with no fetchable origin (pasted text, uploaded files) that the user
 * must re-add by hand.
 */
import { isFailedSource, type NotebookSource, type SourceKind } from './model'

export type RetryStrategy = 'refresh' | 'manual'

export interface SourceDiagnosis {
  source: NotebookSource
  /** Human-readable, best-effort reason the source failed to load. */
  reason: string
  /** Whether the console can auto-retry (`refresh`) or the user must re-add. */
  retry: RetryStrategy
}

function classify(kind: SourceKind, hasUrl: boolean): { reason: string; retry: RetryStrategy } {
  switch (kind) {
    case 'youtube':
      return {
        reason:
          'YouTube import failed — the video may have no captions/transcript, or be private, age-restricted, or region-locked.',
        retry: 'refresh',
      }
    case 'web_page':
      return {
        reason:
          'Web page failed to load — the site may block automated fetches, require sign-in, or have timed out.',
        retry: 'refresh',
      }
    case 'google_docs':
    case 'google_other':
      return {
        reason:
          'Google Drive source failed — the file may not be shared with this account, or was moved or deleted.',
        retry: 'refresh',
      }
    case 'pdf':
    case 'pasted_text':
    case 'generated_text':
      return {
        reason:
          'Uploaded or pasted source failed to process — it may be empty, corrupt, or too large.',
        retry: 'manual',
      }
    default:
      return hasUrl
        ? {
            reason: 'Source failed to load — retry the fetch, or remove and re-add it.',
            retry: 'refresh',
          }
        : { reason: 'Source failed to process — remove and re-add it.', retry: 'manual' }
  }
}

/** Classify one source's failure. Callers should pass a failed source. */
export function diagnoseSource(source: NotebookSource): SourceDiagnosis {
  const hasUrl = source.url !== undefined && source.url.trim() !== ''
  const { reason, retry } = classify(source.kind, hasUrl)
  return { source, reason, retry }
}

/** Diagnose every failed source in the list, preserving input order. */
export function diagnoseFailedSources(sources: readonly NotebookSource[]): SourceDiagnosis[] {
  return sources.filter(isFailedSource).map(diagnoseSource)
}
