import { Effect, Layer } from 'effect'
import { describe, expect, it } from 'vitest'
import { IpcError } from '../fx/errors'
import { porterClientTest } from '../fx/testing'
import type { ConsoleScan } from '../ingest/sources/console'
import { PorterClient, type PorterClientShape, type PorterMessage } from '../messaging'
import type { PorterSettings } from '../settings'
import type { NotebookMeta } from './model'
import { makeNotebookWorkspace } from './workspace'

const account0 = { authuser: 0, email: 'zero@example.com' }
const account1 = { authuser: 1, email: 'one@example.com' }
const notebookA = { id: 'nb-a', title: 'A' }
const notebookB = { id: 'nb-b', title: 'B' }
const binding0 = { authuser: 0, accountEmail: account0.email }
const binding1 = { authuser: 1, accountEmail: account1.email }
const targetA = { ...binding0, notebookId: notebookA.id }
const readySource = {
  id: 'source-ready',
  title: 'Ready',
  url: 'https://example.com/article',
  kind: 'web_page' as const,
  status: 'ready' as const,
}
const duplicateSource = { ...readySource, id: 'source-duplicate', title: 'Duplicate' }
const failedSource = {
  id: 'source-failed',
  title: 'Failed',
  url: 'https://example.com/failed',
  kind: 'web_page' as const,
  status: 'error' as const,
}
const duplicateScan: ConsoleScan = {
  sources: [readySource, duplicateSource, failedSource],
  duplicateGroups: [
    {
      key: 'url:example.com/article',
      keep: readySource,
      remove: [duplicateSource],
    },
  ],
  failed: [{ source: failedSource, reason: 'Fetch failed', retry: 'refresh' }],
  duplicateCount: 1,
}
const cleanScan: ConsoleScan = {
  sources: [readySource],
  duplicateGroups: [],
  failed: [],
  duplicateCount: 0,
}

