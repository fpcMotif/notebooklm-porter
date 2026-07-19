import { Effect, Result } from 'effect'
import { useEffect, useRef, useState } from 'preact/hooks'
import { AccountPicker } from '../../components/AccountPicker'
import { CaptureButton } from '../../components/CaptureButton'
import { ConsolePanel } from '../../components/ConsolePanel'
import { DebugPanel } from '../../components/DebugPanel'
import { DocList } from '../../components/DocList'
import { NotebookPicker } from '../../components/NotebookPicker'
import { Tabs } from '../../core/fx/services'
import { popupRuntime } from '../../core/fx/runtime-popup'
import type { ConsoleScan } from '../../core/ingest/sources/console'
import type { SourceDoc } from '../../core/model/types'
import { PorterClient, type NotebookMeta } from '../../core/messaging'
import { summarizeQueue, type QueueSnapshot } from '../../core/queue/queue'
import { DEFAULT_SETTINGS, resolveNotebookTarget, type PorterSettings } from '../../core/settings'
import type { WatchView } from '../../core/watch/watch'
import { useAction } from './useAction'
import { useGenerationGuard } from './useGenerationGuard'

/**
 * Popup: detect what the active tab offers, one-click capture, then a
 * queue of captured docs with export / ingest actions.
 *
 * TODO(codegen): full UI per docs/superpowers/specs design §Popup.
 */

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

  return (
    <div class="p-4 font-sans text-sm">
      <h1 class="mb-1 text-base font-semibold">NotebookLM Porter</h1>
      <AccountPicker
        settings={settings}
        switchingAccount={switchingAccount}
        busy={accountsAction.busy}
        onSelectAccount={selectAccount}
        onFindAccounts={() => accountsAction.run()}
      />
      <CaptureButton
        capturable={capturable}
        canEnrichTranscripts={canEnrichTranscripts}
        enrichTranscripts={enrichTranscripts}
        onEnrichChange={setEnrichTranscripts}
        busy={captureAction.busy}
        error={captureAction.error}
        onCapture={() => captureAction.run()}
      />
      <DocList
        docs={docs}
        watches={watches}
        notebooks={notebooks}
        selectedNotebookId={selectedNotebookId}
        switchingAccount={switchingAccount}
        watchBusy={watchAction.busy}
        unwatchBusy={unwatchAction.busy}
        watchError={watchError}
        onWatch={(docId) => watchAction.run(docId)}
        onUnwatch={(watchId) => unwatchAction.run(watchId)}
      />
      {docs.length > 0 && (
        <NotebookPicker
          hasAccounts={settings.accounts.length > 0}
          notebooks={notebooks}
          selectedNotebookId={selectedNotebookId}
          onSelectNotebook={setSelectedNotebookId}
          switchingAccount={switchingAccount}
          loadBusy={loadNotebooksAction.busy}
          onRefresh={() => loadNotebooksAction.run()}
          newNotebookTitle={newNotebookTitle}
          onNewNotebookTitleChange={setNewNotebookTitle}
          createBusy={createNotebookAction.busy}
          onCreate={() => createNotebookAction.run()}
          notebooksError={notebooksError}
          ingestBusy={ingestAction.busy}
          onIngest={() => ingestAction.run(docs.map((doc) => doc.id))}
          ingestResult={ingestResult}
          retryJobIds={retryJobIds}
          retryBusy={retryQueueAction.busy}
          onRetry={() => retryQueueAction.run(retryJobIds)}
          backupBusy={backupAction.busy}
          onBackup={() => backupAction.run()}
          backupResult={backupResult}
        />
      )}
      <ConsolePanel
        hasAccounts={settings.accounts.length > 0}
        notebooks={notebooks}
        selectedNotebookId={selectedNotebookId}
        onSelectNotebook={setSelectedNotebookId}
        switchingAccount={switchingAccount}
        onLoadNotebooks={() => loadNotebooksAction.run()}
        scanBusy={scanConsoleAction.busy}
        onScan={() => scanConsoleAction.run()}
        consoleStatus={consoleStatus}
        consoleScan={consoleScan}
        dedupeBusy={dedupeAction.busy}
        onDedupe={() => dedupeAction.run()}
        retrySourceBusy={retrySourceAction.busy}
        onRetrySource={(sourceId) => retrySourceAction.run(sourceId)}
      />
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
      <DebugPanel />
    </div>
  )
}
