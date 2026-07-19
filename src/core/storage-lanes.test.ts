import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { Kv } from './fx/services'
import { alarmsTest, debugLogTest, httpTest, identityTest, tabsTest } from './fx/testing'
import type { PorterMessage } from './messaging'
import { domainsForMessage, handlePorterMessage, LANE_ORDER, type StorageDomain } from './router'
import { DEFAULT_SETTINGS, type PorterSettings } from './settings'
import { makeStorageLaneScheduler } from './storage-lanes'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe('storage lane scheduler', () => {
  it('releases a lane after rejected work', async () => {
    const scheduler = makeStorageLaneScheduler(['settings'] as const)
    const order: string[] = []
    const rejected = scheduler.run(['settings'], async () => {
      order.push('rejected')
      throw new Error('boom')
    })
    const recovered = scheduler.run(['settings'], async () => {
      order.push('recovered')
    })

    await expect(rejected).rejects.toThrow('boom')
    await recovered
    expect(order).toEqual(['rejected', 'recovered'])
  })

  it('acquires multi-domain work in the fixed order', async () => {
    const scheduler = makeStorageLaneScheduler(['docs', 'settings'] as const)
    const releaseDocs = deferred()
    const releaseSettings = deferred()
    const docsStarted = deferred()
    const settingsStarted = deferred()
    const events: string[] = []

    const docsBlocker = scheduler.run(['docs'], async () => {
      docsStarted.resolve()
      await releaseDocs.promise
    })
    const settingsBlocker = scheduler.run(['settings'], async () => {
      settingsStarted.resolve()
      await releaseSettings.promise
    })
    await Promise.all([docsStarted.promise, settingsStarted.promise])

    const spanning = scheduler.run(['settings', 'docs'], async () => {
      events.push('spanning')
    })
    const docsProbe = scheduler.run(['docs'], async () => {
      events.push('docs-probe')
    })

    releaseDocs.resolve()
    await docsBlocker
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual([])

    releaseSettings.resolve()
    await Promise.all([settingsBlocker, spanning, docsProbe])
    expect(events).toEqual(['spanning', 'docs-probe'])
  })

  for (const [name, firstPatch, secondPatch] of [
    ['Drive then account', { driveClientId: 'client-id' }, { nblmAuthuser: 1 }],
    ['account then Drive', { nblmAuthuser: 1 }, { driveClientId: 'client-id' }],
  ] as const) {
    it(`preserves both settings patches through shared storage: ${name}`, async () => {
      const store = new Map<string, unknown>([['porter/settings', DEFAULT_SETTINGS]])
      const firstSetStarted = deferred()
      const releaseFirstSet = deferred()
      const trace: string[] = []
      let setCount = 0
      const kv = Layer.succeed(
        Kv,
        Kv.of({
          get: <T>(key: string) =>
            Effect.sync(() => {
              trace.push('get')
              return store.get(key) as T | undefined
            }),
          set: <T>(key: string, value: T) =>
            Effect.gen(function* () {
              trace.push('set:start')
              setCount += 1
              if (setCount === 1) {
                firstSetStarted.resolve()
                yield* Effect.promise(() => releaseFirstSet.promise)
              }
              store.set(key, value)
              trace.push('set:done')
            }),
        }),
      )
      const layer = Layer.mergeAll(
        kv,
        debugLogTest(),
        tabsTest({}),
        alarmsTest(),
        httpTest({}),
        identityTest(),
      )
      const scheduler = makeStorageLaneScheduler<StorageDomain>(LANE_ORDER)
      const run = (message: PorterMessage) =>
        scheduler.run(domainsForMessage(message.type), () =>
          Effect.runPromise(handlePorterMessage(message).pipe(Effect.provide(layer))),
        )

      const first = run({ type: 'porter/update-settings', patch: firstPatch })
      const second = run({ type: 'porter/update-settings', patch: secondPatch })
      await firstSetStarted.promise
      await Promise.resolve()
      await Promise.resolve()
      expect(trace).toEqual(['get', 'set:start'])

      releaseFirstSet.resolve()
      await Promise.all([first, second])
      const read = await Effect.runPromise(
        handlePorterMessage({ type: 'porter/get-settings' }).pipe(Effect.provide(layer)),
      )

      expect(read).toEqual({
        ok: true,
        settings: {
          ...DEFAULT_SETTINGS,
          nblmAuthuser: 1,
          driveClientId: 'client-id',
        } satisfies PorterSettings,
      })
      expect(trace).toEqual(['get', 'set:start', 'set:done', 'get', 'set:start', 'set:done', 'get'])
    })
  }

  it('reads settings only after an earlier settings write commits', async () => {
    const store = new Map<string, unknown>([['porter/settings', DEFAULT_SETTINGS]])
    const setStarted = deferred()
    const releaseSet = deferred()
    const kv = Layer.succeed(
      Kv,
      Kv.of({
        get: <T>(key: string) => Effect.sync(() => store.get(key) as T | undefined),
        set: <T>(key: string, value: T) =>
          Effect.gen(function* () {
            setStarted.resolve()
            yield* Effect.promise(() => releaseSet.promise)
            store.set(key, value)
          }),
      }),
    )
    const layer = Layer.mergeAll(
      kv,
      debugLogTest(),
      tabsTest({}),
      alarmsTest(),
      httpTest({}),
      identityTest(),
    )
    const scheduler = makeStorageLaneScheduler<StorageDomain>(LANE_ORDER)
    const run = (message: PorterMessage) =>
      scheduler.run(domainsForMessage(message.type), () =>
        Effect.runPromise(handlePorterMessage(message).pipe(Effect.provide(layer))),
      )

    const write = run({ type: 'porter/update-settings', patch: { nblmAuthuser: 1 } })
    await setStarted.promise
    let readSettled = false
    const read = run({ type: 'porter/get-settings' }).then((reply) => {
      readSettled = true
      return reply
    })
    await Promise.resolve()
    await Promise.resolve()
    const settledBeforeCommit = readSettled

    releaseSet.resolve()
    const [, reply] = await Promise.all([write, read])

    expect(settledBeforeCommit).toBe(false)
    expect(reply).toEqual({
      ok: true,
      settings: { ...DEFAULT_SETTINGS, nblmAuthuser: 1 },
    })
  })
})
