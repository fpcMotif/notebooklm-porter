import { describe, expect, it } from 'vitest'
import {
  MAX_PAGE_TEXT_LENGTH,
  createWebCapture,
  normalizeHttpUrl,
  normalizeWebText,
  normalizeWebTitle,
  webCaptureId,
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
  it('creates a normalized page capture with a stable page-scoped id', async () => {
    const capture = await createWebCapture({
      url: 'https://example.com/article',
      title: '  A   useful  article ',
      mode: 'page',
      text: ' First paragraph\n\nSecond paragraph ',
    })

    expect(capture).toEqual({
      id: expect.stringMatching(/^page:[A-Za-z0-9_-]{43}$/),
      url: 'https://example.com/article',
      title: 'A useful article',
      mode: 'page',
      text: 'First paragraph\n\nSecond paragraph',
    })
  })

  it('uses a hostname fallback when a link has no title', async () => {
    const link = await createWebCapture({
      url: 'https://example.com/linked',
      title: '',
      mode: 'link',
      text: 'Linked page',
    })

    expect(link).toMatchObject({ title: 'example.com' })
  })

  it('rejects invalid URLs and normalized-empty text', async () => {
    expect(
      await createWebCapture({
        url: 'ftp://example.com',
        title: 'Nope',
        mode: 'page',
        text: 'Text',
      }),
    ).toBeUndefined()
    expect(
      await createWebCapture({
        url: 'https://example.com',
        title: 'Empty',
        mode: 'selection',
        text: ' \n\t ',
      }),
    ).toBeUndefined()
  })

  it('caps only page text at the named limit', async () => {
    const longText = 'x'.repeat(MAX_PAGE_TEXT_LENGTH + 25)
    const page = await createWebCapture({
      url: 'https://example.com/page',
      title: 'Page',
      mode: 'page',
      text: longText,
    })
    const selection = await createWebCapture({
      url: 'https://example.com/page',
      title: 'Page',
      mode: 'selection',
      text: longText,
    })

    expect(page?.text).toHaveLength(MAX_PAGE_TEXT_LENGTH)
    expect(selection?.text).toHaveLength(MAX_PAGE_TEXT_LENGTH + 25)
  })

  it('uses URL-only identities for page/link and selection text for selections', async () => {
    const pageOne = await createWebCapture({
      url: 'https://example.com/article',
      title: 'Article',
      mode: 'page',
      text: 'First snapshot',
    })
    const pageTwo = await createWebCapture({
      url: 'https://example.com/article',
      title: 'Article',
      mode: 'page',
      text: 'Second snapshot',
    })
    const linkOne = await createWebCapture({
      url: 'https://example.com/article',
      title: 'Article',
      mode: 'link',
      text: 'First link label',
    })
    const linkTwo = await createWebCapture({
      url: 'https://example.com/article',
      title: 'Article',
      mode: 'link',
      text: 'Second link label',
    })
    const selectionOne = await createWebCapture({
      url: 'https://example.com/article',
      title: 'Article',
      mode: 'selection',
      text: 'First selection',
    })
    const selectionTwo = await createWebCapture({
      url: 'https://example.com/article',
      title: 'Article',
      mode: 'selection',
      text: 'Second selection',
    })

    expect(pageOne?.id).toBe(pageTwo?.id)
    expect(linkOne?.id).toBe(linkTwo?.id)
    expect(selectionOne?.id).not.toBe(selectionTwo?.id)
  })

  it('uses stable, full-digest ids', async () => {
    const first = await webCaptureId('page', 'https://example.com/article', 'first snapshot')
    const second = await webCaptureId('page', 'https://example.com/article', 'second snapshot')
    const otherUrl = await webCaptureId('page', 'https://example.com/other', 'first snapshot')

    expect(first).toMatch(/^page:[A-Za-z0-9_-]{43}$/)
    expect(second).toBe(first)
    expect(otherUrl).not.toBe(first)
  })
})
