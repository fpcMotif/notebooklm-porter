import { Effect, Result } from 'effect'
import { Tabs } from '../fx/services'
import { PorterClient } from '../messaging'
import type { SourceDoc } from '../model/types'
import type { QueueSnapshot } from '../queue/queue'
import type { WatchView } from '../watch/watch'

export interface PopupRefreshSnapshot {
  readonly docs: readonly SourceDoc[]
  readonly capturable: string | undefined
  readonly canEnrichTranscripts: boolean
  readonly queue: QueueSnapshot | undefined
  readonly watches: readonly WatchView[]
  readonly pending: boolean
}

export interface PopupRefreshWorkspace {
  readonly updateDocs: (docs: readonly SourceDoc[]) => void
  readonly supersedeBootstrap: () => void
  readonly bootstrap: () => Effect.Effect<void, never, PorterClient>
}

export interface PopupRefreshCoordinator {
  readonly snapshot: () => PopupRefreshSnapshot
  readonly subscribe: (listener: (snapshot: PopupRefreshSnapshot) => void) => () => void
  readonly refresh: () => Effect.Effect<void, never, PorterClient | Tabs>
  readonly acceptQueueSnapshot: (queue: QueueSnapshot) => void
  readonly acceptWatches: (watches: readonly WatchView[]) => void
}

function initialSnapshot(): PopupRefreshSnapshot {
  return {
    docs: [],
    capturable: undefined,
    canEnrichTranscripts: false,
    queue: undefined,
    watches: [],
    pending: false,
  }
}

function copyQueue(queue: QueueSnapshot): QueueSnapshot {
  return {
    jobs: queue.jobs.map((job) => ({ ...job, docIds: [...job.docIds] })),
  }
}

function copyWatches(watches: readonly WatchView[]): readonly WatchView[] {
  return watches.map((watch) => ({ ...watch, target: { ...watch.target } }))
}

/**
 * Owns only the popup's read projection. A refresh revision rejects stale
 * I/O; queue and watch action replies have narrower revisions of their own.
 */
export function makePopupRefreshCoordinator(
  workspace: PopupRefreshWorkspace,
): PopupRefreshCoordinator {
  let state = initialSnapshot()
  let refreshRevision = 0
  let queueRevision = 0
  let watchRevision = 0
  const listeners = new Set<(snapshot: PopupRefreshSnapshot) => void>()

  function publish(next: PopupRefreshSnapshot): void {
    state = next
    for (const listener of listeners) listener(state)
  }

  function patch(next: Partial<PopupRefreshSnapshot>): void {
    publish({ ...state, ...next })
  }

  function isCurrent(revision: number): boolean {
    return revision === refreshRevision
  }

  function refresh(): Effect.Effect<void, never, PorterClient | Tabs> {
    return Effect.suspend(() => {
      const revision = ++refreshRevision
      workspace.supersedeBootstrap()
      const queueAtStart = queueRevision
      const watchesAtStart = watchRevision
      patch({ pending: true })

      return Effect.gen(function* () {
        const tabs = yield* Tabs
        const tabResult = yield* Effect.result(tabs.activeTab())
        if (!isCurrent(revision)) return

        let detection:
          | { readonly capturable?: string; readonly canEnrichTranscripts?: true }
          | undefined
        const url = Result.isSuccess(tabResult) ? tabResult.success.url : undefined
        if (url !== undefined) {
          const client = yield* PorterClient
          const detected = yield* Effect.result(client.request({ type: 'porter/detect', url }))
          if (!isCurrent(revision)) return
          if (Result.isSuccess(detected)) detection = detected.success
        }
        patch({
          capturable: detection?.capturable,
          canEnrichTranscripts: detection?.canEnrichTranscripts === true,
        })

        const client = yield* PorterClient
        const listed = yield* Effect.result(client.request({ type: 'porter/list-docs' }))
        if (!isCurrent(revision)) return
        const docs = Result.isSuccess(listed) ? listed.success.docs : undefined
        if (docs !== undefined) patch({ docs: [...docs] })

        if (!isCurrent(revision)) return
        workspace.updateDocs(docs ?? state.docs)
        if (!isCurrent(revision)) return
        yield* workspace.bootstrap()
        if (!isCurrent(revision)) return

        const queue = yield* Effect.result(client.request({ type: 'porter/queue-status' }))
        if (!isCurrent(revision)) return
        if (Result.isSuccess(queue) && queueRevision === queueAtStart) {
          patch({ queue: copyQueue(queue.success.queue) })
        }

        const watches = yield* Effect.result(client.request({ type: 'porter/watch-list' }))
        if (!isCurrent(revision)) return
        if (Result.isSuccess(watches) && watchRevision === watchesAtStart) {
          patch({ watches: copyWatches(watches.success.watches) })
        }

        if (isCurrent(revision)) patch({ pending: false })
      })
    })
  }

  return {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
    acceptQueueSnapshot: (queue) => {
      queueRevision += 1
      patch({ queue: copyQueue(queue) })
    },
    acceptWatches: (watches) => {
      watchRevision += 1
      patch({ watches: copyWatches(watches) })
    },
  }
}
