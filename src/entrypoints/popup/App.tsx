import { useEffect, useState } from 'preact/hooks'
import type { SourceDoc } from '../../core/model/types'
import { sendMessage } from '../../core/messaging'

/**
 * Popup: detect what the active tab offers, one-click capture, then a
 * queue of captured docs with export / ingest actions.
 *
 * TODO(codegen): full UI per docs/superpowers/specs design §Popup.
 */
export function App() {
  const [docs, setDocs] = useState<SourceDoc[]>([])
  const [capturable, setCapturable] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    void refresh()
  }, [])

  async function refresh() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
    if (tab?.url) {
      const res = await sendMessage({ type: 'porter/detect', url: tab.url })
      if (res.ok) setCapturable(res.capturable)
    }
    const listed = await sendMessage({ type: 'porter/list-docs' })
    if (listed.ok && listed.docs) setDocs(listed.docs)
  }

  async function capture() {
    setBusy(true)
    setError(undefined)
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id || !tab.url) return
      const res = await sendMessage({ type: 'porter/capture-url', url: tab.url, tabId: tab.id })
      if (!res.ok) setError(res.error)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="p-4 font-sans text-sm">
      <h1 class="mb-3 text-base font-semibold">NotebookLM Porter</h1>
      {capturable ? (
        <button
          type="button"
          class="mb-3 w-full rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50"
          disabled={busy}
          onClick={() => void capture()}
        >
          {busy ? 'Capturing…' : capturable}
        </button>
      ) : (
        <p class="mb-3 text-gray-500">Nothing capturable on this page.</p>
      )}
      {error && <p class="mb-3 text-red-600">{error}</p>}
      <ul class="space-y-2">
        {docs.map((doc) => (
          <li key={doc.id} class="rounded border border-gray-200 p-2">
            <span class="font-medium">{doc.title}</span>
            <span class="ml-1 text-gray-400">({doc.wordCount.toLocaleString()} words)</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
