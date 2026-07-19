import type { NotebookMeta } from '../core/notebooks/model'
import type { NotebookWorkspacePending, SourceConsoleSnapshot } from '../core/notebooks/workspace'

interface ConsolePanelProps {
  hasAccounts: boolean
  notebooks: readonly NotebookMeta[]
  selectedNotebookId: string
  onSelectNotebook: (id: string) => void
  accountBusy: boolean
  pending: NotebookWorkspacePending
  sourceConsole: SourceConsoleSnapshot
  onLoadNotebooks: () => void
  onScan: () => void
  onDedupe: () => void
  onRetrySource: (sourceId: string) => void
}

/** Scan a notebook for duplicate/failed sources and let the user clean them up. */
export function ConsolePanel({
  hasAccounts,
  notebooks,
  selectedNotebookId,
  onSelectNotebook,
  accountBusy,
  pending,
  sourceConsole,
  onLoadNotebooks,
  onScan,
  onDedupe,
  onRetrySource,
}: ConsolePanelProps) {
  const consoleBusy = sourceConsole.pending !== undefined
  const controlsDisabled = accountBusy || pending.create || consoleBusy

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
                class="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
                disabled={
                  consoleBusy ||
                  accountBusy ||
                  pending.refresh ||
                  pending.create ||
                  selectedNotebookId === ''
                }
                onClick={onScan}
              >
                {sourceConsole.pending === 'scan' ? 'Scanning…' : 'Scan'}
              </button>
            </div>
            {sourceConsole.status && (
              <p class="mt-1 text-xs text-gray-500">{sourceConsole.status}</p>
            )}
            {sourceConsole.scan && (
              <div class="mt-2 space-y-2">
                <p class="text-xs text-gray-500">
                  {sourceConsole.scan.sources.length} sources · {sourceConsole.scan.duplicateCount}{' '}
                  duplicate
                  {sourceConsole.scan.duplicateCount === 1 ? '' : 's'} ·{' '}
                  {sourceConsole.scan.failed.length} failed
                </p>
                {sourceConsole.scan.duplicateCount > 0 && (
                  <button
                    type="button"
                    class="w-full rounded bg-red-600 px-3 py-2 text-white disabled:opacity-50"
                    disabled={consoleBusy || accountBusy}
                    onClick={onDedupe}
                  >
                    {sourceConsole.pending === 'dedupe'
                      ? 'Removing…'
                      : `Remove ${sourceConsole.scan.duplicateCount} duplicate${sourceConsole.scan.duplicateCount === 1 ? '' : 's'}`}
                  </button>
                )}
                {sourceConsole.scan.duplicateGroups.map((group) => (
                  <div key={group.key} class="rounded border border-gray-200 p-2 text-xs">
                    <div class="font-medium">Keep: {group.keep.title}</div>
                    <div class="text-gray-500">
                      Remove {group.remove.length}: {group.remove.map((s) => s.title).join(', ')}
                    </div>
                  </div>
                ))}
                {sourceConsole.scan.failed.map((diagnosis) => (
                  <div key={diagnosis.source.id} class="rounded border border-red-200 p-2 text-xs">
                    <div class="font-medium text-red-700">{diagnosis.source.title}</div>
                    <div class="text-gray-500">{diagnosis.reason}</div>
                    {diagnosis.retry === 'refresh' && (
                      <button
                        type="button"
                        class="mt-1 text-blue-600 disabled:opacity-50"
                        disabled={consoleBusy || accountBusy}
                        onClick={() => onRetrySource(diagnosis.source.id)}
                      >
                        {sourceConsole.pending === 'retry' ? 'Retrying…' : 'Retry load'}
                      </button>
                    )}
                  </div>
                ))}
                {sourceConsole.scan.duplicateCount === 0 &&
                  sourceConsole.scan.failed.length === 0 && (
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
