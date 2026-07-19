import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { IpcError } from '../fx/errors'
import { Tabs } from '../fx/services'
import { PorterClient, type PorterClientShape, type PorterMessage } from '../messaging'
import type { SourceDoc } from '../model/types'
import type { QueueSnapshot } from '../queue/queue'
import type { WatchView } from '../watch/watch'
import { makeNotebookWorkspace } from '../notebooks/workspace'
import type { PorterSettings } from '../settings'
import { makePopupRefreshCoordinator } from './refresh'

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function doc(id: string): SourceDoc {
  return {
    id,
    site: 'reddit',
    kind: 'thread',
    title: id,
    canonicalUrl: `https://example.com/${id}`,
    capturedAt: '2026-07-18T00:00:00.000Z',
    markdown: `# ${id}`,
    wordCount: 1,
    truncated: false,
  }
}

function queue(id: string): QueueSnapshot {
  return { jobs: [{ id, docIds: [id], unitId: id, status: 'queued', attempts: 0 }] }
}

function watch(id: string): WatchView {
  return {
    id,
    sourceDocId: id,
    target: { authuser: 0, accountEmail: 'a@example.com', notebookId: 'notebook' },
    status: 'active',
    nextRunAt: 'never',
  }
}

type Request = (message: PorterMessage) => Effect.Effect<unknown, IpcError>

function reply(message: PorterMessage): unknown {
  switch (message.type) {
    case 'porter/detect':
      return { capturable: 'Capture this page' }
    case 'porter/list-docs':
      return { docs: [] }
    case 'porter/queue-status':
      return { queue: { jobs: [] } }
    case 'porter/watch-list':
      return { watches: [] }
    default:
      throw new Error(`Unexpected ${message.type}`)
  }
}

function coordinator(request: Request = (message) => Effect.succeed(reply(message))) {
  const updatedDocs: string[][] = []
  const bootstraps: string[][] = []
  const refresh = makePopupRefreshCoordinator({
    updateDocs: (docs) => updatedDocs.push(docs.map((value) => value.id)),
    supersedeBootstrap: () => undefined,
    bootstrap: () =>
      Effect.sync(() => {
        bootstraps.push([...updatedDocs.at(-1)!])
      }),
  })
  const layer = Layer.merge(
    Layer.succeed(
      PorterClient,
      PorterClient.of({ request: request as PorterClientShape['request'] }),
    ),
    Layer.succeed(
      Tabs,
      Tabs.of({
        activeTab: () => Effect.succeed({ url: 'https://example.com/current' }),
        sendMessage: () => Effect.die('Unexpected tab message'),
      }),
    ),
  )
  const run = (effect: Effect.Effect<void, never, PorterClient | Tabs>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)))
  return { refresh, updatedDocs, bootstraps, run }
}

