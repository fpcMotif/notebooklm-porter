import { describe, expect, it } from 'vitest'
import { CAPTURED_AT_KEY, frontmatterBlock, splitFrontmatter, yamlScalar } from './frontmatter'

describe('CAPTURED_AT_KEY', () => {
  it('is the literal frontmatter key name', () => {
    expect(CAPTURED_AT_KEY).toBe('captured_at')
  })
})

describe('yamlScalar', () => {
  it('quotes the empty string', () => {
    expect(yamlScalar('')).toBe('""')
  })

  it('leaves plain values unquoted', () => {
    expect(yamlScalar('Channel')).toBe('Channel')
    expect(yamlScalar('hello world')).toBe('hello world')
  })

  it('quotes values containing a colon', () => {
    expect(yamlScalar('A: video')).toBe('"A: video"')
  })

  it('quotes and escapes values containing double quotes', () => {
    expect(yamlScalar('say "hi"')).toBe('"say \\"hi\\""')
  })

  it('leaves a lone backslash unquoted (not itself a quoting trigger)', () => {
    expect(yamlScalar('a\\b')).toBe('a\\b')
  })

  it('escapes backslashes once quoting is triggered by another special character', () => {
    expect(yamlScalar('C:\\Users')).toBe('"C:\\\\Users"')
  })

  it('quotes values containing a newline, leaving the newline byte itself untouched', () => {
    expect(yamlScalar('line one\nline two')).toBe('"line one\nline two"')
  })

  it('quotes values with leading or trailing whitespace', () => {
    expect(yamlScalar(' leading')).toBe('" leading"')
    expect(yamlScalar('trailing ')).toBe('"trailing "')
  })

  it('quotes values containing other YAML-special characters', () => {
    expect(yamlScalar('a?b')).toBe('"a?b"')
    expect(yamlScalar('a#b')).toBe('"a#b"')
    expect(yamlScalar('a-b')).toBe('"a-b"')
    expect(yamlScalar('[bracket]')).toBe('"[bracket]"')
  })
})

describe('frontmatterBlock', () => {
  it('wraps fields in --- delimiters and escapes string values', () => {
    expect(
      frontmatterBlock([
        ['source', 'youtube'],
        ['title', 'A: video'],
        ['video_count', 3],
        ['truncated', false],
      ]),
    ).toEqual([
      '---',
      'source: youtube',
      'title: "A: video"',
      'video_count: 3',
      'truncated: false',
      '---',
    ])
  })

  it('omits fields whose value is undefined', () => {
    expect(
      frontmatterBlock([
        ['source', 'reddit'],
        ['score', undefined],
      ]),
    ).toEqual(['---', 'source: reddit', '---'])
  })
})

describe('splitFrontmatter', () => {
  it('splits a terminated frontmatter block from the body', () => {
    const markdown = '---\nsource: web\ncaptured_at: 2026-07-11T00:00:00.000Z\n---\n\nBody text'
    expect(splitFrontmatter(markdown)).toEqual({
      frontmatterLines: ['---', 'source: web', 'captured_at: 2026-07-11T00:00:00.000Z'],
      body: '\n\nBody text',
    })
  })

  it('returns undefined when there is no leading frontmatter', () => {
    expect(splitFrontmatter('# Just a body\n\nNo frontmatter at all.')).toBeUndefined()
  })

  it('returns undefined when the frontmatter is unterminated', () => {
    expect(splitFrontmatter('---\nsource: web\n\n# Title\n\nBody')).toBeUndefined()
  })

  it('returns undefined for an empty string', () => {
    expect(splitFrontmatter('')).toBeUndefined()
  })
})
