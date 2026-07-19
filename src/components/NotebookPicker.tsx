import type { NotebookMeta } from '../core/messaging'

interface IngestResult {
  queued: number
  failed: number
  uncertain: number
  blocked: number
  error?: string
}

interface BackupResult {
  text: string
  isError: boolean
}

interface NotebookPickerProps {
  hasAccounts: boolean
  notebooks: NotebookMeta[]
  selectedNotebookId: string
  onSelectNotebook: (id: string) => void
  switchingAccount: boolean
  loadBusy: boolean
  onRefresh: () => void
  newNotebookTitle: string
  onNewNotebookTitleChange: (value: string) => void
  createBusy: boolean
  onCreate: () => void
  notebooksError: string | undefined
  ingestBusy: boolean
  onIngest: () => void
  ingestResult: IngestResult | undefined
  retryJobIds: string[]
  retryBusy: boolean
  onRetry: () => void
  backupBusy: boolean
  onBackup: () => void
  backupResult: BackupResult | undefined
}

/** Pick (or create) a notebook target, send captured docs to it, and back them up to Drive. */
export function NotebookPicker({
  hasAccounts,
  notebooks,
  selectedNotebookId,
  onSelectNotebook,
  switchingAccount,
  loadBusy,
  onRefresh,
  newNotebookTitle,
  onNewNotebookTitleChange,
  createBusy,
  onCreate,
  notebooksError,
  ingestBusy,
  onIngest,
  ingestResult,
  retryJobIds,
  retryBusy,
  onRetry,
  backupBusy,
  onBackup,
  backupResult,
}: NotebookPickerProps) {
  return (
    <>
      {hasAccounts && (
        <div class="mt-3 flex items-center gap-2">
          <select
            class="flex-1 rounded border border-gray-200 px-2 py-1 text-sm"
            value={selectedNotebookId}
            disabled={switchingAccount}
            onChange={(e) => onSelectNotebook(e.currentTarget.value)}
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
            disabled={switchingAccount || loadBusy}
            onClick={onRefresh}
          >
            {loadBusy ? 'Loading…' : '↻'}
          </button>
        </div>
      )}
      {hasAccounts && (
        <div class="mt-2 flex items-center gap-2">
          <input
            type="text"
            class="flex-1 rounded border border-gray-200 px-2 py-1 text-sm"
            placeholder="New notebook title…"
            value={newNotebookTitle}
            onChange={(e) => onNewNotebookTitleChange(e.currentTarget.value)}
          />
          <button
            type="button"
            class="rounded border border-gray-300 px-2 py-1 text-gray-700 disabled:opacity-50"
            disabled={switchingAccount || createBusy || newNotebookTitle.trim() === ''}
            onClick={onCreate}
          >
            {createBusy ? 'Creating…' : 'Create'}
          </button>
        </div>
      )}
      {notebooksError && <p class="mt-1 text-xs text-red-600">{notebooksError}</p>}
      <button
        type="button"
        class="mt-2 w-full rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50"
        disabled={switchingAccount || ingestBusy || selectedNotebookId === ''}
        onClick={onIngest}
      >
        {ingestBusy ? 'Sending…' : 'Send to NotebookLM'}
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
              disabled={retryBusy}
              onClick={onRetry}
            >
              {ingestResult.uncertain > 0 ? 'Retry anyway' : 'Retry failed'}
            </button>
          )}
        </div>
      )}
      <button
        type="button"
        class="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-gray-700 disabled:opacity-50"
        disabled={backupBusy}
        onClick={onBackup}
      >
        {backupBusy ? 'Backing up…' : 'Back up to Drive'}
      </button>
      {backupResult && (
        <p class={`mt-1 text-xs ${backupResult.isError ? 'text-red-600' : 'text-gray-500'}`}>
          {backupResult.text}
        </p>
      )}
    </>
  )
}
