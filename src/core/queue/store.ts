import { Effect } from 'effect'
import type { StorageError } from '../fx/errors'
import { Kv } from '../fx/services'
import { QUEUE_STORAGE_KEY, emptyQueue, type QueueState } from './queue'

export function loadQueue(): Effect.Effect<QueueState, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    return (yield* kv.get<QueueState>(QUEUE_STORAGE_KEY)) ?? emptyQueue()
  })
}

export function saveQueue(queue: QueueState): Effect.Effect<void, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    yield* kv.set(QUEUE_STORAGE_KEY, queue)
  })
}
