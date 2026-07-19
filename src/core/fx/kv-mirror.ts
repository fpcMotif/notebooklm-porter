/**
 * Pure logic for the Convex-mirrored Kv layer: write batching/coalescing,
 * the mirror shape itself, install-id derivation, and the layer-selection
 * ruling. layers.ts owns the actual fetch + dbg wiring. Local storage is
 * always the source of truth — the cloud copy is a fire-and-forget mirror
 * that can never fail an operation.
 */
import { Effect } from 'effect'
import { isValidConvexUrl } from '../convex/api'
import type { KvShape } from './services'

export const INSTALL_ID_KEY = 'porter/install-id'
export const KV_MIRROR_DEBOUNCE_MS = 2_000

export interface PendingWrite {
  key: string
  value: unknown
  updatedAt: number
}

/** Last write per key wins; batch order follows each key's first appearance. */
export function coalesceWrites(writes: readonly PendingWrite[]): PendingWrite[] {
  const byKey = new Map<string, PendingWrite>()
  for (const write of writes) byKey.set(write.key, write)
  return [...byKey.values()]
}

export interface WriteBatcher {
  add: (key: string, value: unknown) => void
  flushNow: () => void
  pending: () => number
}

/**
 * Collects mirror writes and flushes one coalesced batch per debounce window.
 * The window opens on the first write (not the last), so a drain burst
 * becomes a single upsert instead of a trailing debounce that never settles.
 * `schedule` returns a cancel thunk — injectable so tests drive time by hand.
 */
export function makeWriteBatcher(opts: {
  debounceMs: number
  onFlush: (batch: PendingWrite[]) => void
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
}): WriteBatcher {
  const now = opts.now ?? (() => Date.now())
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms)
      return () => clearTimeout(id)
    })
  let buffer: PendingWrite[] = []
  let cancel: (() => void) | undefined

  const flush = () => {
    cancel = undefined
    if (buffer.length === 0) return
    const batch = coalesceWrites(buffer)
    buffer = []
    opts.onFlush(batch)
  }

  return {
    add: (key, value) => {
      buffer.push({ key, value, updatedAt: now() })
      if (cancel === undefined) cancel = schedule(flush, opts.debounceMs)
    },
    flushNow: () => {
      if (cancel !== undefined) {
        cancel()
        cancel = undefined
      }
      flush()
    },
    pending: () => buffer.length,
  }
}

/** Keeps a usable persisted id; anything else mints a fresh one to persist. */
export function ensureInstallId(
  existing: unknown,
  generate: () => string,
): { id: string; created: boolean } {
  return typeof existing === 'string' && existing.length > 0
    ? { id: existing, created: false }
    : { id: generate(), created: true }
}

/** The one layer-selection ruling: mirror only behind a usable https Convex URL. */
export function chooseKvLayer(convexUrl: string | undefined): 'mirror' | 'local' {
  return convexUrl !== undefined && convexUrl !== '' && isValidConvexUrl(convexUrl)
    ? 'mirror'
    : 'local'
}

export interface KvMirrorOps {
  push: (batch: readonly PendingWrite[]) => Promise<void>
  pull: (key: string) => Promise<unknown>
  log: (msg: string, data?: unknown) => void
  debounceMs?: number
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
}

/**
 * Wraps a local KvShape: every set lands locally FIRST, then joins the
 * debounced cloud batch; a get reads locally and consults the cloud copy
 * only on a local miss. Cloud failures log and resolve — never fail.
 */
export function makeKvMirror(local: KvShape, ops: KvMirrorOps): KvShape {
  const batcher = makeWriteBatcher({
    debounceMs: ops.debounceMs ?? KV_MIRROR_DEBOUNCE_MS,
    ...(ops.now !== undefined ? { now: ops.now } : {}),
    ...(ops.schedule !== undefined ? { schedule: ops.schedule } : {}),
    onFlush: (batch) => {
      void ops.push(batch).catch((err: unknown) => {
        ops.log('cloud upsert failed', {
          keys: batch.map((write) => write.key),
          error: String(err),
        })
      })
    },
  })

  return {
    get: <T>(key: string) =>
      local.get<T>(key).pipe(
        Effect.flatMap((value) =>
          value !== undefined
            ? Effect.succeed<T | undefined>(value)
            : Effect.promise(async () => {
                try {
                  const cloud = await ops.pull(key)
                  // Convex returns null for an absent row; Kv's absent is undefined.
                  return (cloud ?? undefined) as T | undefined
                } catch (err) {
                  ops.log('cloud get failed', { key, error: String(err) })
                  return undefined
                }
              }),
        ),
      ),
    set: (key, value) =>
      local.set(key, value).pipe(Effect.tap(() => Effect.sync(() => batcher.add(key, value)))),
  }
}
