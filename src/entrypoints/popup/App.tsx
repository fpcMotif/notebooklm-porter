import { Effect, Result } from 'effect'
import { useEffect, useState } from 'preact/hooks'
import { Tabs } from '../../core/fx/services'
import { popupRuntime } from '../../core/fx/runtime-popup'
import type { SourceDoc } from '../../core/model/types'
import { PorterClient, type NotebookMeta } from '../../core/messaging'
import { DEFAULT_SETTINGS, type PorterSettings } from '../../core/settings'
import { useAction } from './useAction'

/**
 * Popup: detect what the active tab offers, one-click capture, then a
 * queue of captured docs with export / ingest actions.
 *
 * TODO(codegen): full UI per docs/superpowers/specs design §Popup.
 */

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
  const [settings, setSettings] = useState<PorterSettings>(DEFAULT_SETTINGS)
  const [backupResult, setBackupResult] = useState<{ text: string; isError: boolean } | undefined>()
  const [notebooks, setNotebooks] = useState<NotebookMeta[]>([])
  const [notebooksError, setNotebooksError] = useState<string | undefined>()
  const [selectedNotebookId, setSelectedNotebookId] = useState('')
  const [newNotebookTitle, setNewNotebookTitle] = useState('')
  const [ingestResult, setIngestResult] = useState<{ text: string; isError: boolean } | undefined>()
  const [debugCopyStatus, setDebugCopyStatus] = useState<string | undefined>()

  // Shared with accountsAction (FIX 3) so discovering accounts for the first
  // time also populates the notebook list, instead of composing via a faked
  // click on loadNotebooksAction.
  const loadNotebooksEffect = Effect.gen(function* () {
    setNotebooksError(undefined)
    const client = yield* PorterClient
    const result = yield* Effect.result(client.request({ type: 'porter/list-notebooks' }))
    if (Result.isFailure(result)) {
      setNotebooksError(result.failure.reason)
      return
    }
    const list = result.success.notebooks
    setNotebooks(list)
    if (selectedNotebookId === '' && list.length > 0 && list[0]) {
      setSelectedNotebookId(list[0].id)
    }
  })

  const loadNotebooksAction = useAction<[]>(() => loadNotebooksEffect)

  const createNotebookAction = useAction<[]>(() =>
    Effect.gen(function* () {
      const title = newNotebookTitle.trim()
      if (title === '') return
      setNotebooksError(undefined)
      const client = yield* PorterClient
      const result = yield* Effect.result(client.request({ type: 'porter/create-notebook', title }))
      if (Result.isFailure(result)) {
        setNotebooksError(result.failure.reason)
        return
      }
      setNotebooks(result.success.notebooks)
      setSelectedNotebookId(result.success.created.id)
      setNewNotebookTitle('')
    }),
  )

  const refreshEffect = Effect.gen(function* () {
    const client = yield* PorterClient
    const tabs = yield* Tabs
    const tab = yield* tabs.activeTab()
    if (tab.url) {
      const detected = yield* Effect.result(client.request({ type: 'porter/detect', url: tab.url }))
      if (Result.isSuccess(detected)) setCapturable(detected.success.capturable)
    }
    const listed = yield* Effect.result(client.request({ type: 'porter/list-docs' }))
    if (Result.isSuccess(listed)) setDocs(listed.success.docs)
    const settingsResult = yield* Effect.result(client.request({ type: 'porter/get-settings' }))
    if (Result.isSuccess(settingsResult)) {
      setSettings(settingsResult.success.settings)
      if (settingsResult.success.settings.accounts.length > 0) loadNotebooksAction.run()
    }
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
        client.request({ type: 'porter/capture-url', url: tab.url, tabId: tab.id }),
      )
      yield* refreshEffect
      if (Result.isFailure(result)) return yield* Effect.fail(result.failure)
    }),
  )

  const ingestAction = useAction<[]>(() =>
    Effect.gen(function* () {
      if (selectedNotebookId === '') return
      setIngestResult(undefined)
      const client = yield* PorterClient
      const result = yield* Effect.result(
        client.request({
          type: 'porter/ingest',
          docIds: docs.map((doc) => doc.id),
          notebookId: selectedNotebookId,
        }),
      )
      if (Result.isFailure(result)) {
        setIngestResult({ text: result.failure.reason, isError: true })
        return
      }
      const outcomes = result.success.ingest
      const failed = outcomes.find((o) => !o.ok)
      const okCount = outcomes.filter((o) => o.ok).length
      setIngestResult(
        failed
          ? { text: failed.error ?? 'Send to NotebookLM failed', isError: true }
          : { text: `${okCount} of ${outcomes.length} docs sent`, isError: false },
      )
    }),
  )

  const accountsAction = useAction<[]>(() =>
    Effect.gen(function* () {
      const client = yield* PorterClient
      const result = yield* Effect.result(client.request({ type: 'porter/accounts-refresh' }))
      if (Result.isFailure(result)) return
      const settingsResult = yield* Effect.result(client.request({ type: 'porter/get-settings' }))
      if (Result.isFailure(settingsResult)) return
      setSettings(settingsResult.success.settings)
      if (settingsResult.success.settings.accounts.length > 0) yield* loadNotebooksEffect
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
    return popupRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* PorterClient
        const result = yield* Effect.result(
          client.request({ type: 'porter/update-settings', patch: { nblmAuthuser: authuser } }),
        )
        if (Result.isSuccess(result)) setSettings(result.success.settings)
      }),
    )
  }

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

  async function copyDebugLog() {
    const result = await popupRuntime.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const client = yield* PorterClient
          const { debugLog } = yield* client.request({ type: 'porter/debug-log' })
          return debugLog
        }),
      ),
    )
    if (Result.isFailure(result)) {
      setDebugCopyStatus(result.failure.reason)
    } else {
      const entries = result.success
      await navigator.clipboard.writeText(JSON.stringify(entries, null, 2))
      setDebugCopyStatus(`copied (${entries.length} entries)`)
    }
    setTimeout(() => setDebugCopyStatus(undefined), 2000)
  }

  return (
    <div class="p-4 font-sans text-sm">
      <h1 class="mb-1 text-base font-semibold">NotebookLM Porter</h1>
      <div class="mb-3 flex items-center gap-2">
        {settings.accounts.length > 0 && (
          <select
            class="flex-1 rounded border border-gray-200 px-2 py-1 text-sm"
            value={settings.nblmAuthuser}
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
          disabled={accountsAction.busy}
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
        <button
          type="button"
          class="mb-3 w-full rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50"
          disabled={captureAction.busy}
          onClick={() => captureAction.run()}
        >
          {captureAction.busy ? 'Capturing…' : capturable}
        </button>
      ) : (
        <p class="mb-3 text-gray-500">Nothing capturable on this page.</p>
      )}
      {captureAction.error && <p class="mb-3 text-red-600">{captureAction.error}</p>}
      <ul class="space-y-2">
        {docs.map((doc) => (
          <li key={doc.id} class="rounded border border-gray-200 p-2">
            <span class="font-medium">{doc.title}</span>
            <span class="ml-1 text-gray-400">({doc.wordCount.toLocaleString()} words)</span>
          </li>
        ))}
      </ul>
      {docs.length > 0 && (
        <>
          {settings.accounts.length > 0 && (
            <div class="mt-3 flex items-center gap-2">
              <select
                class="flex-1 rounded border border-gray-200 px-2 py-1 text-sm"
                value={selectedNotebookId}
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
                disabled={loadNotebooksAction.busy}
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
                disabled={createNotebookAction.busy || newNotebookTitle.trim() === ''}
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
            disabled={ingestAction.busy || selectedNotebookId === ''}
            onClick={() => ingestAction.run()}
          >
            {ingestAction.busy ? 'Sending…' : 'Send to NotebookLM'}
          </button>
          {ingestResult && (
            <p class={`mt-1 text-xs ${ingestResult.isError ? 'text-red-600' : 'text-gray-500'}`}>
              {ingestResult.text}
            </p>
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
          <div class="mt-3 flex items-center gap-2">
            <button
              type="button"
              class="rounded border border-gray-300 px-2 py-1 text-gray-700"
              onClick={() => void copyDebugLog()}
            >
              Copy debug log
            </button>
            <button type="button" class="text-gray-500" onClick={() => void clearDebugLog()}>
              Clear
            </button>
            {debugCopyStatus && <span class="text-xs text-gray-400">{debugCopyStatus}</span>}
          </div>
        </div>
      </details>
    </div>
  )
}
