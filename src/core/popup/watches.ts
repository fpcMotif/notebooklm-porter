import {
  sameAccountBinding,
  sameNotebookTarget,
  type NotebookLmAccountBinding,
  type NotebookTarget,
} from '../accounts/ownership'
import type { NotebookMeta } from '../notebooks/model'
import type { WatchView } from '../watch/watch'

/** Finds a watch only when its immutable target matches the current target. */
export function watchForTarget(
  watches: readonly WatchView[],
  sourceDocId: string,
  target: NotebookTarget | undefined,
): WatchView | undefined {
  return target === undefined
    ? undefined
    : watches.find(
        (watch) => watch.sourceDocId === sourceDocId && sameNotebookTarget(watch.target, target),
      )
}

/** Current catalog titles are valid only for watches owned by the current account. */
export function watchTargetLabel(
  watch: WatchView,
  currentBinding: NotebookLmAccountBinding | undefined,
  notebooks: readonly NotebookMeta[],
): string {
  if (currentBinding === undefined || !sameAccountBinding(watch.target, currentBinding)) {
    return watch.target.notebookId
  }
  return (
    notebooks.find((notebook) => notebook.id === watch.target.notebookId)?.title ??
    watch.target.notebookId
  )
}