describe('popup refresh coordinator', () => {
  it('detaches watch targets accepted from an action reply', () => {
    const { refresh } = coordinator()
    const incoming = watch('action-watch')

    refresh.acceptWatches([incoming])

    expect(refresh.snapshot().watches[0]?.target).not.toBe(incoming.target)
  })

  it('supersedes an in-flight bootstrap before waiting for fresh docs', async () => {
    const workspace = makeNotebookWorkspace()
    const oldSettings = deferred<{ settings: PorterSettings }>()
    const freshDocs = deferred<readonly SourceDoc[]>()
    const bootstrapStarted = deferred<void>()
    const docsStarted = deferred<void>()
    let settingsCalls = 0
    let catalogCalls = 0
    const refresh = makePopupRefreshCoordinator(workspace)
    const layer = Layer.merge(
      Layer.succeed(
        PorterClient,
        PorterClient.of({
          request: ((message: PorterMessage) => {
            switch (message.type) {
              case 'porter/get-settings':
                settingsCalls += 1
                if (settingsCalls === 1) {
                  bootstrapStarted.resolve()
                  return Effect.promise(() => oldSettings.promise)
                }
                return Effect.succeed({
                  settings: {
                    nblmAuthuser: 0,
                    accounts: [{ authuser: 0, email: 'fresh@example.com' }],
                    notebookTargets: { reddit: 'fresh-notebook' },
                  },
                })
              case 'porter/list-notebooks':
                catalogCalls += 1
                return Effect.succeed({
                  notebooks: [{ id: 'fresh-notebook', title: 'Fresh' }],
                })
              case 'porter/detect':
                return Effect.succeed({ capturable: 'Capture this page' })
              case 'porter/list-docs':
                docsStarted.resolve()
                return Effect.promise(() => freshDocs.promise)
              case 'porter/queue-status':
                return Effect.succeed({ queue: { jobs: [] } })
              case 'porter/watch-list':
                return Effect.succeed({ watches: [] })
              default:
                return Effect.fail(new IpcError({ reason: `Unexpected ${message.type}` }))
            }
          }) as PorterClientShape['request'],
        }),
      ),
      Layer.succeed(
        Tabs,
        Tabs.of({
          activeTab: () => Effect.succeed({ url: 'https://example.com/current' }),
          sendMessage: () => Effect.die('Unexpected tab message'),
        }),
      ),
    )
    const run = (effect: Effect.Effect<void, never, PorterClient | Tabs>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)))

    const firstBootstrap = Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(layer)))
    await bootstrapStarted.promise

    const r2 = run(refresh.refresh())
    await docsStarted.promise
    expect(workspace.snapshot().pending.bootstrap).toBe(false)

    oldSettings.resolve({
      settings: {
        nblmAuthuser: 0,
        accounts: [{ authuser: 0, email: 'stale@example.com' }],
        notebookTargets: { reddit: 'stale-notebook' },
        stickyRoutes: {},
        autoExportVault: false,
      },
    })
    await firstBootstrap

    expect(workspace.snapshot().settings.accounts).toEqual([])
    expect(catalogCalls).toBe(0)

    freshDocs.resolve([doc('fresh-doc')])
    await r2

    expect(catalogCalls).toBe(1)
    expect(workspace.snapshot().settings.accounts).toEqual([
      { authuser: 0, email: 'fresh@example.com' },
    ])
    expect(workspace.snapshot().selectedNotebookId).toBe('fresh-notebook')
  })

  it('lets R2 win and keeps R1 from bootstrapping stale docs', async () => {
    const firstDocs = deferred<readonly SourceDoc[]>()
    let calls = 0
    const { refresh, updatedDocs, bootstraps, run } = coordinator((message) => {
      if (message.type === 'porter/list-docs') {
        calls += 1
        return calls === 1
          ? Effect.promise(() => firstDocs.promise)
          : Effect.succeed({ docs: [doc('B'), doc('A')] })
      }
      return Effect.succeed(reply(message))
    })

    const r1 = run(refresh.refresh())
    await flush()
    const r2 = run(refresh.refresh())
    await r2
    firstDocs.resolve([doc('A')])
    await r1

    expect(refresh.snapshot().docs.map((value) => value.id)).toEqual(['B', 'A'])
    expect(updatedDocs).toEqual([['B', 'A']])
    expect(bootstraps).toEqual([['B', 'A']])
  })

  it('does not let a stale completion clear the newer pending refresh', async () => {
    const firstDocs = deferred<readonly SourceDoc[]>()
    const secondDocs = deferred<readonly SourceDoc[]>()
    let calls = 0
    const { refresh, run } = coordinator((message) => {
      if (message.type === 'porter/list-docs') {
        calls += 1
        return Effect.promise(() => (calls === 1 ? firstDocs.promise : secondDocs.promise))
      }
      return Effect.succeed(reply(message))
    })

    const r1 = run(refresh.refresh())
    await flush()
    const r2 = run(refresh.refresh())
    await flush()
    firstDocs.resolve([doc('A')])
    await r1

    expect(refresh.snapshot().pending).toBe(true)
    secondDocs.resolve([doc('B')])
    await r2

    expect(refresh.snapshot().pending).toBe(false)
  })

  it('does not update the workspace after publication starts a newer refresh', async () => {
    let calls = 0
    const { refresh, updatedDocs, bootstraps, run } = coordinator((message) => {
      if (message.type === 'porter/list-docs') {
        calls += 1
        return Effect.succeed({ docs: [doc(calls === 1 ? 'A' : 'B')] })
      }
      return Effect.succeed(reply(message))
    })
    let newerRefresh: Promise<void> | undefined
    let newerRefreshStarted = false
    const unsubscribe = refresh.subscribe((snapshot) => {
      if (snapshot.docs[0]?.id === 'A' && !newerRefreshStarted) {
        newerRefreshStarted = true
        newerRefresh = run(refresh.refresh())
      }
    })

    await run(refresh.refresh())
    await newerRefresh
    unsubscribe()

    expect(updatedDocs).toEqual([['B']])
    expect(bootstraps).toEqual([['B']])
  })

  it('keeps queue and watch action replies over an older refresh', async () => {
    const oldQueue = deferred<QueueSnapshot>()
    const oldWatches = deferred<readonly WatchView[]>()
    const { refresh, run } = coordinator((message) => {
      if (message.type === 'porter/list-docs') return Effect.succeed({ docs: [doc('A')] })
      if (message.type === 'porter/queue-status') return Effect.promise(() => oldQueue.promise)
      if (message.type === 'porter/watch-list') return Effect.promise(() => oldWatches.promise)
      return Effect.succeed(reply(message))
    })

    const pending = run(refresh.refresh())
    await flush()
    refresh.acceptQueueSnapshot(queue('action-queue'))
    oldQueue.resolve(queue('refresh-queue'))
    await flush()
    refresh.acceptWatches([watch('action-watch')])
    oldWatches.resolve([watch('refresh-watch')])
    await pending

    expect(refresh.snapshot().queue?.jobs.map((job) => job.id)).toEqual(['action-queue'])
    expect(refresh.snapshot().watches.map((value) => value.id)).toEqual(['action-watch'])
  })
})