function settings(overrides: Partial<PorterSettings> = {}): PorterSettings {
  return {
    nblmAuthuser: 0,
    accounts: [{ ...account0 }, { ...account1 }],
    notebookTargets: {},
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function dynamicClient(request: (msg: PorterMessage) => Effect.Effect<unknown, IpcError>) {
  return Layer.succeed(
    PorterClient,
    PorterClient.of({ request: request as PorterClientShape['request'] }),
  )
}

function unexpected(msg: PorterMessage): Effect.Effect<never, IpcError> {
  return Effect.fail(new IpcError({ reason: `Unexpected ${msg.type}` }))
}

describe('notebook workspace', () => {
  it('publishes replacement snapshots until a subscriber detaches', () => {
    const workspace = makeNotebookWorkspace()
    const initial = workspace.snapshot()
    const titles: string[] = []
    const unsubscribe = workspace.subscribe((snapshot) => {
      titles.push(snapshot.newNotebookTitle)
    })

    workspace.editNewNotebookTitle('First')
    unsubscribe()
    workspace.editNewNotebookTitle('Second')

    expect(titles).toEqual(['First'])
    expect(initial.newNotebookTitle).toBe('')
    expect(workspace.snapshot().newNotebookTitle).toBe('Second')
  })

  it('copies nested reply state before exposing a deeply readonly snapshot', async () => {
    const workspace = makeNotebookWorkspace()
    const replySettings = settings({ notebookTargets: { reddit: notebookA.id } })
    const replyNotebooks = [{ ...notebookA }]
    const layer = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: replySettings }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: replyNotebooks }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(layer)))

    replySettings.accounts[0]!.email = 'mutated@example.com'
    replySettings.notebookTargets.reddit = 'mutated'
    replyNotebooks[0]!.title = 'Mutated'

    expect(workspace.snapshot().settings.accounts[0]?.email).toBe(account0.email)
    expect(workspace.snapshot().settings.notebookTargets.reddit).toBe(notebookA.id)
    expect(workspace.snapshot().notebooks[0]?.title).toBe(notebookA.title)
  })

  it('bootstraps settings, uses the cached catalog, and resolves the remembered target', async () => {
    const calls: PorterMessage[] = []
    const workspace = makeNotebookWorkspace()
    workspace.updateDocs([{ site: 'reddit' }])
    const layer = porterClientTest({
      'porter/get-settings': (msg) => {
        calls.push(msg)
        return {
          ok: true,
          settings: settings({ notebookTargets: { reddit: notebookB.id } }),
        }
      },
      'porter/list-notebooks': (msg) => {
        calls.push(msg)
        return { ok: true, notebooks: [notebookA, notebookB] }
      },
    })

    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(layer)))

    expect(calls.map((call) => call.type)).toEqual(['porter/get-settings', 'porter/list-notebooks'])
    expect(calls[1]).toEqual({ type: 'porter/list-notebooks', account: binding0 })
    expect(workspace.snapshot().selectedNotebookId).toBe(notebookB.id)
    expect(workspace.snapshot().pending.bootstrap).toBe(false)
  })

  it('lets a later bootstrap own settings, docs, catalog, and pending state', async () => {
    const workspace = makeNotebookWorkspace()
    workspace.updateDocs([{ site: 'reddit' }])
    const firstSettings = deferred<{ settings: PorterSettings }>()
    const firstStarted = deferred<void>()
    const firstLayer = dynamicClient((msg) => {
      if (msg.type !== 'porter/get-settings') return unexpected(msg)
      firstStarted.resolve()
      return Effect.promise(() => firstSettings.promise)
    })
    const first = Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(firstLayer)))
    await firstStarted.promise

    workspace.updateDocs([{ site: 'youtube' }])
    const secondLayer = porterClientTest({
      'porter/get-settings': () => ({
        ok: true,
        settings: settings({
          notebookTargets: { reddit: notebookA.id, youtube: notebookB.id },
        }),
      }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA, notebookB] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(secondLayer)))

    firstSettings.resolve({
      settings: settings({ notebookTargets: { reddit: notebookA.id } }),
    })
    await first

    expect(workspace.snapshot().selectedNotebookId).toBe(notebookB.id)
    expect(workspace.snapshot().settings.notebookTargets).toEqual({
      reddit: notebookA.id,
      youtube: notebookB.id,
    })
    expect(workspace.snapshot().pending.bootstrap).toBe(false)
  })

  it('skips catalog I/O and clears stale notebook state when no accounts remain', async () => {
    const workspace = makeNotebookWorkspace()
    const populated = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(populated)))

    let listed = false
    const empty = porterClientTest({
      'porter/get-settings': () => ({
        ok: true,
        settings: settings({ accounts: [] }),
      }),
      'porter/list-notebooks': () => {
        listed = true
        return { ok: true, notebooks: [] }
      },
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(empty)))

    expect(listed).toBe(false)
    expect(workspace.snapshot().notebooks).toEqual([])
    expect(workspace.snapshot().selectedNotebookId).toBe('')
  })

  it('does not list or create without an active account binding', async () => {
    const workspace = makeNotebookWorkspace()
    const calls: PorterMessage[] = []
    const layer = porterClientTest({
      'porter/get-settings': () => ({
        ok: true,
        settings: settings({ accounts: [account1] }),
      }),
      'porter/list-notebooks': (msg) => {
        calls.push(msg)
        return { ok: true, notebooks: [notebookA] }
      },
      'porter/create-notebook': (msg) => {
        calls.push(msg)
        return { ok: true, notebooks: [notebookA], created: notebookA }
      },
    })

    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(layer)))
    workspace.editNewNotebookTitle('Wrong account')
    await Effect.runPromise(workspace.createNotebook().pipe(Effect.provide(layer)))

    expect(calls).toEqual([])
    expect(workspace.snapshot().notebooks).toEqual([])
    expect(workspace.snapshot().newNotebookTitle).toBe('Wrong account')
  })

  it('discovers accounts before settings and forces a fresh catalog', async () => {
    const calls: PorterMessage[] = []
    const workspace = makeNotebookWorkspace()
    const layer = porterClientTest({
      'porter/accounts-refresh': (msg) => {
        calls.push(msg)
        return { ok: true, accounts: [account0] }
      },
      'porter/get-settings': (msg) => {
        calls.push(msg)
        return { ok: true, settings: settings({ accounts: [account0] }) }
      },
      'porter/list-notebooks': (msg) => {
        calls.push(msg)
        return { ok: true, notebooks: [notebookA] }
      },
    })

    await Effect.runPromise(workspace.discoverAccounts().pipe(Effect.provide(layer)))

    expect(calls.map((call) => call.type)).toEqual([
      'porter/accounts-refresh',
      'porter/get-settings',
      'porter/list-notebooks',
    ])
    expect(calls[2]).toEqual({
      type: 'porter/list-notebooks',
      account: binding0,
      forceRefresh: true,
    })
  })

  it('preserves a manual selection made while refresh is pending', async () => {
    const workspace = makeNotebookWorkspace()
    const seeded = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA, notebookB] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(seeded)))

    const response = deferred<{ notebooks: NotebookMeta[] }>()
    const started = deferred<void>()
    const layer = dynamicClient((msg) => {
      if (msg.type !== 'porter/list-notebooks') return unexpected(msg)
      started.resolve()
      return Effect.promise(() => response.promise)
    })
    const refreshing = Effect.runPromise(workspace.refreshNotebooks().pipe(Effect.provide(layer)))
    await started.promise
    workspace.selectNotebook(notebookB.id)
    response.resolve({ notebooks: [notebookA, notebookB] })
    await refreshing

    expect(workspace.snapshot().selectedNotebookId).toBe(notebookB.id)
  })

  it('uses the latest captured-source set when a pending catalog resolves', async () => {
    const workspace = makeNotebookWorkspace()
    workspace.updateDocs([{ site: 'reddit' }])
    const seeded = porterClientTest({
      'porter/get-settings': () => ({
        ok: true,
        settings: settings({
          notebookTargets: { reddit: notebookA.id, youtube: notebookB.id },
        }),
      }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(seeded)))

    const response = deferred<{ notebooks: NotebookMeta[] }>()
    const started = deferred<void>()
    const layer = dynamicClient((msg) => {
      if (msg.type !== 'porter/list-notebooks') return unexpected(msg)
      started.resolve()
      return Effect.promise(() => response.promise)
    })
    const refreshing = Effect.runPromise(workspace.refreshNotebooks().pipe(Effect.provide(layer)))
    await started.promise
    workspace.updateDocs([{ site: 'youtube' }])
    response.resolve({ notebooks: [notebookA, notebookB] })
    await refreshing

    expect(workspace.snapshot().selectedNotebookId).toBe(notebookB.id)
  })

  it('lets only the latest catalog refresh publish or clear pending state', async () => {
    const workspace = makeNotebookWorkspace()
    const seeded = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(seeded)))
    const first = deferred<{ notebooks: NotebookMeta[] }>()
    const firstStarted = deferred<void>()
    const second = deferred<{ notebooks: NotebookMeta[] }>()
    const secondStarted = deferred<void>()
    let lists = 0
    const layer = dynamicClient((msg) => {
      if (msg.type !== 'porter/list-notebooks') return unexpected(msg)
      lists += 1
      if (lists === 1) {
        firstStarted.resolve()
        return Effect.promise(() => first.promise)
      }
      secondStarted.resolve()
      return Effect.promise(() => second.promise)
    })
    const oldRefresh = Effect.runPromise(workspace.refreshNotebooks().pipe(Effect.provide(layer)))
    await firstStarted.promise
    const newRefresh = Effect.runPromise(workspace.refreshNotebooks().pipe(Effect.provide(layer)))
    await secondStarted.promise
    first.resolve({ notebooks: [notebookA] })
    await oldRefresh

    expect(workspace.snapshot().notebooks).toEqual([])
    expect(workspace.snapshot().pending.refresh).toBe(true)

    second.resolve({ notebooks: [notebookB] })
    await newRefresh

    expect(workspace.snapshot().notebooks).toEqual([notebookB])
    expect(workspace.snapshot().pending.refresh).toBe(false)
  })

  it('drops a stale refresh after an account switch', async () => {
    const workspace = makeNotebookWorkspace()
    const seeded = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(seeded)))
    const stale = deferred<{ notebooks: NotebookMeta[] }>()
    const started = deferred<void>()
    const staleLayer = dynamicClient((msg) => {
      if (msg.type !== 'porter/list-notebooks') return unexpected(msg)
      expect(msg.account).toEqual(binding0)
      started.resolve()
      return Effect.promise(() => stale.promise)
    })
    const refreshing = Effect.runPromise(
      workspace.refreshNotebooks().pipe(Effect.provide(staleLayer)),
    )
    await started.promise

    const switchedSettings = settings({ nblmAuthuser: 1 })
    const switchLayer = porterClientTest({
      'porter/update-settings': () => ({ ok: true, settings: switchedSettings }),
      'porter/list-notebooks': (msg) => {
        expect(msg.account).toEqual(binding1)
        return { ok: true, notebooks: [notebookB] }
      },
    })
    await Effect.runPromise(workspace.switchAccount(1).pipe(Effect.provide(switchLayer)))
    stale.resolve({ notebooks: [notebookA] })
    await refreshing

    expect(workspace.snapshot().settings.nblmAuthuser).toBe(1)
    expect(workspace.snapshot().notebooks).toEqual([notebookB])
  })

  it('lets only the latest rapid account switch publish or clear pending state', async () => {
    const workspace = makeNotebookWorkspace()
    const first = deferred<{ settings: PorterSettings }>()
    const firstStarted = deferred<void>()
    let updates = 0
    const layer = dynamicClient((msg) => {
      if (msg.type === 'porter/update-settings') {
        updates += 1
        if (updates === 1) {
          firstStarted.resolve()
          return Effect.promise(() => first.promise)
        }
        return Effect.succeed({ settings: settings({ nblmAuthuser: 1 }) })
      }
      if (msg.type === 'porter/list-notebooks') {
        return Effect.succeed({ notebooks: [notebookB] })
      }
      return unexpected(msg)
    })
    const oldSwitch = Effect.runPromise(workspace.switchAccount(0).pipe(Effect.provide(layer)))
    await firstStarted.promise
    const newSwitch = Effect.runPromise(workspace.switchAccount(1).pipe(Effect.provide(layer)))
    await newSwitch
    first.resolve({ settings: settings({ nblmAuthuser: 0 }) })
    await oldSwitch

    expect(workspace.snapshot().settings.nblmAuthuser).toBe(1)
    expect(workspace.snapshot().notebooks).toEqual([notebookB])
    expect(workspace.snapshot().pending.switchAccount).toBe(false)
  })

  it('publishes account-discovery failure and stops before settings', async () => {
    const workspace = makeNotebookWorkspace()
    const seed = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(seed)))
    let readSettings = false
    const layer = porterClientTest({
      'porter/accounts-refresh': () => ({ ok: false, error: 'discovery failed' }),
      'porter/get-settings': () => {
        readSettings = true
        return { ok: true, settings: settings() }
      },
    })

    await Effect.runPromise(workspace.discoverAccounts().pipe(Effect.provide(layer)))

    expect(readSettings).toBe(false)
    expect(workspace.snapshot().settings).toEqual(settings())
    expect(workspace.snapshot().notebooks).toEqual([notebookA])
    expect(workspace.snapshot().error).toBe('discovery failed')
    expect(workspace.snapshot().pending.discover).toBe(false)
  })

  it('preserves the prior workspace when post-discovery settings fail', async () => {
    const workspace = makeNotebookWorkspace()
    const seed = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(seed)))
    const layer = porterClientTest({
      'porter/accounts-refresh': () => ({ ok: true, accounts: [account0, account1] }),
      'porter/get-settings': () => ({ ok: false, error: 'settings failed' }),
    })

    await Effect.runPromise(workspace.discoverAccounts().pipe(Effect.provide(layer)))

    expect(workspace.snapshot().settings).toEqual(settings())
    expect(workspace.snapshot().notebooks).toEqual([notebookA])
    expect(workspace.snapshot().error).toBe('settings failed')
  })

  it('creates from a trimmed title, selects the result, and clears the draft', async () => {
    const workspace = makeNotebookWorkspace()
    const seeded = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(seeded)))
    workspace.editNewNotebookTitle('  New notebook  ')
    const calls: PorterMessage[] = []
    const layer = porterClientTest({
      'porter/create-notebook': (msg) => {
        calls.push(msg)
        return {
          ok: true,
          notebooks: [notebookA, notebookB],
          created: notebookB,
        }
      },
    })

    await Effect.runPromise(workspace.createNotebook().pipe(Effect.provide(layer)))

    expect(calls).toEqual([
      {
        type: 'porter/create-notebook',
        account: binding0,
        title: 'New notebook',
      },
    ])
    expect(workspace.snapshot().selectedNotebookId).toBe(notebookB.id)
    expect(workspace.snapshot().newNotebookTitle).toBe('')
  })

  it('does not send a blank title and preserves a failed draft', async () => {
    const workspace = makeNotebookWorkspace()
    const seeded = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(seeded)))
    let calls = 0
    const layer = porterClientTest({
      'porter/create-notebook': () => {
        calls += 1
        return { ok: false, error: 'create failed' }
      },
    })
    workspace.editNewNotebookTitle('   ')
    await Effect.runPromise(workspace.createNotebook().pipe(Effect.provide(layer)))
    expect(calls).toBe(0)

    workspace.editNewNotebookTitle('Keep me')
    await Effect.runPromise(workspace.createNotebook().pipe(Effect.provide(layer)))
    expect(calls).toBe(1)
    expect(workspace.snapshot().newNotebookTitle).toBe('Keep me')
    expect(workspace.snapshot().error).toBe('create failed')
    expect(workspace.snapshot().pending.create).toBe(false)
  })

  it('keeps a dispatched create exclusive until its server result lands', async () => {
    const workspace = makeNotebookWorkspace()
    const seeded = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA, notebookB] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(seeded)))
    workspace.editNewNotebookTitle('One notebook')
    const created = deferred<{ notebooks: NotebookMeta[]; created: NotebookMeta }>()
    const createStarted = deferred<void>()
    const createLayer = dynamicClient((msg) => {
      if (msg.type !== 'porter/create-notebook') return unexpected(msg)
      createStarted.resolve()
      return Effect.promise(() => created.promise)
    })
    const creating = Effect.runPromise(workspace.createNotebook().pipe(Effect.provide(createLayer)))
    await createStarted.promise

    const conflictingCalls: PorterMessage[] = []
    const conflictingLayer = dynamicClient((msg) => {
      conflictingCalls.push(msg)
      return unexpected(msg)
    })
    await Effect.runPromise(workspace.switchAccount(1).pipe(Effect.provide(conflictingLayer)))
    await Effect.runPromise(workspace.refreshNotebooks().pipe(Effect.provide(conflictingLayer)))
    await Effect.runPromise(workspace.createNotebook().pipe(Effect.provide(conflictingLayer)))
    workspace.selectNotebook(notebookB.id)

    expect(conflictingCalls).toEqual([])
    expect(workspace.snapshot().selectedNotebookId).toBe(notebookA.id)
    expect(workspace.snapshot().pending.create).toBe(true)
    created.resolve({ notebooks: [notebookA, notebookB], created: notebookB })
    await creating

    expect(workspace.snapshot().notebooks).toEqual([notebookA, notebookB])
    expect(workspace.snapshot().selectedNotebookId).toBe(notebookB.id)
    expect(workspace.snapshot().newNotebookTitle).toBe('')
    expect(workspace.snapshot().pending.create).toBe(false)
  })

  it('preserves a new draft typed while create is pending', async () => {
    const workspace = makeNotebookWorkspace()
    const seeded = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(seeded)))
    workspace.editNewNotebookTitle('Same')
    const created = deferred<{ notebooks: NotebookMeta[]; created: NotebookMeta }>()
    const started = deferred<void>()
    const layer = dynamicClient((msg) => {
      if (msg.type !== 'porter/create-notebook') return unexpected(msg)
      started.resolve()
      return Effect.promise(() => created.promise)
    })
    const creating = Effect.runPromise(workspace.createNotebook().pipe(Effect.provide(layer)))
    await started.promise
    workspace.editNewNotebookTitle('Replacement')
    workspace.editNewNotebookTitle('Same')
    created.resolve({ notebooks: [notebookA], created: notebookA })
    await creating

    expect(workspace.snapshot().newNotebookTitle).toBe('Same')
    expect(workspace.snapshot().selectedNotebookId).toBe(notebookA.id)
  })

  it('ignores invalid manual notebook IDs', async () => {
    const workspace = makeNotebookWorkspace()
    const layer = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA, notebookB] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(layer)))

    workspace.selectNotebook('another-account')
    expect(workspace.snapshot().selectedNotebookId).toBe(notebookA.id)
    workspace.selectNotebook('')
    expect(workspace.snapshot().selectedNotebookId).toBe('')
  })

  it('keeps the latest Drive client ID when replies arrive out of order', async () => {
    const workspace = makeNotebookWorkspace()
    const first = deferred<{ settings: PorterSettings }>()
    const firstStarted = deferred<void>()
    let updates = 0
    const layer = dynamicClient((msg) => {
      if (msg.type !== 'porter/update-settings') return unexpected(msg)
      updates += 1
      if (updates === 1) {
        firstStarted.resolve()
        return Effect.promise(() => first.promise)
      }
      return Effect.succeed({ settings: settings({ driveClientId: 'new' }) })
    })
    const oldUpdate = Effect.runPromise(
      workspace.updateDriveClientId('old').pipe(Effect.provide(layer)),
    )
    await firstStarted.promise
    await Effect.runPromise(workspace.updateDriveClientId('new').pipe(Effect.provide(layer)))
    first.resolve({ settings: settings({ driveClientId: 'old' }) })
    await oldUpdate

    expect(workspace.snapshot().settings.driveClientId).toBe('new')
    expect(workspace.snapshot().pending.driveUpdate).toBe(false)
  })

  it('preserves a Drive edit across an overlapping account switch', async () => {
    const workspace = makeNotebookWorkspace()
    const drive = deferred<{ settings: PorterSettings }>()
    const driveStarted = deferred<void>()
    const driveLayer = dynamicClient((msg) => {
      if (msg.type !== 'porter/update-settings') return unexpected(msg)
      driveStarted.resolve()
      return Effect.promise(() => drive.promise)
    })
    const updating = Effect.runPromise(
      workspace.updateDriveClientId('old-account-id').pipe(Effect.provide(driveLayer)),
    )
    await driveStarted.promise

    const switched = settings({ nblmAuthuser: 1, driveClientId: 'current-id' })
    const switchLayer = porterClientTest({
      'porter/update-settings': () => ({ ok: true, settings: switched }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookB] }),
    })
    await Effect.runPromise(workspace.switchAccount(1).pipe(Effect.provide(switchLayer)))
    drive.resolve({ settings: settings({ driveClientId: 'old-account-id' }) })
    await updating

    expect(workspace.snapshot().settings).toEqual({
      ...switched,
      driveClientId: 'old-account-id',
    })
    expect(workspace.snapshot().pending.driveUpdate).toBe(false)
  })

  it('does not let an older bootstrap overwrite a later Drive edit', async () => {
    const workspace = makeNotebookWorkspace()
    const loaded = deferred<{ settings: PorterSettings }>()
    const loadStarted = deferred<void>()
    const bootstrapLayer = dynamicClient((msg) => {
      if (msg.type !== 'porter/get-settings') return unexpected(msg)
      loadStarted.resolve()
      return Effect.promise(() => loaded.promise)
    })
    const bootstrapping = Effect.runPromise(
      workspace.bootstrap().pipe(Effect.provide(bootstrapLayer)),
    )
    await loadStarted.promise

    const driveLayer = porterClientTest({
      'porter/update-settings': () => ({
        ok: true,
        settings: settings({ accounts: [], driveClientId: 'new' }),
      }),
    })
    await Effect.runPromise(workspace.updateDriveClientId('new').pipe(Effect.provide(driveLayer)))
    loaded.resolve({ settings: settings({ accounts: [], driveClientId: 'old' }) })
    await bootstrapping

    expect(workspace.snapshot().settings.driveClientId).toBe('new')
  })

  it('does not let bootstrap discard an earlier in-flight Drive edit', async () => {
    const workspace = makeNotebookWorkspace()
    const drive = deferred<{ settings: PorterSettings }>()
    const driveStarted = deferred<void>()
    const driveLayer = dynamicClient((msg) => {
      if (msg.type !== 'porter/update-settings') return unexpected(msg)
      driveStarted.resolve()
      return Effect.promise(() => drive.promise)
    })
    const updating = Effect.runPromise(
      workspace.updateDriveClientId('new').pipe(Effect.provide(driveLayer)),
    )
    await driveStarted.promise

    const bootstrapLayer = porterClientTest({
      'porter/get-settings': () => ({
        ok: true,
        settings: settings({ accounts: [], driveClientId: 'old' }),
      }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(bootstrapLayer)))
    drive.resolve({ settings: settings({ accounts: [], driveClientId: 'new' }) })
    await updating

    expect(workspace.snapshot().settings.driveClientId).toBe('new')
  })

  it('keeps Drive errors separate from catalog success', async () => {
    const workspace = makeNotebookWorkspace()
    const seeded = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(seeded)))
    const listed = deferred<{ notebooks: NotebookMeta[] }>()
    const listStarted = deferred<void>()
    const listLayer = dynamicClient((msg) => {
      if (msg.type !== 'porter/list-notebooks') return unexpected(msg)
      listStarted.resolve()
      return Effect.promise(() => listed.promise)
    })
    const refreshing = Effect.runPromise(
      workspace.refreshNotebooks().pipe(Effect.provide(listLayer)),
    )
    await listStarted.promise

    const driveLayer = porterClientTest({
      'porter/update-settings': () => ({ ok: false, error: 'Drive save failed' }),
    })
    await Effect.runPromise(workspace.updateDriveClientId('new').pipe(Effect.provide(driveLayer)))
    listed.resolve({ notebooks: [notebookA] })
    await refreshing

    expect(workspace.snapshot().notebooks).toEqual([notebookA])
    expect(workspace.snapshot().error).toBeUndefined()
    expect(workspace.snapshot().driveError).toBe('Drive save failed')
  })

  it('runs only one Source Console command at a time', async () => {
    const workspace = makeNotebookWorkspace()
    const seeded = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(seeded)))
    const scanned = porterClientTest({
      'porter/nblm-scan-console': () => ({ ok: true, scan: duplicateScan }),
    })
    await Effect.runPromise(workspace.scanSourceConsole().pipe(Effect.provide(scanned)))

    const deduped = deferred<{ scan: ConsoleScan; removedIds: string[] }>()
    const started = deferred<void>()
    const calls: PorterMessage[] = []
    const layer = dynamicClient((msg) => {
      calls.push(msg)
      if (msg.type !== 'porter/nblm-dedupe') return unexpected(msg)
      started.resolve()
      return Effect.promise(() => deduped.promise)
    })
    const removing = Effect.runPromise(
      workspace.removeSourceDuplicates().pipe(Effect.provide(layer)),
    )
    await started.promise
    await Effect.runPromise(workspace.scanSourceConsole().pipe(Effect.provide(layer)))
    await Effect.runPromise(workspace.retrySource(failedSource.id).pipe(Effect.provide(layer)))
    await Effect.runPromise(workspace.refreshNotebooks().pipe(Effect.provide(layer)))
    await Effect.runPromise(workspace.switchAccount(1).pipe(Effect.provide(layer)))
    workspace.editNewNotebookTitle('Blocked during console work')
    await Effect.runPromise(workspace.createNotebook().pipe(Effect.provide(layer)))
    workspace.selectNotebook(notebookB.id)

    expect(calls).toEqual([{ type: 'porter/nblm-dedupe', target: targetA }])
    expect(workspace.snapshot().selectedNotebookId).toBe(notebookA.id)
    expect(workspace.snapshot().sourceConsole.pending).toBe('dedupe')
    deduped.resolve({ scan: cleanScan, removedIds: [duplicateSource.id] })
    await removing
    expect(workspace.snapshot().sourceConsole.scan?.duplicateCount).toBe(0)
    expect(workspace.snapshot().sourceConsole.status).toBe('Removed 1 duplicate source')
    expect(workspace.snapshot().sourceConsole.pending).toBeUndefined()
  })

  it('locks its target while pending and does not revive an A scan after A-B-A', async () => {
    const workspace = makeNotebookWorkspace()
    const seeded = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA, notebookB] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(seeded)))

    const oldScan = deferred<{ scan: ConsoleScan }>()
    const oldStarted = deferred<void>()
    const oldLayer = dynamicClient((msg) => {
      if (msg.type !== 'porter/nblm-scan-console') return unexpected(msg)
      expect(msg.target).toEqual(targetA)
      oldStarted.resolve()
      return Effect.promise(() => oldScan.promise)
    })
    const oldRequest = Effect.runPromise(
      workspace.scanSourceConsole().pipe(Effect.provide(oldLayer)),
    )
    await oldStarted.promise
    workspace.selectNotebook(notebookB.id)
    expect(workspace.snapshot().selectedNotebookId).toBe(notebookA.id)
    oldScan.resolve({ scan: duplicateScan })
    await oldRequest
    expect(workspace.snapshot().sourceConsole.scan?.duplicateCount).toBe(1)

    workspace.selectNotebook(notebookB.id)
    workspace.selectNotebook(notebookA.id)
    expect(workspace.snapshot().sourceConsole.scan).toBeUndefined()

    let staleDedupeSent = false
    const destructiveLayer = dynamicClient((msg) => {
      staleDedupeSent = true
      return unexpected(msg)
    })
    await Effect.runPromise(
      workspace.removeSourceDuplicates().pipe(Effect.provide(destructiveLayer)),
    )
    const currentLayer = porterClientTest({
      'porter/nblm-scan-console': () => ({ ok: true, scan: cleanScan }),
    })
    await Effect.runPromise(workspace.scanSourceConsole().pipe(Effect.provide(currentLayer)))

    expect(staleDedupeSent).toBe(false)
    expect(workspace.snapshot().sourceConsole.scan?.duplicateCount).toBe(0)
    expect(workspace.snapshot().sourceConsole.pending).toBeUndefined()
  })

  it('clears an unsafe Source Console scan when a mutation fails', async () => {
    const workspace = makeNotebookWorkspace()
    const seeded = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA] }),
      'porter/nblm-scan-console': () => ({ ok: true, scan: duplicateScan }),
      'porter/nblm-dedupe': () => ({ ok: false, error: 'Delete uncertain' }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(seeded)))
    await Effect.runPromise(workspace.scanSourceConsole().pipe(Effect.provide(seeded)))
    await Effect.runPromise(workspace.removeSourceDuplicates().pipe(Effect.provide(seeded)))

    expect(workspace.snapshot().sourceConsole.scan).toBeUndefined()
    expect(workspace.snapshot().sourceConsole.status).toBe('Delete uncertain')
    expect(workspace.snapshot().sourceConsole.pending).toBeUndefined()
  })

  it('keeps the last safe scan when a read-only re-scan fails', async () => {
    const workspace = makeNotebookWorkspace()
    const calls: PorterMessage[] = []
    let scans = 0
    const layer = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA] }),
      'porter/nblm-scan-console': (msg) => {
        calls.push(msg)
        scans += 1
        return scans === 1
          ? { ok: true, scan: duplicateScan }
          : { ok: false, error: 'Scan unavailable' }
      },
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(layer)))
    await Effect.runPromise(workspace.scanSourceConsole().pipe(Effect.provide(layer)))
    await Effect.runPromise(workspace.scanSourceConsole().pipe(Effect.provide(layer)))

    expect(calls).toEqual([
      { type: 'porter/nblm-scan-console', target: targetA },
      { type: 'porter/nblm-scan-console', target: targetA },
    ])
    expect(workspace.snapshot().sourceConsole.scan?.duplicateCount).toBe(1)
    expect(workspace.snapshot().sourceConsole.status).toBe('Scan unavailable')
    expect(workspace.snapshot().sourceConsole.pending).toBeUndefined()
  })

  it('clears an unsafe Source Console scan when retry fails', async () => {
    const workspace = makeNotebookWorkspace()
    const layer = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA] }),
      'porter/nblm-scan-console': () => ({ ok: true, scan: duplicateScan }),
      'porter/nblm-retry-source': (msg) => {
        expect(msg).toEqual({
          type: 'porter/nblm-retry-source',
          target: targetA,
          sourceId: failedSource.id,
        })
        return { ok: false, error: 'Retry uncertain' }
      },
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(layer)))
    await Effect.runPromise(workspace.scanSourceConsole().pipe(Effect.provide(layer)))
    await Effect.runPromise(workspace.retrySource(failedSource.id).pipe(Effect.provide(layer)))

    expect(workspace.snapshot().sourceConsole.scan).toBeUndefined()
    expect(workspace.snapshot().sourceConsole.status).toBe('Retry uncertain')
    expect(workspace.snapshot().sourceConsole.pending).toBeUndefined()
  })

  it('retries only a currently diagnosed refreshable source', async () => {
    const workspace = makeNotebookWorkspace()
    const calls: PorterMessage[] = []
    const layer = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA] }),
      'porter/nblm-scan-console': () => ({ ok: true, scan: duplicateScan }),
      'porter/nblm-retry-source': (msg) => {
        calls.push(msg)
        return { ok: true, scan: cleanScan }
      },
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(layer)))
    await Effect.runPromise(workspace.retrySource('not-diagnosed').pipe(Effect.provide(layer)))
    await Effect.runPromise(workspace.scanSourceConsole().pipe(Effect.provide(layer)))
    await Effect.runPromise(workspace.retrySource(failedSource.id).pipe(Effect.provide(layer)))

    expect(calls).toEqual([
      {
        type: 'porter/nblm-retry-source',
        target: targetA,
        sourceId: failedSource.id,
      },
    ])
    expect(workspace.snapshot().sourceConsole.scan?.failed).toEqual([])
    expect(workspace.snapshot().sourceConsole.status).toContain('Retry requested')
  })

  it('rejects notebook operations while account context is unresolved', async () => {
    const workspace = makeNotebookWorkspace()
    const seeded = porterClientTest({
      'porter/get-settings': () => ({ ok: true, settings: settings() }),
      'porter/list-notebooks': () => ({ ok: true, notebooks: [notebookA] }),
    })
    await Effect.runPromise(workspace.bootstrap().pipe(Effect.provide(seeded)))

    const accountSettings = deferred<{ settings: PorterSettings }>()
    const settingsStarted = deferred<void>()
    let lists = 0
    const layer = dynamicClient((msg) => {
      if (msg.type === 'porter/accounts-refresh') return Effect.succeed({ accounts: [] })
      if (msg.type === 'porter/get-settings') {
        settingsStarted.resolve()
        return Effect.promise(() => accountSettings.promise)
      }
      if (msg.type === 'porter/list-notebooks') {
        lists += 1
        return Effect.succeed({ notebooks: [notebookA] })
      }
      return unexpected(msg)
    })
    const discovering = Effect.runPromise(workspace.discoverAccounts().pipe(Effect.provide(layer)))
    await settingsStarted.promise
    await Effect.runPromise(workspace.refreshNotebooks().pipe(Effect.provide(layer)))
    workspace.editNewNotebookTitle('Blocked')
    await Effect.runPromise(workspace.createNotebook().pipe(Effect.provide(layer)))
    accountSettings.resolve({ settings: settings({ accounts: [] }) })
    await discovering

    expect(lists).toBe(0)
    expect(workspace.snapshot().notebooks).toEqual([])
    expect(workspace.snapshot().selectedNotebookId).toBe('')
    expect(workspace.snapshot().newNotebookTitle).toBe('Blocked')
  })
})
