import { Effect, Result } from 'effect'
import { useEffect, useState } from 'preact/hooks'
import { AccountPicker } from '../../components/AccountPicker'
import { CaptureButton } from '../../components/CaptureButton'
import { ConsolePanel } from '../../components/ConsolePanel'
import { DebugPanel } from '../../components/DebugPanel'
import { DocList } from '../../components/DocList'
import { NotebookPicker } from '../../components/NotebookPicker'
import { accountBindingFor, notebookTargetFor } from '../../core/accounts/ownership'
import { Tabs } from '../../core/fx/services'
import { popupRuntime } from '../../core/fx/runtime-popup'
import { PorterClient } from '../../core/messaging'
import { summarizeQueue } from '../../core/queue/queue'
import { useAction } from './useAction'
import { useNotebookWorkspace } from './useNotebookWorkspace'
import { usePopupRefresh } from './usePopupRefresh'

/**
 * Popup: detect what the active tab offers, one-click capture, then a
 * queue of captured docs with export / ingest actions.
 *
 * TODO(codegen): full UI per docs/superpowers/specs design §Popup.
 */

export function App() {
  const [enrichTranscripts, setEnrichTranscripts] = useState(false)
  const [backupResult, setBackupResult] = useState<{ text: string; isError: boolean } | undefined>()
  const [exportVaultResult, setExportVaultResult] = useState<
    { text: string; isError: boolean } | undefined
  >()
  const [ingestError, setIngestError] = useState<string | undefined>()
  const [watchError, setWatchError] = useState<string | undefined>()
  const { controller: notebookWorkspace, snapshot: workspaceState } = useNotebookWorkspace()
  const { coordinator: popupRefresh, snapshot: refreshState } = usePopupRefresh(notebookWorkspace)
  const { docs, capturable, canEnrichTranscripts, watches } = refreshState
  const {
    settings,
    notebooks,
    selectedNotebookId,
    newNotebookTitle,
    error: notebooksError,
    driveError,
    pending: notebookPending,
    sourceConsole,
    stickyPreselected,
    pendingAccountSwitch,
  } = workspaceState
  const accountBusy =
    notebookPending.bootstrap || notebookPending.discover || notebookPending.switchAccount
  const consoleBusy = sourceConsole.pending !== undefined
  const controlsDisabled = accountBusy || notebookPending.create || consoleBusy
  const selectedNotebookTarget = notebookTargetFor(settings, selectedNotebookId)
  const currentAccountBinding = accountBindingFor(settings)
  const queueSummary =
    refreshState.queue === undefined ? undefined : summarizeQueue(refreshState.queue)

  useEffect(() => {
    void popupRuntime.runPromise(popupRefresh.refresh())
  }, [popupRefresh])

  useEffect(() => {
    if (!canEnrichTranscripts) setEnrichTranscripts(false)
  }, [canEnrichTranscripts])

  // Sticky routing (§routing/sticky): when the staged docs' remembered target
  // lives on a different, still-known account, switch to it so its notebook can
  // be preselected. The controller only raises this while the user hasn't taken
  // manual control and no account operation is in flight, so it self-clears.
  useEffect(() => {
    if (pendingAccountSwitch === undefined) return
    void popupRuntime.runPromise(notebookWorkspace.switchAccount(pendingAccountSwitch))
  }, [pendingAccountSwitch, notebookWorkspace])

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
      yield* popupRefresh.refresh()
      if (Result.isFailure(result)) return yield* Effect.fail(result.failure)
    }),
  )

  const ingestAction = useAction<[string[]]>((docIds) =>
    Effect.gen(function* () {
      if (selectedNotebookTarget === undefined) return
      setIngestError(undefined)
      const client = yield* PorterClient
      const result = yield* Effect.result(
        client.request({
          type: 'porter/queue-enqueue',
          docIds,
          target: selectedNotebookTarget,
        }),
      )
      if (Result.isFailure(result)) {
        setIngestError(result.failure.reason)
        return
      }
      popupRefresh.acceptQueueSnapshot(result.success.queue)
    }),
  )

  const retryQueueAction = useAction<[string[]]>((jobIds) =>
    Effect.gen(function* () {
      const client = yield* PorterClient
      const result = yield* Effect.result(client.request({ type: 'porter/queue-retry', jobIds }))
      if (Result.isFailure(result)) {
        setIngestError(result.failure.reason)
        return
      }
      setIngestError(undefined)
      popupRefresh.acceptQueueSnapshot(result.success.queue)
    }),
  )

  const watchAction = useAction<[string]>((docId) =>
    Effect.gen(function* () {
      if (selectedNotebookTarget === undefined) return
      setWatchError(undefined)
      const client = yield* PorterClient
      const result = yield* Effect.result(
        client.request({ type: 'porter/watch-create', docId, target: selectedNotebookTarget }),
      )
      if (Result.isFailure(result)) {
        setWatchError(result.failure.reason)
        return
      }
      popupRefresh.acceptWatches(result.success.watches)
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
      popupRefresh.acceptWatches(result.success.watches)
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

  const exportVaultAction = useAction<[]>(() =>
    Effect.gen(function* () {
      setExportVaultResult(undefined)
      const client = yield* PorterClient
      const result = yield* Effect.result(
        client.request({ type: 'porter/export-vault', docIds: docs.map((doc) => doc.id) }),
      )
      if (Result.isFailure(result)) {
        setExportVaultResult({ text: result.failure.reason, isError: true })
        return
      }
      setExportVaultResult({
        text: `${docs.length} doc${docs.length === 1 ? '' : 's'} exported to Downloads/NotebookLM Porter`,
        isError: false,
      })
    }),
  )

  function selectAccount(authuser: number) {
    return popupRuntime.runPromise(notebookWorkspace.switchAccount(authuser))
  }

  function updateDriveClientId(driveClientId: string) {
    return popupRuntime.runPromise(notebookWorkspace.updateDriveClientId(driveClientId))
  }

  function updateAutoExportVault(autoExportVault: boolean) {
    return popupRuntime.runPromise(notebookWorkspace.updateAutoExportVault(autoExportVault))
  }

  return (
    <div class="p-4 font-sans text-sm">
      <h1 class="mb-1 text-base font-semibold">NotebookLM Porter</h1>
      <AccountPicker
        settings={settings}
        controlsDisabled={controlsDisabled}
        discoverBusy={notebookPending.discover}
        onSelectAccount={(authuser) => {
          notebookWorkspace.markManualTarget()
          void selectAccount(authuser)
        }}
        onFindAccounts={() => void popupRuntime.runPromise(notebookWorkspace.discoverAccounts())}
      />
      {notebooksError && <p class="mb-3 text-xs text-red-600">{notebooksError}</p>}
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
        selectedNotebookTarget={selectedNotebookTarget}
        currentAccountBinding={currentAccountBinding}
        accountBusy={accountBusy}
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
          stickyPreselected={stickyPreselected}
          hasSelectedTarget={selectedNotebookTarget !== undefined}
          onSelectNotebook={(id) => notebookWorkspace.selectNotebook(id)}
          controlsDisabled={controlsDisabled}
          refreshBusy={notebookPending.refresh}
          onRefresh={() => void popupRuntime.runPromise(notebookWorkspace.refreshNotebooks())}
          newNotebookTitle={newNotebookTitle}
          onNewNotebookTitleChange={(value) => notebookWorkspace.editNewNotebookTitle(value)}
          createBusy={notebookPending.create}
          onCreate={() => void popupRuntime.runPromise(notebookWorkspace.createNotebook())}
          ingestBusy={ingestAction.busy}
          onIngest={() => ingestAction.run(docs.map((doc) => doc.id))}
          queueSummary={queueSummary}
          ingestError={ingestError}
          retryBusy={retryQueueAction.busy}
          onRetry={() => retryQueueAction.run(queueSummary?.retryJobIds ?? [])}
          backupBusy={backupAction.busy}
          onBackup={() => backupAction.run()}
          backupResult={backupResult}
          exportVaultBusy={exportVaultAction.busy}
          onExportVault={() => exportVaultAction.run()}
          exportVaultResult={exportVaultResult}
        />
      )}
      <ConsolePanel
        hasAccounts={settings.accounts.length > 0}
        notebooks={notebooks}
        selectedNotebookId={selectedNotebookId}
        onSelectNotebook={(id) => notebookWorkspace.selectNotebook(id)}
        accountBusy={accountBusy}
        pending={notebookPending}
        sourceConsole={sourceConsole}
        onLoadNotebooks={() => void popupRuntime.runPromise(notebookWorkspace.refreshNotebooks())}
        onScan={() => void popupRuntime.runPromise(notebookWorkspace.scanSourceConsole())}
        onDedupe={() => void popupRuntime.runPromise(notebookWorkspace.removeSourceDuplicates())}
        onRetrySource={(sourceId) =>
          void popupRuntime.runPromise(notebookWorkspace.retrySource(sourceId))
        }
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
          {driveError && <p class="mt-1 text-xs text-red-600">{driveError}</p>}
          <p class="mt-1 text-xs text-gray-400">
            OAuth client (Chrome Extension type) from Google Cloud Console
          </p>
          <label class="mt-3 flex items-center gap-2 text-gray-700">
            <input
              type="checkbox"
              checked={settings.autoExportVault}
              onChange={(e) => void updateAutoExportVault(e.currentTarget.checked)}
            />
            Auto-export every capture to the Obsidian vault
          </label>
        </div>
      </details>
      <DebugPanel />
    </div>
  )
}
