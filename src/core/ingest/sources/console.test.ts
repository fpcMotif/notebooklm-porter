import { describe, expect, it } from 'vitest'
import { scanSources } from './console'
import type { NotebookSource } from './model'

const sources: NotebookSource[] = [
  { id: 'a1', title: 'A', kind: 'web_page', status: 'ready', url: 'https://a.com' },
  { id: 'a2', title: 'A dup', kind: 'web_page', status: 'ready', url: 'https://a.com' },
  { id: 'bad', title: 'Broken', kind: 'web_page', status: 'error', url: 'https://bad.com' },
]

describe('scanSources', () => {
  it('bundles duplicate groups, failed diagnoses, and a removal count', () => {
    const scan = scanSources(sources)
    expect(scan.duplicateGroups).toHaveLength(1)
    expect(scan.duplicateCount).toBe(1)
    expect(scan.duplicateGroups[0]?.remove.map((s) => s.id)).toEqual(['a2'])
    expect(scan.failed.map((d) => d.source.id)).toEqual(['bad'])
    expect(scan.sources).toBe(sources)
  })

  it('reports a clean notebook with zero duplicates and no failures', () => {
    const scan = scanSources([sources[0] as NotebookSource])
    expect(scan.duplicateGroups).toEqual([])
    expect(scan.duplicateCount).toBe(0)
    expect(scan.failed).toEqual([])
  })
})
