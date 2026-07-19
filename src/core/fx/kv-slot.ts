import { Effect } from 'effect'
import type { StorageError } from './errors'
import { Kv } from './services'

export interface KvSlot<T> {
  readonly load: () => Effect.Effect<T, StorageError, Kv>
  readonly save: (value: T) => Effect.Effect<void, StorageError, Kv>
}

/**
 * One storage slot: a key, an empty-state constructor, and an optional
 * decode that owns validation and legacy migration. decode receives the
 * raw stored value and returns the domain state, or undefined to fall
 * back to empty() (the rejected-shape path every store hand-rolled).
 */
export function kvSlot<T>(
  key: string,
  empty: () => T,
  decode?: (stored: unknown) => T | undefined,
): KvSlot<T> {
  return {
    load: () =>
      Effect.gen(function* () {
        const kv = yield* Kv
        const stored = yield* kv.get<unknown>(key)
        if (stored === undefined) return empty()
        if (decode === undefined) return stored as T
        return decode(stored) ?? empty()
      }),
    save: (value) =>
      Effect.gen(function* () {
        const kv = yield* Kv
        yield* kv.set(key, value)
      }),
  }
}
