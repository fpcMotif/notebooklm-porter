import { describe, expect, it } from 'vitest'
import { diagnoseFailedSources, diagnoseSource } from './diagnose'
import type { NotebookSource, SourceKind } from './model'

function failed(kind: SourceKind, url?: string): NotebookSource {
  return {
    id: `${kind}-1`,
    title: `${kind} source`,
    kind,
    status: 'error',
    ...(url !== undefined ? { url } : {}),
  }
}

describe('diagnoseSource', () => {
  it('marks URL/Drive-backed failures as refreshable', () => {
    expect(diagnoseSource(failed('web_page', 'https://x.com')).retry).toBe('refresh')
    expect(diagnoseSource(failed('youtube', 'https://youtu.be/abc')).retry).toBe('refresh')
    expect(diagnoseSource(failed('google_docs')).retry).toBe('refresh')
  })

  it('marks pasted/uploaded failures as manual (no fetchable origin)', () => {
    expect(diagnoseSource(failed('pasted_text')).retry).toBe('manual')
    expect(diagnoseSource(failed('pdf')).retry).toBe('manual')
  })

  it('gives a kind-specific reason', () => {
    expect(diagnoseSource(failed('youtube')).reason).toMatch(/captions|private/i)
    expect(diagnoseSource(failed('web_page')).reason).toMatch(/block|sign-in|timed out/i)
  })

  it('falls back on unknown kinds using URL presence', () => {
    expect(diagnoseSource(failed('unknown', 'https://x.com')).retry).toBe('refresh')
    expect(diagnoseSource(failed('unknown')).retry).toBe('manual')
  })
})

describe('diagnoseFailedSources', () => {
  it('diagnoses only sources in the error state', () => {
    const sources: NotebookSource[] = [
      { id: 'ok', title: 'ok', kind: 'web_page', status: 'ready', url: 'https://ok.com' },
      { id: 'loading', title: 'loading', kind: 'web_page', status: 'processing' },
      failed('web_page', 'https://bad.com'),
    ]
    const diagnoses = diagnoseFailedSources(sources)
    expect(diagnoses.map((d) => d.source.id)).toEqual(['web_page-1'])
  })
})
