import { Effect, Result } from 'effect'
import { useEffect, useRef, useState } from 'preact/hooks'
import { filterDebugEntries, type DebugEntry, type DebugLevel } from '../../core/debug'
import { Tabs } from '../../core/fx/services'
import { popupRuntime } from '../../core/fx/runtime-popup'
import type { ConsoleScan } from '../../core/ingest/sources/console'
import type { SourceDoc } from '../../core/model/types'
import { PorterClient, type NotebookMeta } from '../../core/messaging'
import { summarizeQueue, type QueueSnapshot } from '../../core/queue/queue'
import { DEFAULT_SETTINGS, resolveNotebookTarget, type PorterSettings } from '../../core/settings'
import { canWatchSource } from '../../core/watch/eligibility'
import type { WatchView } from '../../core/watch/watch'
import { useAction } from './useAction'
import { useGenerationGuard } from './useGenerationGuard'

/**
 * Popup: detect what the active tab offers, one-click capture, then a
 * queue of captured docs with export / ingest actions.
 *
 * TODO(codegen): full UI per docs/superpowers/specs design §Popup.
 */

function levelClass(level: DebugLevel | undefined): string {
  if (level === 'error') return 'text-red-600'
  if (level === 'warn') return 'text-amber-600'
  return 'text-gray-400'
}

function formatDebugTime(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString()
}

async function clearDebugLog() {
  await popupRuntime.runPromise(
    Effect.catchTag(
      Effect.gen(function* () {
        const client = yield* PorterClient
        yield* client.request({ type: 'porter/debug-clear' })
      }),
      'IpcError',
      () => Effect.succeed(undefined),
    ),
  )
}

