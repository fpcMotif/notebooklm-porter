import { Effect, Result } from 'effect'
import { useState } from 'preact/hooks'
import { filterDebugEntries, type DebugEntry, type DebugLevel } from '../core/debug'
import { popupRuntime } from '../core/fx/runtime-popup'
import { PorterClient } from '../core/messaging'

function levelClass(level: DebugLevel | undefined): string {
  if (level === 'error') return 'text-red-600'
  if (level === 'warn') return 'text-amber-600'
  return 'text-gray-400'
}

function formatDebugTime(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleTimeString()
}

async function clearDebugLog() {
  await popupRuntime.runPromise(
    Effect.catchTag(
      Effect.gen(function* () {
        const client = yield* PorterClient
        yield* client.request({ type: 'porter/debug-clear' })
      }),
      'IpcError',
      () => Effect.succeed(undefined),
    ),
  )
}

/** Self-contained: owns its own fetch/filter/copy state, no data from a parent. */
export function DebugPanel() {
  const [debugCopyStatus, setDebugCopyStatus] = useState<string | undefined>()
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([])
  const [debugQuery, setDebugQuery] = useState('')
  const [debugLevel, setDebugLevel] = useState<'all' | DebugLevel>('all')
  const [debugLoading, setDebugLoading] = useState(false)

  function flashDebugStatus(text: string) {
    setDebugCopyStatus(text)
    setTimeout(() => setDebugCopyStatus(undefined), 2000)
  }

  async function fetchDebugEntries(): Promise<DebugEntry[] | undefined> {
    setDebugLoading(true)
    const result = await popupRuntime.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const client = yield* PorterClient
          const { debugLog } = yield* client.request({ type: 'porter/debug-log' })
          return debugLog
        }),
      ),
    )
    setDebugLoading(false)
    if (Result.isFailure(result)) {
      flashDebugStatus(result.failure.reason)
      return undefined
    }
    setDebugEntries(result.success)
    return result.success
  }

  async function copyDebugLog() {
    const entries = await fetchDebugEntries()
    if (entries === undefined) return
    await navigator.clipboard.writeText(JSON.stringify(entries, null, 2))
    flashDebugStatus(`copied (${entries.length} entries)`)
  }

  async function downloadDebugLog() {
    const entries = await fetchDebugEntries()
    if (entries === undefined) return
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `porter-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    flashDebugStatus(`downloaded (${entries.length})`)
  }

  async function resetDebugLog() {
    await clearDebugLog()
    setDebugEntries([])
    flashDebugStatus('cleared')
  }

  const filteredDebugEntries = filterDebugEntries(debugEntries, debugQuery, debugLevel)

  return (
    <details
      class="mt-3"
      onToggle={(e) => {
        if (e.currentTarget.open && debugEntries.length === 0) void fetchDebugEntries()
      }}
    >
      <summary class="cursor-pointer text-gray-500">Debug log</summary>
      <div class="mt-2">
        <div class="mb-2 flex flex-wrap items-center gap-1">
          <button
            type="button"
            class="rounded border border-gray-300 px-2 py-1 text-gray-700 disabled:opacity-50"
            disabled={debugLoading}
            onClick={() => void fetchDebugEntries()}
          >
            {debugLoading ? 'Loading…' : '↻ Refresh'}
          </button>
          <button
            type="button"
            class="rounded border border-gray-300 px-2 py-1 text-gray-700"
            onClick={() => void copyDebugLog()}
          >
            Copy
          </button>
          <button
            type="button"
            class="rounded border border-gray-300 px-2 py-1 text-gray-700"
            onClick={() => void downloadDebugLog()}
          >
            Download
          </button>
          <button type="button" class="text-gray-500" onClick={() => void resetDebugLog()}>
            Clear
          </button>
          {debugCopyStatus && <span class="text-xs text-gray-400">{debugCopyStatus}</span>}
        </div>
        <div class="mb-2 flex items-center gap-1">
          <input
            type="text"
            class="flex-1 rounded border border-gray-200 px-2 py-1 text-xs"
            placeholder="Filter scope / msg / data…"
            value={debugQuery}
            onInput={(e) => setDebugQuery(e.currentTarget.value)}
          />
          <select
            class="rounded border border-gray-200 px-1 py-1 text-xs"
            value={debugLevel}
            onChange={(e) => setDebugLevel(e.currentTarget.value as 'all' | DebugLevel)}
          >
            <option value="all">all</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </div>
        {debugEntries.length === 0 ? (
          <p class="text-xs text-gray-400">
            {debugLoading ? 'Loading…' : 'No debug entries yet — refresh after an action.'}
          </p>
        ) : (
          <>
            <p class="mb-1 text-[10px] text-gray-400">
              {filteredDebugEntries.length} / {debugEntries.length} entries
            </p>
            <ol class="max-h-64 space-y-0.5 overflow-y-auto rounded border border-gray-100 p-1 font-mono">
              {filteredDebugEntries.map((entry) => (
                <li
                  key={`${entry.t}-${entry.scope}-${entry.msg}-${entry.run ?? ''}`}
                  class="border-b border-gray-50 py-0.5 last:border-0"
                >
                  <div class="flex flex-wrap items-baseline gap-1">
                    <span class={`w-8 shrink-0 text-[9px] uppercase ${levelClass(entry.level)}`}>
                      {entry.level ?? 'info'}
                    </span>
                    <span class="text-[9px] text-gray-400">{formatDebugTime(entry.t)}</span>
                    <span class="rounded bg-gray-100 px-1 text-[9px] text-gray-600">
                      {entry.scope}
                    </span>
                    <span class="text-[11px] text-gray-800">{entry.msg}</span>
                    {entry.elapsedMs !== undefined && (
                      <span class="text-[9px] text-gray-400">{entry.elapsedMs}ms</span>
                    )}
                    {entry.run !== undefined && (
                      <span class="text-[9px] text-gray-400">·{entry.run}</span>
                    )}
                  </div>
                  {entry.data !== undefined && (
                    <pre class="mt-0.5 overflow-x-auto whitespace-pre-wrap break-all text-[9px] leading-tight text-gray-500">
                      {JSON.stringify(entry.data)}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </details>
  )
}
