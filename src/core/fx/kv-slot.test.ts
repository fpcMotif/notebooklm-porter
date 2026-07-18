import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { kvSlot } from './kv-slot'
import { kvTest } from './testing'

interface Widget {
  n: number
}

describe('kvSlot', () => {
  it.effect('load returns the empty state when the key is missing', () =>
    Effect.gen(function* () {
      const slot = kvSlot<Widget>('widget', () => ({ n: 0 }))
      const value = yield* slot.load()
      assert.deepStrictEqual(value, { n: 0 })
    }).pipe(Effect.provide(kvTest())),
  )

  it.effect('load passes the stored value through unchanged when no decode is given', () =>
    Effect.gen(function* () {
      const slot = kvSlot<Widget>('widget', () => ({ n: 0 }))
      const value = yield* slot.load()
      assert.deepStrictEqual(value, { n: 5 })
    }).pipe(Effect.provide(kvTest({ widget: { n: 5 } }))),
  )

  it.effect('load applies the decode transform to the stored value', () =>
    Effect.gen(function* () {
      const slot = kvSlot<Widget>(
        'widget',
        () => ({ n: 0 }),
        (stored) => ({
          n: (stored as Widget).n * 2,
        }),
      )
      const value = yield* slot.load()
      assert.deepStrictEqual(value, { n: 10 })
    }).pipe(Effect.provide(kvTest({ widget: { n: 5 } }))),
  )

  it.effect('load falls back to empty() when decode returns undefined', () =>
    Effect.gen(function* () {
      const slot = kvSlot<Widget>(
        'widget',
        () => ({ n: -1 }),
        () => undefined,
      )
      const value = yield* slot.load()
      assert.deepStrictEqual(value, { n: -1 })
    }).pipe(Effect.provide(kvTest({ widget: { n: 5 } }))),
  )

  it.effect('save round-trips through a subsequent load', () =>
    Effect.gen(function* () {
      const slot = kvSlot<Widget>('widget', () => ({ n: 0 }))
      yield* slot.save({ n: 42 })
      const value = yield* slot.load()
      assert.deepStrictEqual(value, { n: 42 })
    }).pipe(Effect.provide(kvTest())),
  )
})
