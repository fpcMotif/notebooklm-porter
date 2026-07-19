import { useEffect, useState } from 'preact/hooks'
import {
  makeNotebookWorkspace,
  type NotebookWorkspace,
  type NotebookWorkspaceSnapshot,
} from '../../core/notebooks/workspace'

/** Thin Preact adapter. Workflow and request-order policy live in core. */
export function useNotebookWorkspace(): {
  controller: NotebookWorkspace
  snapshot: NotebookWorkspaceSnapshot
} {
  const [controller] = useState(makeNotebookWorkspace)
  const [snapshot, setSnapshot] = useState(controller.snapshot)

  useEffect(() => controller.subscribe(setSnapshot), [controller])

  return { controller, snapshot }
}
