import { useEffect, useState } from 'preact/hooks'
import {
  makePopupRefreshCoordinator,
  type PopupRefreshCoordinator,
  type PopupRefreshSnapshot,
} from '../../core/popup/refresh'
import type { NotebookWorkspace } from '../../core/notebooks/workspace'

/** Thin Preact adapter. Refresh ordering stays in the Preact-free core. */
export function usePopupRefresh(workspace: NotebookWorkspace): {
  coordinator: PopupRefreshCoordinator
  snapshot: PopupRefreshSnapshot
} {
  const [coordinator] = useState(() => makePopupRefreshCoordinator(workspace))
  const [snapshot, setSnapshot] = useState(coordinator.snapshot)

  useEffect(() => coordinator.subscribe(setSnapshot), [coordinator])

  return { coordinator, snapshot }
}
