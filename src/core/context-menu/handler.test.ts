import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Result } from 'effect'
import type { DebugEntry } from '../debug'
import { HttpStatusError } from '../fx/errors'
import { debugLogTest, kvTest, scriptingTest } from '../fx/testing'
import { Http } from '../fx/services'
import { listDocs } from '../store'
import { captureContextMenuClick, CONTEXT_MENU_IDS, isContextMenuId } from './handler'

const HN_ITEM = {
  id: 42,
  author: 'op',
  title: 'An HN discussion',
  text: '<p>Thread body',
  children: [],
}

function layer(
  opts: {
    page?: { title: string; text: string }
    hn?: boolean
    hnFailure?: HttpStatusError
    debugSink?: DebugEntry[]
  } = {},
) {
  return Layer.mergeAll(
    kvTest(),
    debugLogTest(opts.debugSink ?? []),
    scriptingTest({ onExtractPageText: () => opts.page ?? { title: '', text: '' } }),
    Layer.succeed(
      Http,
      Http.of({
        text: () => Effect.die('unused by context-menu handler test'),
        json: () => {
          if (opts.hnFailure !== undefined) return Effect.fail(opts.hnFailure)
          return opts.hn ? Effect.succeed(HN_ITEM) : Effect.die('unexpected adapter fetch in test')
        },
      }),
    ),
  )
}

describe('captureContextMenuClick', () => {
  it.effect('stores a normalized selection as a web source', () =>
    Effect.gen(function* () {
      const testLayer = layer()
      const doc = yield* captureContextMenuClick({
        menuId: CONTEXT_MENU_IDS.selection,
        pageUrl: 'https://example.com/article',
        pageTitle: ' An article ',
        selectionText: '  selected   text ',
      }).pipe(Effect.provide(testLayer))

      assert.strictEqual(doc?.kind, 'web')
      assert.strictEqual(doc?.site, 'web')
      assert.include(doc?.markdown ?? '', 'selected text')
      const stored = yield* listDocs().pipe(Effect.provide(testLayer))
      assert.deepStrictEqual(stored, doc === undefined ? [] : [doc])
    }),
  )

  it.effect('uses active-tab scripting for page capture', () =>
    Effect.gen(function* () {
      const doc = yield* captureContextMenuClick({
        menuId: CONTEXT_MENU_IDS.page,
        tabId: 9,
        pageUrl: 'https://example.com/article',
      }).pipe(Effect.provide(layer({ page: { title: 'Readable article', text: 'Page body' } })))

      assert.strictEqual(doc?.title, 'Readable article')
      assert.include(doc?.markdown ?? '', '## Page content')
    }),
  )

  it.effect('falls back to generic capture for content-script-only X links', () =>
    Effect.gen(function* () {
      const doc = yield* captureContextMenuClick({
        menuId: CONTEXT_MENU_IDS.link,
        linkUrl: 'https://x.com/porter/status/123',
      }).pipe(Effect.provide(layer()))

      assert.strictEqual(doc?.kind, 'web')
      assert.strictEqual(doc?.canonicalUrl, 'https://x.com/porter/status/123')
      assert.include(doc?.markdown ?? '', 'https://x.com/porter/status/123')
    }),
  )

  it.effect('uses a background URL adapter for a supported linked discussion', () =>
    Effect.gen(function* () {
      const doc = yield* captureContextMenuClick({
        menuId: CONTEXT_MENU_IDS.link,
        linkUrl: 'https://news.ycombinator.com/item?id=42',
      }).pipe(Effect.provide(layer({ hn: true })))

      assert.strictEqual(doc?.site, 'hackernews')
      assert.strictEqual(doc?.kind, 'thread')
    }),
  )

  it.effect('propagates a supported link capture failure instead of storing a generic URL', () =>
    Effect.gen(function* () {
      const testLayer = layer({
        hnFailure: new HttpStatusError({
          url: 'https://hn.algolia.com/api/v1/items/42',
          status: 503,
        }),
      })
      const result = yield* Effect.result(
        captureContextMenuClick({
          menuId: CONTEXT_MENU_IDS.link,
          linkUrl: 'https://news.ycombinator.com/item?id=42',
        }).pipe(Effect.provide(testLayer)),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, HttpStatusError)
      assert.deepStrictEqual(yield* listDocs().pipe(Effect.provide(testLayer)), [])
    }),
  )

  it.effect('does not store empty or malformed generic captures', () =>
    Effect.gen(function* () {
      const testLayer = layer()
      const doc = yield* captureContextMenuClick({
        menuId: CONTEXT_MENU_IDS.selection,
        pageUrl: 'https://example.com',
        selectionText: '   ',
      }).pipe(Effect.provide(testLayer))

      assert.isUndefined(doc)
      assert.deepStrictEqual(yield* listDocs().pipe(Effect.provide(testLayer)), [])
    }),
  )

  it.effect('a stored selection now logs a content-free "capture stored" debug entry', () =>
    Effect.gen(function* () {
      const debugSink: DebugEntry[] = []
      const doc = yield* captureContextMenuClick({
        menuId: CONTEXT_MENU_IDS.selection,
        pageUrl: 'https://example.com/article',
        pageTitle: 'An article',
        selectionText: 'selected text',
      }).pipe(Effect.provide(layer({ debugSink })))

      assert.isDefined(doc)
      assert.isTrue(debugSink.some((entry) => entry.scope === 'capture' && entry.msg === 'stored'))
    }),
  )
})

describe('isContextMenuId', () => {
  it('accepts only Porter menu ids', () => {
    assert.isTrue(isContextMenuId(CONTEXT_MENU_IDS.page))
    assert.isFalse(isContextMenuId('other-menu'))
  })
})
