import { Effect } from 'effect'
import { useState } from 'preact/hooks'
import type { IpcError } from '../../core/fx/errors'
import type { PopupServices } from '../../core/fx/layers'
import { popupRuntime } from '../../core/fx/runtime-popup'

/**
 * Runs a popup Effect with uniform busy/error bookkeeping. IpcError (the only
 * typed failure PopupServices produce) is flattened to its reason string;
 * defects surface as String(err).
 */
export function useAction<Args extends unknown[]>(
  body: (...args: Args) => Effect.Effect<void, IpcError, PopupServices>,
): { run: (...args: Args) => void; busy: boolean; error: string | undefined } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const run = (...args: Args) => {
    setBusy(true)
    setError(undefined)
    void popupRuntime
      .runPromise(
        Effect.catchTag(body(...args), 'IpcError', (e) => Effect.sync(() => setError(e.reason))),
      )
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }
  return { run, busy, error }
}
