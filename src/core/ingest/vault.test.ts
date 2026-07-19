import { describe, expect, it } from 'vitest'
import type { SiteId, SourceDoc } from '../model/types'
import { VAULT_ROOT, vaultLayout } from './vault'

/**
 * Builds a minimal, well-typed SourceDoc for layout tests. `site` picks the
 * matching union member (playlist/video for youtube, web for web, thread for
 * the social sites) so the fixture stays honest under the strict model types —
 * vaultLayout only reads `id`, `site`, and `title`.
 */
function makeDoc(overrides: { id: string; site?: SiteId; title?: string }): SourceDoc {
  const base = {
    id: overrides.id,
    title: overrides.title ?? 'Untitled',
    canonicalUrl: 'https://example.com',
    capturedAt: '2026-07-19T00:00:00.000Z',
    markdown: '# doc',
    wordCount: 1,
    truncated: false,
  }
  const site = overrides.site ?? 'reddit'
  if (site === 'youtube') return { ...base, site, kind: 'playlist', playlistVideos: [] }
  if (site === 'web') return { ...base, site, kind: 'web' }
  return { ...base, site, kind: 'thread' }
}

describe('vaultLayout', () => {
  it('lays each doc out under "<VAULT_ROOT>/<site>/<safe-title>.md"', () => {
    const doc = makeDoc({ id: 'reddit:a', site: 'reddit', title: 'My Great Thread' })
    const layout = vaultLayout([doc])
    expect(layout.get('reddit:a')).toBe(`${VAULT_ROOT}/reddit/My Great Thread.md`)
  })

  it('groups by site into separate subfolders', () => {
    const docs = [
      makeDoc({ id: 'youtube:a', site: 'youtube', title: 'Playlist' }),
      makeDoc({ id: 'x:a', site: 'x', title: 'Playlist' }),
    ]
    const layout = vaultLayout(docs)
    expect(layout.get('youtube:a')).toBe(`${VAULT_ROOT}/youtube/Playlist.md`)
    expect(layout.get('x:a')).toBe(`${VAULT_ROOT}/x/Playlist.md`)
  })

  it('strips path-hostile characters from the title the same way exportFilename does', () => {
    const doc = makeDoc({ id: 'reddit:a', title: 'a/b\\c:d' })
    const layout = vaultLayout([doc])
    expect(layout.get('reddit:a')).toBe(`${VAULT_ROOT}/reddit/a-b-c-d.md`)
  })

  it('caps the title length', () => {
    const doc = makeDoc({ id: 'reddit:a', title: 'x'.repeat(300) })
    const layout = vaultLayout([doc])
    expect(layout.get('reddit:a')).toBe(`${VAULT_ROOT}/reddit/${'x'.repeat(100)}.md`)
  })

  it('falls back to "source" for an empty/whitespace-only title', () => {
    const doc = makeDoc({ id: 'reddit:a', title: '   ' })
    const layout = vaultLayout([doc])
    expect(layout.get('reddit:a')).toBe(`${VAULT_ROOT}/reddit/source.md`)
  })

  it('dedupes same-folder collisions with a numeric suffix in first-seen order', () => {
    const docs = [
      makeDoc({ id: 'reddit:a', title: 'Duplicate' }),
      makeDoc({ id: 'reddit:b', title: 'Duplicate' }),
      makeDoc({ id: 'reddit:c', title: 'Duplicate' }),
    ]
    const layout = vaultLayout(docs)
    expect(layout.get('reddit:a')).toBe(`${VAULT_ROOT}/reddit/Duplicate.md`)
    expect(layout.get('reddit:b')).toBe(`${VAULT_ROOT}/reddit/Duplicate (1).md`)
    expect(layout.get('reddit:c')).toBe(`${VAULT_ROOT}/reddit/Duplicate (2).md`)
  })

  it('does not treat same-title docs on different sites as colliding', () => {
    const docs = [
      makeDoc({ id: 'reddit:a', site: 'reddit', title: 'Same Title' }),
      makeDoc({ id: 'x:a', site: 'x', title: 'Same Title' }),
    ]
    const layout = vaultLayout(docs)
    expect(layout.get('reddit:a')).toBe(`${VAULT_ROOT}/reddit/Same Title.md`)
    expect(layout.get('x:a')).toBe(`${VAULT_ROOT}/x/Same Title.md`)
  })

  it('produces the same layout for the same input order (idempotent re-export)', () => {
    const docs = [
      makeDoc({ id: 'reddit:a', title: 'Dup' }),
      makeDoc({ id: 'reddit:b', title: 'Dup' }),
    ]
    const first = vaultLayout(docs)
    const second = vaultLayout(docs)
    expect(second).toEqual(first)
  })

  it('returns an empty map for an empty doc list', () => {
    expect(vaultLayout([]).size).toBe(0)
  })
})
