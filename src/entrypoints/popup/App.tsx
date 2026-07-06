import { useEffect, useState } from 'preact/hooks'
import type { SourceDoc } from '../../core/model/types'
import { sendMessage } from '../../core/messaging'
import { DEFAULT_SETTINGS, type PorterSettings } from '../../core/settings'

/**
 * Popup: detect what the active tab offers, one-click capture, then a
 * queue of captured docs with export / ingest actions.
 *
 * TODO(codegen): full UI per docs/superpowers/specs design §Popup.
 */
export function App() {
  const [docs, setDocs] = useState<SourceDoc[]>([])
  const [capturable, setCapturable] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [settings, setSettings] = useState<PorterSettings>(DEFAULT_SETTINGS)
  const [accountsBusy, setAccountsBusy] = useState(false)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupResult, setBackupResult] = useState<{ text: string; isError: boolean } | undefined>()
  const [notebooks, setNotebooks] = useState<{ id: string; title: string }[]>([])
  const [notebooksBusy, setNotebooksBusy] = useState(false)
  const [notebooksError, setNotebooksError] = useState<string | undefined>()
  const [selectedNotebookId, setSelectedNotebookId] = useState('')
  const [ingestBusy, setIngestBusy] = useState(false)
  const [ingestResult, setIngestResult] = useState<{ text: string; isError: boolean } | undefined>()

  useEffect(() => {
    void refresh()
    // Mount-only refresh — refresh is a plain function redefined each render,
    // not a reactive dependency; including it would re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function refresh() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
    if (tab?.url) {
      const res = await sendMessage({ type: 'porter/detect', url: tab.url })
      if (res.ok) setCapturable(res.capturable)
    }
    const listed = await sendMessage({ type: 'porter/list-docs' })
    if (listed.ok && listed.docs) setDocs(listed.docs)
    const settingsRes = await sendMessage({ type: 'porter/get-settings' })
    if (settingsRes.ok && settingsRes.settings) {
      setSettings(settingsRes.settings)
      if (settingsRes.settings.accounts.length > 0) void loadNotebooks()
    }
  }

  async function loadNotebooks() {
    setNotebooksBusy(true)
    setNotebooksError(undefined)
    try {
      const res = await sendMessage({ type: 'porter/list-notebooks' })
      if (!res.ok) {
        setNotebooksError(res.error)
        return
      }
      const list = res.notebooks ?? []
      setNotebooks(list)
      if (selectedNotebookId === '' && list.length > 0 && list[0]) {
        setSelectedNotebookId(list[0].id)
      }
    } finally {
      setNotebooksBusy(false)
    }
  }

  async function ingest() {
    if (selectedNotebookId === '') return
    setIngestBusy(true)
    setIngestResult(undefined)
    try {
      const res = await sendMessage({
        type: 'porter/ingest',
        docIds: docs.map((doc) => doc.id),
        notebookId: selectedNotebookId,
      })
      if (!res.ok) {
        setIngestResult({ text: res.error, isError: true })
        return
      }
      const outcomes = res.ingest ?? []
      const failed = outcomes.find((o) => !o.ok)
      const okCount = outcomes.filter((o) => o.ok).length
      setIngestResult(
        failed
          ? { text: failed.error ?? 'Send to NotebookLM failed', isError: true }
          : { text: `${okCount} of ${outcomes.length} docs sent`, isError: false },
      )
    } finally {
      setIngestBusy(false)
    }
  }

  async function capture() {
    setBusy(true)
    setError(undefined)
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id || !tab.url) return
      const res = await sendMessage({ type: 'porter/capture-url', url: tab.url, tabId: tab.id })
      if (!res.ok) setError(res.error)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function refreshAccounts() {
    setAccountsBusy(true)
    try {
      const res = await sendMessage({ type: 'porter/accounts-refresh' })
      if (res.ok) {
        const settingsRes = await sendMessage({ type: 'porter/get-settings' })
        if (settingsRes.ok && settingsRes.settings) setSettings(settingsRes.settings)
      }
    } finally {
      setAccountsBusy(false)
    }
  }

  async function selectAccount(authuser: number) {
    const res = await sendMessage({
      type: 'porter/update-settings',
      patch: { nblmAuthuser: authuser },
    })
    if (res.ok && res.settings) setSettings(res.settings)
  }

  async function updateDriveClientId(driveClientId: string) {
    const res = await sendMessage({ type: 'porter/update-settings', patch: { driveClientId } })
    if (res.ok && res.settings) setSettings(res.settings)
  }

  async function backupToDrive() {
    setBackupBusy(true)
    setBackupResult(undefined)
    try {
      const res = await sendMessage({
        type: 'porter/backup-drive',
        docIds: docs.map((doc) => doc.id),
      })
      if (!res.ok) {
        setBackupResult({ text: res.error, isError: true })
        return
      }
      const outcomes = res.backup ?? []
      const failed = outcomes.find((o) => !o.ok)
      const okCount = outcomes.filter((o) => o.ok).length
      setBackupResult(
        failed
          ? { text: failed.error ?? 'Backup failed', isError: true }
          : { text: `${okCount} backed up to Drive`, isError: false },
      )
    } finally {
      setBackupBusy(false)
    }
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
          disabled={accountsBusy}
          onClick={() => void refreshAccounts()}
        >
          {accountsBusy
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
          disabled={busy}
          onClick={() => void capture()}
        >
          {busy ? 'Capturing…' : capturable}
        </button>
      ) : (
        <p class="mb-3 text-gray-500">Nothing capturable on this page.</p>
      )}
      {error && <p class="mb-3 text-red-600">{error}</p>}
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
                disabled={notebooksBusy}
                onClick={() => void loadNotebooks()}
              >
                {notebooksBusy ? 'Loading…' : '↻'}
              </button>
            </div>
          )}
          {notebooksError && <p class="mt-1 text-xs text-red-600">{notebooksError}</p>}
          <button
            type="button"
            class="mt-2 w-full rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50"
            disabled={ingestBusy || selectedNotebookId === ''}
            onClick={() => void ingest()}
          >
            {ingestBusy ? 'Sending…' : 'Send to NotebookLM'}
          </button>
          {ingestResult && (
            <p class={`mt-1 text-xs ${ingestResult.isError ? 'text-red-600' : 'text-gray-500'}`}>
              {ingestResult.text}
            </p>
          )}
          <button
            type="button"
            class="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-gray-700 disabled:opacity-50"
            disabled={backupBusy}
            onClick={() => void backupToDrive()}
          >
            {backupBusy ? 'Backing up…' : 'Back up to Drive'}
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
        </div>
      </details>
    </div>
  )
}
