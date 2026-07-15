import { Effect } from 'effect'
import type { StorageError } from '../fx/errors'
import { kvSlot } from '../fx/kv-slot'
import { Kv } from '../fx/services'
import { emptyQueue, QUEUE_STORAGE_KEY, type QueueState } from './queue'

const queueSlot = kvSlot<QueueState>(QUEUE_STORAGE_KEY, emptyQueue)

export function loadQueue(): Effect.Effect<QueueState, StorageError, Kv> {
  return queueSlot.load()
}

export function saveQueue(queue: QueueState): Effect.Effect<void, StorageError, Kv> {
  return queueSlot.save(queue)
}