export function App() {
  const [docs, setDocs] = useState<SourceDoc[]>([])
  const [capturable, setCapturable] = useState<string | undefined>()
  const [canEnrichTranscripts, setCanEnrichTranscripts] = useState(false)
  const [enrichTranscripts, setEnrichTranscripts] = useState(false)
  const [settings, setSettings] = useState<PorterSettings>(DEFAULT_SETTINGS)
  const [backupResult, setBackupResult] = useState<{ text: string; isError: boolean } | undefined>()
  const [notebooks, setNotebooks] = useState<NotebookMeta[]>([])
  const [notebooksError, setNotebooksError] = useState<string | undefined>()
  const [selectedNotebookId, setSelectedNotebookId] = useState('')
  const [newNotebookTitle, setNewNotebookTitle] = useState('')
  const [ingestResult, setIngestResult] = useState<
    | { queued: number; failed: number; uncertain: number; blocked: number; error?: string }
    | undefined
  >()
  const [retryJobIds, setRetryJobIds] = useState<string[]>([])
  const [watches, setWatches] = useState<WatchView[]>([])
  const [watchError, setWatchError] = useState<string | undefined>()
  const [debugCopyStatus, setDebugCopyStatus] = useState<string | undefined>()
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([])
  const [debugQuery, setDebugQuery] = useState('')
  const [debugLevel, setDebugLevel] = useState<'all' | DebugLevel>('all')
  const [debugLoading, setDebugLoading] = useState(false)
  const [switchingAccount, setSwitchingAccount] = useState(false)
  const [consoleScan, setConsoleScan] = useState<ConsoleScan | undefined>()
  const [consoleStatus, setConsoleStatus] = useState<string | undefined>()
  const notebookLoadGuard = useGenerationGuard()
  // Not converted to useGenerationGuard: createNotebookAction peeks this
  // counter's current value without starting a new generation (see below),
  // which the begin()/isCurrent() pair can't express.
  const accountLoadGeneration = useRef(0)
  const accountSwitchGuard = useGenerationGuard()

  function applyNotebookList(
    list: NotebookMeta[],
    listSettings: PorterSettings,
    listDocs: SourceDoc[],
    currentId: string,
    generation: number,
  ) {
    if (!notebookLoadGuard.isCurrent(generation)) return
    setNotebooks(list)
    setSelectedNotebookId(
      resolveNotebookTarget(list, listDocs, listSettings.notebookTargets, currentId),
    )
  }

  function applyQueueSnapshot(queue: QueueSnapshot) {
    const summary = summarizeQueue(queue)
    if (summary === undefined) {
      setIngestResult(undefined)
      setRetryJobIds([])
      return
    }
    setIngestResult({
      queued: summary.queued,
      failed: summary.failed,
      uncertain: summary.uncertain,
      blocked: summary.blocked,
      ...(summary.error !== undefined ? { error: summary.error } : {}),
    })
    setRetryJobIds(summary.retryJobIds)
  }

  // Shared with accountsAction (FIX 3) so discovering accounts for the first
  // time also populates the notebook list, instead of composing via a faked
  // click on loadNotebooksAction.
  const loadNotebooksEffect = Effect.gen(function* () {
    const generation = notebookLoadGuard.begin()
    setNotebooksError(undefined)
    const client = yield* PorterClient
    const result = yield* Effect.result(
      client.request({ type: 'porter/list-notebooks', forceRefresh: true }),
    )
    if (Result.isFailure(result)) {
      if (notebookLoadGuard.isCurrent(generation)) {
        setNotebooksError(result.failure.reason)
      }
      return
    }
    const list = result.success.notebooks
    applyNotebookList(list, settings, docs, selectedNotebookId, generation)
  })

  const loadNotebooksAction = useAction<[]>(() => loadNotebooksEffect)

  const createNotebookAction = useAction<[]>(() =>
    Effect.gen(function* () {
      const accountGeneration = accountLoadGeneration.current
      const title = newNotebookTitle.trim()
      if (title === '') return
      setNotebooksError(undefined)
      const client = yield* PorterClient
      const result = yield* Effect.result(client.request({ type: 'porter/create-notebook', title }))
      if (Result.isFailure(result)) {
        if (accountLoadGeneration.current === accountGeneration) {
          setNotebooksError(result.failure.reason)
        }
        return
      }
      if (accountLoadGeneration.current !== accountGeneration) return
      const generation = notebookLoadGuard.begin()
      applyNotebookList(
        result.success.notebooks,
        settings,
        docs,
        result.success.created.id,
        generation,
      )
      setNewNotebookTitle('')
    }),
  )

  const refreshEffect = Effect.gen(function* () {
    const accountGeneration = ++accountLoadGeneration.current
    const client = yield* PorterClient
    const tabs = yield* Tabs
    const tab = yield* tabs.activeTab()
    if (tab.url) {
      const detected = yield* Effect.result(client.request({ type: 'porter/detect', url: tab.url }))
      if (Result.isSuccess(detected)) {
        setCapturable(detected.success.capturable)
        setCanEnrichTranscripts(detected.success.canEnrichTranscripts === true)
        if (!detected.success.canEnrichTranscripts) setEnrichTranscripts(false)
      }
    }
    const listed = yield* Effect.result(client.request({ type: 'porter/list-docs' }))
    const listedDocs = Result.isSuccess(listed) ? listed.success.docs : docs
    if (Result.isSuccess(listed)) setDocs(listedDocs)
    const settingsResult = yield* Effect.result(client.request({ type: 'porter/get-settings' }))
    if (Result.isSuccess(settingsResult)) {
      if (accountLoadGeneration.current !== accountGeneration) return
      setSettings(settingsResult.success.settings)
      if (settingsResult.success.settings.accounts.length > 0) {
        const generation = notebookLoadGuard.begin()
        const notebooksResult = yield* Effect.result(
          client.request({ type: 'porter/list-notebooks' }),
        )
        if (Result.isFailure(notebooksResult)) {
          if (accountLoadGeneration.current === accountGeneration) {
            setNotebooksError(notebooksResult.failure.reason)
          }
        } else {
          if (accountLoadGeneration.current !== accountGeneration) return
          applyNotebookList(
            notebooksResult.success.notebooks,
            settingsResult.success.settings,
            listedDocs,
            selectedNotebookId,
            generation,
          )
        }
      }
    }
    const queueResult = yield* Effect.result(client.request({ type: 'porter/queue-status' }))
    if (Result.isSuccess(queueResult)) applyQueueSnapshot(queueResult.success.queue)
    const watchesResult = yield* Effect.result(client.request({ type: 'porter/watch-list' }))
    if (Result.isSuccess(watchesResult)) setWatches(watchesResult.success.watches)
  })

  function refresh() {
    return popupRuntime.runPromise(refreshEffect)
  }

  useEffect(() => {
    void refresh()
    // Mount-only refresh — refresh is a plain function redefined each render,
    // not a reactive dependency; including it would re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const captureAction = useAction<[]>(() =>
    Effect.gen(function* () {
      const client = yield* PorterClient
      const tabs = yield* Tabs
      const tab = yield* tabs.activeTab()
      if (!tab.id || !tab.url) return
      const result = yield* Effect.result(
        client.request({
          type: 'porter/capture-url',
          url: tab.url,
          tabId: tab.id,
          ...(enrichTranscripts ? { options: { enrichTranscripts: true as const } } : {}),
        }),
      )
      yield* refreshEffect
      if (Result.isFailure(result)) return yield* Effect.fail(result.failure)
    }),
  )

  const ingestAction = useAction<[string[]]>((docIds) =>
    Effect.gen(function* () {
      if (selectedNotebookId === '') return
      setIngestResult(undefined)
      setRetryJobIds([])
      const client = yield* PorterClient
      const result = yield* Effect.result(
        client.request({
          type: 'porter/queue-enqueue',
          docIds,
          notebookId: selectedNotebookId,
        }),
      )
      if (Result.isFailure(result)) {
        setIngestResult({
          queued: 0,
          failed: 1,
          uncertain: 0,
          blocked: 0,
          error: result.failure.reason,
        })
        return
      }
      applyQueueSnapshot(result.success.queue)
    }),
  )

  const retryQueueAction = useAction<[string[]]>((jobIds) =>
    Effect.gen(function* () {
      const client = yield* PorterClient
      const result = yield* Effect.result(client.request({ type: 'porter/queue-retry', jobIds }))
      if (Result.isFailure(result)) {
        setIngestResult({
          queued: 0,
          failed: 1,
          uncertain: 0,
          blocked: 0,
          error: result.failure.reason,
        })
        return
      }
      applyQueueSnapshot(result.success.queue)
    }),
  )

  const watchAction = useAction<[string]>((docId) =>
    Effect.gen(function* () {
      if (selectedNotebookId === '') return
      setWatchError(undefined)
      const client = yield* PorterClient
      const result = yield* Effect.result(
        client.request({ type: 'porter/watch-create', docId, notebookId: selectedNotebookId }),
      )
      if (Result.isFailure(result)) {
        setWatchError(result.failure.reason)
        return
      }
      setWatches(result.success.watches)
    }),
  )

  const unwatchAction = useAction<[string]>((watchId) =>
    Effect.gen(function* () {
      setWatchError(undefined)
      const client = yield* PorterClient
      const result = yield* Effect.result(client.request({ type: 'porter/watch-remove', watchId }))
      if (Result.isFailure(result)) {
        setWatchError(result.failure.reason)
        return
      }
      setWatches(result.success.watches)
    }),
  )

  const accountsAction = useAction<[]>(() =>
    Effect.gen(function* () {
      const accountGeneration = ++accountLoadGeneration.current
      const client = yield* PorterClient
      const result = yield* Effect.result(client.request({ type: 'porter/accounts-refresh' }))
      if (Result.isFailure(result)) return
      const settingsResult = yield* Effect.result(client.request({ type: 'porter/get-settings' }))
      if (Result.isFailure(settingsResult)) return
      if (accountLoadGeneration.current !== accountGeneration) return
      setSettings(settingsResult.success.settings)
      if (settingsResult.success.settings.accounts.length > 0) {
        const generation = notebookLoadGuard.begin()
        const notebooksResult = yield* Effect.result(
          client.request({ type: 'porter/list-notebooks', forceRefresh: true }),
        )
        if (Result.isFailure(notebooksResult)) {
          if (accountLoadGeneration.current === accountGeneration) {
            setNotebooksError(notebooksResult.failure.reason)
          }
        } else {
          if (accountLoadGeneration.current !== accountGeneration) return
          applyNotebookList(
            notebooksResult.success.notebooks,
            settingsResult.success.settings,
            docs,
            '',
            generation,
          )
        }
      }
    }),
  )

  const backupAction = useAction<[]>(() =>
    Effect.gen(function* () {
      setBackupResult(undefined)
      const client = yield* PorterClient
      const result = yield* Effect.result(
        client.request({ type: 'porter/backup-drive', docIds: docs.map((doc) => doc.id) }),
      )
      if (Result.isFailure(result)) {
        setBackupResult({ text: result.failure.reason, isError: true })
        return
      }
      const outcomes = result.success.backup
      const failed = outcomes.find((o) => !o.ok)
      const okCount = outcomes.filter((o) => o.ok).length
      setBackupResult(
        failed
          ? { text: failed.error ?? 'Backup failed', isError: true }
          : { text: `${okCount} backed up to Drive`, isError: false },
      )
    }),
  )

  function selectAccount(authuser: number) {
    setSwitchingAccount(true)
    const switchGeneration = accountSwitchGuard.begin()
    const accountGeneration = ++accountLoadGeneration.current
    const generation = notebookLoadGuard.begin()
    setSelectedNotebookId('')
    setNotebooks([])
    setNotebooksError(undefined)
    return popupRuntime
      .runPromise(
        Effect.gen(function* () {
          const client = yield* PorterClient
          const result = yield* Effect.result(
            client.request({ type: 'porter/update-settings', patch: { nblmAuthuser: authuser } }),
          )
          if (Result.isFailure(result)) {
            setNotebooksError(result.failure.reason)
            return
          }
          if (accountLoadGeneration.current !== accountGeneration) return
          setSettings(result.success.settings)
          const listed = yield* Effect.result(client.request({ type: 'porter/list-notebooks' }))
          if (Result.isFailure(listed)) {
            if (accountLoadGeneration.current !== accountGeneration) return
            setNotebooksError(listed.failure.reason)
            return
          }
          if (accountLoadGeneration.current !== accountGeneration) return
          applyNotebookList(listed.success.notebooks, result.success.settings, docs, '', generation)
        }),
      )
      .catch((err: unknown) => {
        if (accountLoadGeneration.current === accountGeneration) {
          setNotebooksError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (accountSwitchGuard.isCurrent(switchGeneration)) setSwitchingAccount(false)
      })
  }

  const scanConsoleAction = useAction<[]>(() =>
    Effect.gen(function* () {
      const client = yield* PorterClient
      const result = yield* Effect.result(
        client.request({ type: 'porter/nblm-scan-console', notebookId: selectedNotebookId }),
      )
      if (Result.isFailure(result)) {
        setConsoleStatus(result.failure.reason)
        return
      }
      setConsoleScan(result.success.scan)
      setConsoleStatus(undefined)
    }),
  )

  const dedupeAction = useAction<[]>(() =>
    Effect.gen(function* () {
      const client = yield* PorterClient
      const result = yield* Effect.result(
        client.request({ type: 'porter/nblm-dedupe', notebookId: selectedNotebookId }),
      )
      if (Result.isFailure(result)) {
        setConsoleStatus(result.failure.reason)
        return
      }
      const removed = result.success.removedIds.length
      setConsoleScan(result.success.scan)
      setConsoleStatus(`Removed ${removed} duplicate source${removed === 1 ? '' : 's'}`)
    }),
  )

  const retrySourceAction = useAction<[string]>((sourceId) =>
    Effect.gen(function* () {
      const client = yield* PorterClient
      const result = yield* Effect.result(
        client.request({
          type: 'porter/nblm-retry-source',
          notebookId: selectedNotebookId,
          sourceId,
        }),
      )
      if (Result.isFailure(result)) {
        setConsoleStatus(result.failure.reason)
        return
      }
      setConsoleScan(result.success.scan)
      setConsoleStatus('Retry requested — re-scan in a moment to see the new status')
    }),
  )

  function updateDriveClientId(driveClientId: string) {
    return popupRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* PorterClient
        const result = yield* Effect.result(
          client.request({ type: 'porter/update-settings', patch: { driveClientId } }),
        )
        if (Result.isSuccess(result)) setSettings(result.success.settings)
      }),
    )
  }

  function flashDebugStatus(text: string) {
    setDebugCopyStatus(text)
    setTimeout(() => setDebugCopyStatus(undefined), 2000)
  }

  async function fetchDebugEntries(): Promise<DebugEntry[] | undefined> {
    setDebugLoading(true)
    const result = await popupRuntime.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const client = yield* PorterClient
          const { debugLog } = yield* client.request({ type: 'porter/debug-log' })
          return debugLog
        }),
      ),
    )
    setDebugLoading(false)
    if (Result.isFailure(result)) {
      flashDebugStatus(result.failure.reason)
      return undefined
    }
    setDebugEntries(result.success)
    return result.success
  }

  async function copyDebugLog() {
    const entries = await fetchDebugEntries()
    if (entries === undefined) return
    await navigator.clipboard.writeText(JSON.stringify(entries, null, 2))
    flashDebugStatus(`copied (${entries.length} entries)`)
  }

  async function downloadDebugLog() {
    const entries = await fetchDebugEntries()
    if (entries === undefined) return
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `porter-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    flashDebugStatus(`downloaded (${entries.length})`)
  }

  async function resetDebugLog() {
    await clearDebugLog()
    setDebugEntries([])
    flashDebugStatus('cleared')
  }

  const filteredDebugEntries = filterDebugEntries(debugEntries, debugQuery, debugLevel)

  return (
    <div class="p-4 font-sans text-sm">
      <h1 class="mb-1 text-base font-semibold">NotebookLM Porter</h1>
      <div class="mb-3 flex items-center gap-2">
        {settings.accounts.length > 0 && (
          <select
            class="flex-1 rounded border border-gray-200 px-2 py-1 text-sm"
            value={settings.nblmAuthuser}
            disabled={switchingAccount}
            onChange={(e) => void selectAccount(Number(e.currentTarget.value))}
          >
            {settings.accounts.map((account) => (
              <option key={account.authuser} value={account.authuser}>
                {account.email}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          class={
            settings.accounts.length > 0
              ? 'text-gray-500 disabled:opacity-50'
              : 'text-blue-600 disabled:opacity-50'
          }
          disabled={accountsAction.busy || switchingAccount}
          onClick={() => accountsAction.run()}
        >
          {accountsAction.busy
            ? 'Finding accounts…'
            : settings.accounts.length > 0
              ? '↻'
              : '↻ find accounts'}
        </button>
      </div>
      {capturable ? (
        <div class="mb-3">
          {canEnrichTranscripts && (
            <label class="mb-2 flex cursor-pointer items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={enrichTranscripts}
                disabled={captureAction.busy}
                onChange={(event) => setEnrichTranscripts(event.currentTarget.checked)}
              />
              <span>
                Capture available transcripts (up to 200 videos). Videos without a transcript use
                YouTube import.
              </span>
            </label>
          )}
          <button
            type="button"
            class="w-full rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50"
            disabled={captureAction.busy}
            onClick={() => captureAction.run()}
          >
            {captureAction.busy ? 'Capturing…' : capturable}
          </button>
        </div>
      ) : (
        <p class="mb-3 text-gray-500">Nothing capturable on this page.</p>
      )}
      {captureAction.error && <p class="mb-3 text-red-600">{captureAction.error}</p>}
      <ul class="space-y-2">
        {docs.map((doc) => {
          const docWatches = watches.filter((watch) => watch.sourceDocId === doc.id)
          const canWatch = canWatchSource(doc)
          const watchForSelectedNotebook = docWatches.find(
            (watch) => watch.notebookId === selectedNotebookId,
          )
          return (
            <li key={doc.id} class="rounded border border-gray-200 p-2">
              <span class="font-medium">{doc.title}</span>
              <span class="ml-1 text-gray-400">
                {doc.kind === 'playlist'
                  ? '(playlist overview + individual videos)'
                  : `(${doc.wordCount.toLocaleString()} words)`}
              </span>
              {docWatches.map((watch) => (
                <div key={watch.id} class="mt-1 flex items-center gap-2 text-xs text-gray-500">
                  <span>
                    Auto-sync{' '}
                    {notebooks.find((notebook) => notebook.id === watch.notebookId)?.title ??
                      watch.notebookId}{' '}
                    ·{' '}
                    {watch.status === 'active'
                      ? `next ${new Date(watch.nextRunAt).toLocaleString()}`
                      : 'disabled'}
                  </span>
                  {watch.lastError && <span class="text-red-600">{watch.lastError}</span>}
                  <button
                    type="button"
                    class="text-red-600 disabled:opacity-50"
                    disabled={unwatchAction.busy}
                    onClick={() => unwatchAction.run(watch.id)}
                  >
                    Stop
                  </button>
                </div>
              ))}
              {canWatch &&
                selectedNotebookId !== '' &&
                (watchForSelectedNotebook === undefined ||
                  watchForSelectedNotebook.status === 'disabled') && (
                  <button
                    type="button"
                    class="mt-1 text-xs text-blue-600 disabled:opacity-50"
                    disabled={watchAction.busy || switchingAccount}
                    onClick={() => watchAction.run(doc.id)}
                  >
                    {watchForSelectedNotebook?.status === 'disabled'
                      ? 'Resume watch every 6 hours'
                      : 'Watch every 6 hours'}
                  </button>
                )}
            </li>
          )
        })}
      </ul>
      {watchError && <p class="mt-2 text-xs text-red-600">{watchError}</p>}
      {docs.length > 0 && (
        <>
          {settings.accounts.length > 0 && (
            <div class="mt-3 flex items-center gap-2">
              <select
                class="flex-1 rounded border border-gray-200 px-2 py-1 text-sm"
                value={selectedNotebookId}
                disabled={switchingAccount}
                onChange={(e) => setSelectedNotebookId(e.currentTarget.value)}
              >
                <option value="" disabled>
                  Choose a notebook…
                </option>
                {notebooks.map((notebook) => (
                  <option key={notebook.id} value={notebook.id}>
                    {notebook.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                class="text-gray-500 disabled:opacity-50"
                disabled={switchingAccount || loadNotebooksAction.busy}
                onClick={() => loadNotebooksAction.run()}
              >
                {loadNotebooksAction.busy ? 'Loading…' : '↻'}
              </button>
            </div>
          )}
          {settings.accounts.length > 0 && (
            <div class="mt-2 flex items-center gap-2">
              <input
                type="text"
                class="flex-1 rounded border border-gray-200 px-2 py-1 text-sm"
                placeholder="New notebook title…"
                value={newNotebookTitle}
                onChange={(e) => setNewNotebookTitle(e.currentTarget.value)}
              />
              <button
                type="button"
                class="rounded border border-gray-300 px-2 py-1 text-gray-700 disabled:opacity-50"
                disabled={
                  switchingAccount || createNotebookAction.busy || newNotebookTitle.trim() === ''
                }
                onClick={() => createNotebookAction.run()}
              >
                {createNotebookAction.busy ? 'Creating…' : 'Create'}
              </button>
            </div>
          )}
          {notebooksError && <p class="mt-1 text-xs text-red-600">{notebooksError}</p>}
          <button
            type="button"
            class="mt-2 w-full rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50"
            disabled={switchingAccount || ingestAction.busy || selectedNotebookId === ''}
            onClick={() => ingestAction.run(docs.map((doc) => doc.id))}
          >
            {ingestAction.busy ? 'Sending…' : 'Send to NotebookLM'}
          </button>
          {ingestResult && (
            <div
              class={`mt-1 text-xs ${ingestResult.failed > 0 || ingestResult.blocked > 0 ? 'text-red-600' : 'text-gray-500'}`}
            >
              <p>
                {ingestResult.queued} queued; continues in background
                {ingestResult.failed > 0 && ` · ${ingestResult.failed} failed`}
                {ingestResult.uncertain > 0 && ` · ${ingestResult.uncertain} need review`}
                {ingestResult.blocked > 0 && ` · ${ingestResult.blocked} need a new target`}
              </p>
              {ingestResult.error && <p>{ingestResult.error}</p>}
              {retryJobIds.length > 0 && (
                <button
                  type="button"
                  class="mt-1 rounded border border-gray-300 px-2 py-1 text-gray-700 disabled:opacity-50"
                  disabled={retryQueueAction.busy}
                  onClick={() => retryQueueAction.run(retryJobIds)}
                >
                  {ingestResult.uncertain > 0 ? 'Retry anyway' : 'Retry failed'}
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            class="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-gray-700 disabled:opacity-50"
            disabled={backupAction.busy}
            onClick={() => backupAction.run()}
          >
            {backupAction.busy ? 'Backing up…' : 'Back up to Drive'}
          </button>
          {backupResult && (
            <p class={`mt-1 text-xs ${backupResult.isError ? 'text-red-600' : 'text-gray-500'}`}>
              {backupResult.text}
            </p>
          )}
        </>
      )}
      <details
        class="mt-3"
        onToggle={(e) => {
          if (e.currentTarget.open && notebooks.length === 0 && settings.accounts.length > 0) {
            loadNotebooksAction.run()
          }
        }}
      >
        <summary class="cursor-pointer text-gray-500">Manage notebook sources</summary>
        <div class="mt-2">
          <p class="mb-2 text-xs text-gray-400">
            Scan a NotebookLM notebook for duplicate sources and failed loads, then remove or retry
            them.
          </p>
          {settings.accounts.length === 0 ? (
            <p class="text-xs text-gray-400">Find your NotebookLM accounts first (↻ above).</p>
          ) : (
            <>
              <div class="flex items-center gap-2">
                <select
                  class="flex-1 rounded border border-gray-200 px-2 py-1 text-sm"
                  value={selectedNotebookId}
                  disabled={switchingAccount}
                  onChange={(e) => setSelectedNotebookId(e.currentTarget.value)}
                >
                  <option value="" disabled>
                    Choose a notebook…
                  </option>
                  {notebooks.map((notebook) => (
                    <option key={notebook.id} value={notebook.id}>
                      {notebook.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  class="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
                  disabled={scanConsoleAction.busy || switchingAccount || selectedNotebookId === ''}
                  onClick={() => scanConsoleAction.run()}
                >
                  {scanConsoleAction.busy ? 'Scanning…' : 'Scan'}
                </button>
              </div>
              {consoleStatus && <p class="mt-1 text-xs text-gray-500">{consoleStatus}</p>}
              {consoleScan && (
                <div class="mt-2 space-y-2">
                  <p class="text-xs text-gray-500">
                    {consoleScan.sources.length} sources · {consoleScan.duplicateCount} duplicate
                    {consoleScan.duplicateCount === 1 ? '' : 's'} · {consoleScan.failed.length}{' '}
                    failed
                  </p>
                  {consoleScan.duplicateCount > 0 && (
                    <button
                      type="button"
                      class="w-full rounded bg-red-600 px-3 py-2 text-white disabled:opacity-50"
                      disabled={dedupeAction.busy || switchingAccount}
                      onClick={() => dedupeAction.run()}
                    >
                      {dedupeAction.busy
                        ? 'Removing…'
                        : `Remove ${consoleScan.duplicateCount} duplicate${consoleScan.duplicateCount === 1 ? '' : 's'}`}
                    </button>
                  )}
                  {consoleScan.duplicateGroups.map((group) => (
                    <div key={group.key} class="rounded border border-gray-200 p-2 text-xs">
                      <div class="font-medium">Keep: {group.keep.title}</div>
                      <div class="text-gray-500">
                        Remove {group.remove.length}: {group.remove.map((s) => s.title).join(', ')}
                      </div>
                    </div>
                  ))}
                  {consoleScan.failed.map((diagnosis) => (
                    <div
                      key={diagnosis.source.id}
                      class="rounded border border-red-200 p-2 text-xs"
                    >
                      <div class="font-medium text-red-700">{diagnosis.source.title}</div>
                      <div class="text-gray-500">{diagnosis.reason}</div>
                      {diagnosis.retry === 'refresh' && (
                        <button
                          type="button"
                          class="mt-1 text-blue-600 disabled:opacity-50"
                          disabled={retrySourceAction.busy || switchingAccount}
                          onClick={() => retrySourceAction.run(diagnosis.source.id)}
                        >
                          Retry load
                        </button>
                      )}
                    </div>
                  ))}
                  {consoleScan.duplicateCount === 0 && consoleScan.failed.length === 0 && (
                    <p class="text-xs text-gray-400">No duplicate or failed sources found.</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </details>
      <details class="mt-3">
        <summary class="cursor-pointer text-gray-500">Settings</summary>
        <div class="mt-2">
          <label class="mb-1 block text-gray-700" for="drive-client-id">
            Drive OAuth Client ID
          </label>
          <input
            id="drive-client-id"
            type="text"
            class="w-full rounded border border-gray-200 px-2 py-1 text-sm"
            value={settings.driveClientId ?? ''}
            onChange={(e) => void updateDriveClientId(e.currentTarget.value)}
          />
          <p class="mt-1 text-xs text-gray-400">
            OAuth client (Chrome Extension type) from Google Cloud Console
          </p>
        </div>
      </details>
      <details
        class="mt-3"
        onToggle={(e) => {
          if (e.currentTarget.open && debugEntries.length === 0) void fetchDebugEntries()
        }}
      >
        <summary class="cursor-pointer text-gray-500">Debug log</summary>
        <div class="mt-2">
          <div class="mb-2 flex flex-wrap items-center gap-1">
            <button
              type="button"
              class="rounded border border-gray-300 px-2 py-1 text-gray-700 disabled:opacity-50"
              disabled={debugLoading}
              onClick={() => void fetchDebugEntries()}
            >
              {debugLoading ? 'Loading…' : '↻ Refresh'}
            </button>
            <button
              type="button"
              class="rounded border border-gray-300 px-2 py-1 text-gray-700"
              onClick={() => void copyDebugLog()}
            >
              Copy
            </button>
            <button
              type="button"
              class="rounded border border-gray-300 px-2 py-1 text-gray-700"
              onClick={() => void downloadDebugLog()}
            >
              Download
            </button>
            <button type="button" class="text-gray-500" onClick={() => void resetDebugLog()}>
              Clear
            </button>
            {debugCopyStatus && <span class="text-xs text-gray-400">{debugCopyStatus}</span>}
          </div>
          <div class="mb-2 flex items-center gap-1">
            <input
              type="text"
              class="flex-1 rounded border border-gray-200 px-2 py-1 text-xs"
              placeholder="Filter scope / msg / data…"
              value={debugQuery}
              onInput={(e) => setDebugQuery(e.currentTarget.value)}
            />
            <select
              class="rounded border border-gray-200 px-1 py-1 text-xs"
              value={debugLevel}
              onChange={(e) => setDebugLevel(e.currentTarget.value as 'all' | DebugLevel)}
            >
              <option value="all">all</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </select>
          </div>
          {debugEntries.length === 0 ? (
            <p class="text-xs text-gray-400">
              {debugLoading ? 'Loading…' : 'No debug entries yet — refresh after an action.'}
            </p>
          ) : (
            <>
              <p class="mb-1 text-[10px] text-gray-400">
                {filteredDebugEntries.length} / {debugEntries.length} entries
              </p>
              <ol class="max-h-64 space-y-0.5 overflow-y-auto rounded border border-gray-100 p-1 font-mono">
                {filteredDebugEntries.map((entry) => (
                  <li
                    key={`${entry.t}-${entry.scope}-${entry.msg}-${entry.run ?? ''}`}
                    class="border-b border-gray-50 py-0.5 last:border-0"
                  >
                    <div class="flex flex-wrap items-baseline gap-1">
                      <span class={`w-8 shrink-0 text-[9px] uppercase ${levelClass(entry.level)}`}>
                        {entry.level ?? 'info'}
                      </span>
                      <span class="text-[9px] text-gray-400">{formatDebugTime(entry.t)}</span>
                      <span class="rounded bg-gray-100 px-1 text-[9px] text-gray-600">
                        {entry.scope}
                      </span>
                      <span class="text-[11px] text-gray-800">{entry.msg}</span>
                      {entry.elapsedMs !== undefined && (
                        <span class="text-[9px] text-gray-400">{entry.elapsedMs}ms</span>
                      )}
                      {entry.run !== undefined && (
                        <span class="text-[9px] text-gray-400">·{entry.run}</span>
                      )}
                    </div>
                    {entry.data !== undefined && (
                      <pre class="mt-0.5 overflow-x-auto whitespace-pre-wrap break-all text-[9px] leading-tight text-gray-500">
                        {JSON.stringify(entry.data)}
                      </pre>
                    )}
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </details>
    </div>
  )
}
