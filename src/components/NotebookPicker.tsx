import type { NotebookMeta } from '../core/notebooks/model'
import type { QueueSummary } from '../core/queue/queue'

interface BackupResult {
  text: string
  isError: boolean
}

interface ExportVaultResult {
  text: string
  isError: boolean
}

interface NotebookPickerProps {
  hasAccounts: boolean
  notebooks: readonly NotebookMeta[]
  selectedNotebookId: string
  /** The selection is a remembered sticky route the user hasn't overridden — shows the "remembered" hint. */
  stickyPreselected: boolean
  hasSelectedTarget: boolean
  onSelectNotebook: (id: string) => void
  controlsDisabled: boolean
  refreshBusy: boolean
  onRefresh: () => void
  newNotebookTitle: string
  onNewNotebookTitleChange: (value: string) => void
  createBusy: boolean
  onCreate: () => void
  ingestBusy: boolean
  onIngest: () => void
  queueSummary: QueueSummary | undefined
  ingestError: string | undefined
  retryBusy: boolean
  onRetry: () => void
  backupBusy: boolean
  onBackup: () => void
  backupResult: BackupResult | undefined
  exportVaultBusy: boolean
  onExportVault: () => void
  exportVaultResult: ExportVaultResult | undefined
}

/** Pick (or create) a notebook target, send captured docs to it, and back them up to Drive or export them as an Obsidian vault. */
export function NotebookPicker({
  hasAccounts,
  notebooks,
  selectedNotebookId,
  stickyPreselected,
  hasSelectedTarget,
  onSelectNotebook,
  controlsDisabled,
  refreshBusy,
  onRefresh,
  newNotebookTitle,
  onNewNotebookTitleChange,
  createBusy,
  onCreate,
  ingestBusy,
  onIngest,
  queueSummary,
  ingestError,
  retryBusy,
  onRetry,
  backupBusy,
  onBackup,
  backupResult,
  exportVaultBusy,
  onExportVault,
  exportVaultResult,
}: NotebookPickerProps) {
  return (
    <>
      {hasAccounts && (
        <div class="mt-3 flex items-center gap-2">
          <select
            class="flex-1 rounded border border-gray-200 px-2 py-1 text-sm"
            value={selectedNotebookId}
            disabled={controlsDisabled}
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
            disabled={controlsDisabled || refreshBusy}
            onClick={onRefresh}
          >
            {refreshBusy ? 'Loading…' : '↻'}
          </button>
        </div>
      )}
      {hasAccounts && stickyPreselected && (
        <p class="mt-1 text-xs text-gray-400">
          Remembered from last time — pick another to change it.
        </p>
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
            disabled={
              controlsDisabled || refreshBusy || createBusy || newNotebookTitle.trim() === ''
            }
            onClick={onCreate}
          >
            {createBusy ? 'Creating…' : 'Create'}
          </button>
        </div>
      )}
      <button
        type="button"
        class="mt-2 w-full rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50"
        disabled={controlsDisabled || ingestBusy || !hasSelectedTarget}
        onClick={onIngest}
      >
        {ingestBusy ? 'Sending…' : 'Send to NotebookLM'}
      </button>
      {(queueSummary !== undefined || ingestError !== undefined) && (
        <div
          class={`mt-1 text-xs ${ingestError !== undefined || (queueSummary?.failed ?? 0) > 0 || (queueSummary?.blocked ?? 0) > 0 ? 'text-red-600' : 'text-gray-500'}`}
        >
          {queueSummary !== undefined && (
            <p>
              {queueSummary.queued} queued; continues in background
              {queueSummary.failed > 0 && ` · ${queueSummary.failed} failed`}
              {queueSummary.uncertain > 0 && ` · ${queueSummary.uncertain} need review`}
              {queueSummary.blocked > 0 && ` · ${queueSummary.blocked} need a new target`}
            </p>
          )}
          {(ingestError ?? queueSummary?.error) !== undefined && (
            <p>{ingestError ?? queueSummary?.error}</p>
          )}
          {(queueSummary?.retryJobIds.length ?? 0) > 0 && (
            <button
              type="button"
              class="mt-1 rounded border border-gray-300 px-2 py-1 text-gray-700 disabled:opacity-50"
              disabled={retryBusy}
              onClick={onRetry}
            >
              {queueSummary?.uncertain !== 0 ? 'Retry anyway' : 'Retry failed'}
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
      <button
        type="button"
        class="mt-2 w-full rounded border border-gray-300 px-3 py-2 text-gray-700 disabled:opacity-50"
        disabled={exportVaultBusy}
        onClick={onExportVault}
      >
        {exportVaultBusy ? 'Exporting…' : 'Export vault (.md tree)'}
      </button>
      {exportVaultResult && (
        <p class={`mt-1 text-xs ${exportVaultResult.isError ? 'text-red-600' : 'text-gray-500'}`}>
          {exportVaultResult.text}
        </p>
      )}
    </>
  )
}
