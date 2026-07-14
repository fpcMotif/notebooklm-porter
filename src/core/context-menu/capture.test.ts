import { describe, expect, it } from 'vitest'
import {
  MAX_PAGE_TEXT_LENGTH,
  createWebCapture,
  normalizeHttpUrl,
  normalizeWebText,
  normalizeWebTitle,
} from './capture'

describe('normalizeHttpUrl', () => {
  it('trims and canonicalizes HTTP(S) URLs', () => {
    expect(normalizeHttpUrl('  HTTPS://Example.COM:443/a?q=1  ')).toBe('https://example.com/a?q=1')
  })

  it('rejects malformed and non-web URLs', () => {
    expect(normalizeHttpUrl('not a url')).toBeUndefined()
    expect(normalizeHttpUrl('file:///private/secret')).toBeUndefined()
    expect(normalizeHttpUrl('mailto:hello@example.com')).toBeUndefined()
  })
})

describe('text normalization', () => {
  it('collapses horizontal whitespace while preserving paragraph breaks', () => {
    expect(normalizeWebText('  First\tline \r\n\r\n\r\n Second   paragraph  ')).toBe(
      'First line\n\nSecond paragraph',
    )
  })

  it('uses the fallback when a title has no content', () => {
    expect(normalizeWebTitle('  An\narticle  ', 'example.com')).toBe('An article')
    expect(normalizeWebTitle(' \t ', 'example.com')).toBe('example.com')
  })
})

describe('createWebCapture', () => {
  it('creates a normalized page capture with a stable page-scoped id', () => {
    const capture = createWebCapture({
      url: 'https://example.com/article',
      title: '  A   useful  article ',
      mode: 'page',
      text: ' First paragraph\n\nSecond paragraph ',
    })

    expect(capture).toEqual({
      id: expect.stringMatching(/^page:[0-9a-f]{8}$/),
      url: 'https://example.com/article',
      title: 'A useful article',
      mode: 'page',
      text: 'First paragraph\n\nSecond paragraph',
    })
  })

  it('uses a hostname fallback when a link has no title', () => {
    const link = createWebCapture({
      url: 'https://example.com/linked',
      title: '',
      mode: 'link',
      text: 'Linked page',
    })

    expect(link).toMatchObject({ title: 'example.com' })
  })

  it('rejects invalid URLs and normalized-empty text', () => {
    expect(
      createWebCapture({ url: 'ftp://example.com', title: 'Nope', mode: 'page', text: 'Text' }),
    ).toBeUndefined()
    expect(
      createWebCapture({
        url: 'https://example.com',
        title: 'Empty',
        mode: 'selection',
        text: ' \n\t ',
      }),
    ).toBeUndefined()
  })

  it('caps only page text at the named limit', () => {
    const longText = 'x'.repeat(MAX_PAGE_TEXT_LENGTH + 25)
    const page = createWebCapture({
      url: 'https://example.com/page',
      title: 'Page',
      mode: 'page',
      text: longText,
    })
    const selection = createWebCapture({
      url: 'https://example.com/page',
      title: 'Page',
      mode: 'selection',
      text: longText,
    })

    expect(page?.text).toHaveLength(MAX_PAGE_TEXT_LENGTH)
    expect(selection?.text).toHaveLength(MAX_PAGE_TEXT_LENGTH + 25)
  })

  it('uses URL-only identities for page/link and selection text for selections', () => {
    const pageOne = createWebCapture({
      url: 'https://example.com/article',
      title: 'Article',
      mode: 'page',
      text: 'First snapshot',
    })
    const pageTwo = createWebCapture({
      url: 'https://example.com/article',
      title: 'Article',
      mode: 'page',
      text: 'Second snapshot',
    })
    const selectionOne = createWebCapture({
      url: 'https://example.com/article',
      title: 'Article',
      mode: 'selection',
      text: 'First selection',
    })
    const selectionTwo = createWebCapture({
      url: 'https://example.com/article',
      title: 'Article',
      mode: 'selection',
      text: 'Second selection',
    })

    expect(pageOne?.id).toBe(pageTwo?.id)
    expect(selectionOne?.id).not.toBe(selectionTwo?.id)
  })
})
