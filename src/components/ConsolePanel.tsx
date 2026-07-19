import type { ConsoleScan } from '../core/ingest/sources/console'
import type { NotebookMeta } from '../core/messaging'

interface ConsolePanelProps {
  hasAccounts: boolean
  notebooks: NotebookMeta[]
  selectedNotebookId: string
  onSelectNotebook: (id: string) => void
  switchingAccount: boolean
  onLoadNotebooks: () => void
  scanBusy: boolean
  onScan: () => void
  consoleStatus: string | undefined
  consoleScan: ConsoleScan | undefined
  dedupeBusy: boolean
  onDedupe: () => void
  retrySourceBusy: boolean
  onRetrySource: (sourceId: string) => void
}

/** Scan a notebook for duplicate/failed sources and let the user clean them up. */
export function ConsolePanel({
  hasAccounts,
  notebooks,
  selectedNotebookId,
  onSelectNotebook,
  switchingAccount,
  onLoadNotebooks,
  scanBusy,
  onScan,
  consoleStatus,
  consoleScan,
  dedupeBusy,
  onDedupe,
  retrySourceBusy,
  onRetrySource,
}: ConsolePanelProps) {
  return (
    <details
      class="mt-3"
      onToggle={(e) => {
        if (e.currentTarget.open && notebooks.length === 0 && hasAccounts) onLoadNotebooks()
      }}
    >
      <summary class="cursor-pointer text-gray-500">Manage notebook sources</summary>
      <div class="mt-2">
        <p class="mb-2 text-xs text-gray-400">
          Scan a NotebookLM notebook for duplicate sources and failed loads, then remove or retry
          them.
        </p>
        {!hasAccounts ? (
          <p class="text-xs text-gray-400">Find your NotebookLM accounts first (↻ above).</p>
        ) : (
          <>
            <div class="flex items-center gap-2">
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
                class="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
                disabled={scanBusy || switchingAccount || selectedNotebookId === ''}
                onClick={onScan}
              >
                {scanBusy ? 'Scanning…' : 'Scan'}
              </button>
            </div>
            {consoleStatus && <p class="mt-1 text-xs text-gray-500">{consoleStatus}</p>}
            {consoleScan && (
              <div class="mt-2 space-y-2">
                <p class="text-xs text-gray-500">
                  {consoleScan.sources.length} sources · {consoleScan.duplicateCount} duplicate
                  {consoleScan.duplicateCount === 1 ? '' : 's'} · {consoleScan.failed.length} failed
                </p>
                {consoleScan.duplicateCount > 0 && (
                  <button
                    type="button"
                    class="w-full rounded bg-red-600 px-3 py-2 text-white disabled:opacity-50"
                    disabled={dedupeBusy || switchingAccount}
                    onClick={onDedupe}
                  >
                    {dedupeBusy
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
                  <div key={diagnosis.source.id} class="rounded border border-red-200 p-2 text-xs">
                    <div class="font-medium text-red-700">{diagnosis.source.title}</div>
                    <div class="text-gray-500">{diagnosis.reason}</div>
                    {diagnosis.retry === 'refresh' && (
                      <button
                        type="button"
                        class="mt-1 text-blue-600 disabled:opacity-50"
                        disabled={retrySourceBusy || switchingAccount}
                        onClick={() => onRetrySource(diagnosis.source.id)}
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
  )
}
