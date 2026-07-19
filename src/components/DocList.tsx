import type { NotebookMeta } from '../core/messaging'
import type { SourceDoc } from '../core/model/types'
import { canWatchSource } from '../core/watch/eligibility'
import type { WatchView } from '../core/watch/watch'

interface DocListProps {
  docs: SourceDoc[]
  watches: WatchView[]
  notebooks: NotebookMeta[]
  selectedNotebookId: string
  switchingAccount: boolean
  watchBusy: boolean
  unwatchBusy: boolean
  watchError: string | undefined
  onWatch: (docId: string) => void
  onUnwatch: (watchId: string) => void
}

export function DocList({
  docs,
  watches,
  notebooks,
  selectedNotebookId,
  switchingAccount,
  watchBusy,
  unwatchBusy,
  watchError,
  onWatch,
  onUnwatch,
}: DocListProps) {
  return (
    <>
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
                    disabled={unwatchBusy}
                    onClick={() => onUnwatch(watch.id)}
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
                    disabled={watchBusy || switchingAccount}
                    onClick={() => onWatch(doc.id)}
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
    </>
  )
}
