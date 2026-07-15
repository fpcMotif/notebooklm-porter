import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { DebugEntry } from './debug'
import { debugLogTest, kvTest } from './fx/testing'
import { deleteDoc, listDocs, storeCapturedDoc, upsertDoc } from './store'
import type { SourceDoc } from './model/types'

function makeDoc(overrides: Partial<SourceDoc> & Pick<SourceDoc, 'id' | 'capturedAt'>): SourceDoc {
  return {
    site: 'reddit',
    kind: 'thread',
    title: 'Untitled',
    canonicalUrl: 'https://example.com',
    markdown: '# doc',
    wordCount: 1,
    truncated: false,
    ...overrides,
  }
}

describe('store', () => {
  it.effect('listDocs returns an empty array when nothing is stored', () =>
    Effect.gen(function* () {
      const docs = yield* listDocs()
      assert.deepStrictEqual(docs, [])
    }).pipe(Effect.provide(kvTest())),
  )

  it.effect('upsertDoc adds a new doc, sorted newest-first by capturedAt', () =>
    Effect.gen(function* () {
      const older = makeDoc({ id: 'a', capturedAt: '2026-01-01T00:00:00.000Z' })
      const newer = makeDoc({ id: 'b', capturedAt: '2026-02-01T00:00:00.000Z' })
      yield* upsertDoc(older)
      yield* upsertDoc(newer)
      const docs = yield* listDocs()
      assert.deepStrictEqual(
        docs.map((d) => d.id),
        ['b', 'a'],
      )
    }).pipe(Effect.provide(kvTest())),
  )

  it.effect('upsertDoc with an existing id REPLACES the stale doc instead of duplicating', () =>
    Effect.gen(function* () {
      const original = makeDoc({ id: 'a', capturedAt: '2026-01-01T00:00:00.000Z', title: 'Old' })
      const recaptured = makeDoc({ id: 'a', capturedAt: '2026-03-01T00:00:00.000Z', title: 'New' })
      yield* upsertDoc(original)
      yield* upsertDoc(recaptured)
      const docs = yield* listDocs()
      assert.strictEqual(docs.length, 1)
      assert.strictEqual(docs[0]?.title, 'New')
    }).pipe(Effect.provide(kvTest())),
  )

  it.effect('deleteDoc removes only the matching doc', () =>
    Effect.gen(function* () {
      const a = makeDoc({ id: 'a', capturedAt: '2026-01-01T00:00:00.000Z' })
      const b = makeDoc({ id: 'b', capturedAt: '2026-02-01T00:00:00.000Z' })
      yield* upsertDoc(a)
      yield* upsertDoc(b)
      yield* deleteDoc('a')
      const docs = yield* listDocs()
      assert.deepStrictEqual(
        docs.map((d) => d.id),
        ['b'],
      )
    }).pipe(Effect.provide(kvTest())),
  )

  it.effect('storeCapturedDoc upserts the doc and logs a content-free "stored" entry', () =>
    Effect.gen(function* () {
      const debugSink: DebugEntry[] = []
      const doc = makeDoc({ id: 'a', capturedAt: '2026-01-01T00:00:00.000Z' })
      yield* storeCapturedDoc(doc).pipe(Effect.provide(debugLogTest(debugSink)))
      const docs = yield* listDocs()
      assert.deepStrictEqual(
        docs.map((d) => d.id),
        ['a'],
      )
      assert.strictEqual(debugSink.length, 1)
      assert.strictEqual(debugSink[0]?.scope, 'capture')
      assert.strictEqual(debugSink[0]?.msg, 'stored')
      assert.deepStrictEqual(debugSink[0]?.data, {
        docId: 'a',
        site: 'reddit',
        kind: 'thread',
        wordCount: 1,
        truncated: false,
      })
    }).pipe(Effect.provide(kvTest())),
  )
})
