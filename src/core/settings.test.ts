import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { Kv } from './fx/services'
import { DEFAULT_SETTINGS, getSettings, updateSettings } from './settings'

function makeKvLayer(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial))
  return Layer.succeed(
    Kv,
    Kv.of({
      get: <T>(key: string) => Effect.succeed(store.get(key) as T | undefined),
      set: <T>(key: string, value: T) =>
        Effect.sync(() => {
          store.set(key, value)
        }),
    }),
  )
}

describe('settings', () => {
  it.effect('getSettings returns defaults when nothing is stored', () =>
    Effect.gen(function* () {
      const settings = yield* getSettings()
      assert.deepStrictEqual(settings, DEFAULT_SETTINGS)
    }).pipe(Effect.provide(makeKvLayer())),
  )

  it.effect('updateSettings merges the patch into current settings and persists it', () =>
    Effect.gen(function* () {
      const first = yield* updateSettings({ driveClientId: 'client-1' })
      assert.strictEqual(first.driveClientId, 'client-1')
      assert.strictEqual(first.nblmAuthuser, 0)

      const second = yield* updateSettings({ nblmAuthuser: 2 })
      assert.strictEqual(second.nblmAuthuser, 2)
      assert.strictEqual(second.driveClientId, 'client-1')

      const reread = yield* getSettings()
      assert.deepStrictEqual(reread, second)
    }).pipe(Effect.provide(makeKvLayer())),
  )
})
