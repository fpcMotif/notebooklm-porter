import { describe, expect, it } from 'vitest'
import { Effect } from 'effect'
import {
  chooseKvLayer,
  coalesceWrites,
  ensureInstallId,
  makeKvMirror,
  makeWriteBatcher,
  type PendingWrite,
} from './kv-mirror'
import type { KvShape } from './services'

/** Manual scheduler: collects armed timers so tests fire them by hand. */
function manualScheduler() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = []
  const schedule = (fn: () => void, ms: number) => {
    const entry = { fn, ms, cancelled: false }
    timers.push(entry)
    return () => {
      entry.cancelled = true
    }
  }
  return { timers, schedule }
}

describe('coalesceWrites', () => {
  it('keeps the last value per key in first-seen key order', () => {
    const writes: PendingWrite[] = [
      { key: 'a', value: 1, updatedAt: 1 },
      { key: 'b', value: 2, updatedAt: 2 },
      { key: 'a', value: 3, updatedAt: 3 },
    ]
    expect(coalesceWrites(writes)).toEqual([
      { key: 'a', value: 3, updatedAt: 3 },
      { key: 'b', value: 2, updatedAt: 2 },
    ])
  })
})

describe('makeWriteBatcher', () => {
  it('arms one window per burst and flushes a coalesced batch', () => {
    const { timers, schedule } = manualScheduler()
    const flushes: PendingWrite[][] = []
    const batcher = makeWriteBatcher({
      debounceMs: 2_000,
      onFlush: (batch) => void flushes.push(batch),
      now: () => 42,
      schedule,
    })

    batcher.add('a', 1)
    batcher.add('b', 2)
    batcher.add('a', 3)
    expect(timers.length).toBe(1)
    expect(timers[0]?.ms).toBe(2_000)
    expect(batcher.pending()).toBe(3)
    expect(flushes).toEqual([])

    timers[0]?.fn()
    expect(flushes).toEqual([
      [
        { key: 'a', value: 3, updatedAt: 42 },
        { key: 'b', value: 2, updatedAt: 42 },
      ],
    ])
    expect(batcher.pending()).toBe(0)

    // A write after the flush opens a fresh window.
    batcher.add('c', 9)
    expect(timers.length).toBe(2)
  })

  it('flushNow cancels the armed timer and flushes immediately', () => {
    const { timers, schedule } = manualScheduler()
    const flushes: PendingWrite[][] = []
    const batcher = makeWriteBatcher({
      debounceMs: 2_000,
      onFlush: (batch) => void flushes.push(batch),
      now: () => 7,
      schedule,
    })

    batcher.flushNow()
    expect(flushes).toEqual([])

    batcher.add('a', 1)
    batcher.flushNow()
    expect(flushes).toEqual([[{ key: 'a', value: 1, updatedAt: 7 }]])
    expect(timers[0]?.cancelled).toBe(true)
  })
})

describe('ensureInstallId', () => {
  it('keeps a usable persisted id and mints one otherwise', () => {
    expect(ensureInstallId('install-1', () => 'fresh')).toEqual({
      id: 'install-1',
      created: false,
    })
    expect(ensureInstallId(undefined, () => 'fresh')).toEqual({ id: 'fresh', created: true })
    expect(ensureInstallId('', () => 'fresh')).toEqual({ id: 'fresh', created: true })
    expect(ensureInstallId(42, () => 'fresh')).toEqual({ id: 'fresh', created: true })
  })
})

describe('chooseKvLayer', () => {
  it('selects the mirror only behind a usable https URL', () => {
    expect(chooseKvLayer('https://demo.convex.cloud')).toBe('mirror')
    expect(chooseKvLayer(undefined)).toBe('local')
    expect(chooseKvLayer('')).toBe('local')
    expect(chooseKvLayer('http://demo.convex.cloud')).toBe('local')
    expect(chooseKvLayer('not a url')).toBe('local')
  })
})

function localMapKv(store: Map<string, unknown>): KvShape {
  return {
    get: <T>(key: string) => Effect.sync(() => store.get(key) as T | undefined),
    set: (key, value) => Effect.sync(() => void store.set(key, value)),
  }
}

describe('makeKvMirror', () => {
  it('writes local first, then mirrors one coalesced cloud batch', async () => {
    const store = new Map<string, unknown>()
    const { timers, schedule } = manualScheduler()
    const pushed: PendingWrite[][] = []
    const mirror = makeKvMirror(localMapKv(store), {
      push: async (batch) => void pushed.push([...batch]),
      pull: async () => null,
      log: () => undefined,
      now: () => 5,
      schedule,
    })

    await Effect.runPromise(mirror.set('a', 1))
    await Effect.runPromise(mirror.set('a', 2))
    expect(store.get('a')).toBe(2)
    expect(pushed).toEqual([])

    timers[0]?.fn()
    expect(pushed).toEqual([[{ key: 'a', value: 2, updatedAt: 5 }]])
  })

  it('serves local hits without touching the cloud and pulls only on a miss', async () => {
    const store = new Map<string, unknown>([['hit', 'local-value']])
    const pulls: string[] = []
    const mirror = makeKvMirror(localMapKv(store), {
      push: async () => undefined,
      pull: async (key) => {
        pulls.push(key)
        return key === 'cloud-only' ? 'cloud-value' : null
      },
      log: () => undefined,
    })

    expect(await Effect.runPromise(mirror.get('hit'))).toBe('local-value')
    expect(pulls).toEqual([])
    expect(await Effect.runPromise(mirror.get('cloud-only'))).toBe('cloud-value')
    expect(await Effect.runPromise(mirror.get('nowhere'))).toBeUndefined()
    expect(pulls).toEqual(['cloud-only', 'nowhere'])
  })

  it('logs cloud failures without failing the operation', async () => {
    const store = new Map<string, unknown>()
    const { timers, schedule } = manualScheduler()
    const logged: string[] = []
    const mirror = makeKvMirror(localMapKv(store), {
      push: async () => {
        throw new Error('push boom')
      },
      pull: async () => {
        throw new Error('pull boom')
      },
      log: (msg) => void logged.push(msg),
      schedule,
    })

    await Effect.runPromise(mirror.set('a', 1))
    timers[0]?.fn()
    // The push rejection settles on a microtask; give it one turn.
    await Promise.resolve()
    expect(store.get('a')).toBe(1)

    expect(await Effect.runPromise(mirror.get('missing'))).toBeUndefined()
    expect(logged).toEqual(['cloud upsert failed', 'cloud get failed'])
  })
})
