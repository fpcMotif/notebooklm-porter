interface CaptureButtonProps {
  capturable: string | undefined
  canEnrichTranscripts: boolean
  enrichTranscripts: boolean
  onEnrichChange: (value: boolean) => void
  busy: boolean
  error: string | undefined
  onCapture: () => void
}

export function CaptureButton({
  capturable,
  canEnrichTranscripts,
  enrichTranscripts,
  onEnrichChange,
  busy,
  error,
  onCapture,
}: CaptureButtonProps) {
  return (
    <>
      {capturable ? (
        <div class="mb-3">
          {canEnrichTranscripts && (
            <label class="mb-2 flex cursor-pointer items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={enrichTranscripts}
                disabled={busy}
                onChange={(event) => onEnrichChange(event.currentTarget.checked)}
              />
              <span>
                Capture available transcripts (up to 200 videos). Videos without a transcript use
                YouTube import.
              </span>
            </label>
          )}
          <button
            type="button"
            class="w-full rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50"
            disabled={busy}
            onClick={onCapture}
          >
            {busy ? 'Capturing…' : capturable}
          </button>
        </div>
      ) : (
        <p class="mb-3 text-gray-500">Nothing capturable on this page.</p>
      )}
      {error && <p class="mb-3 text-red-600">{error}</p>}
    </>
  )
}
