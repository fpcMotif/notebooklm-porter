import { Effect } from 'effect'
import { IpcError, type PorterError } from '../fx/errors'
import type { DebugLog, Http } from '../fx/services'
import { Tabs } from '../fx/services'
import { isExtractResponse, type ContentRequest } from '../messaging'
import type { Capture } from '../model/types'
import type { CaptureOptions, SourceAdapter } from './types'

/**
 * The one place that resolves an adapter's capture strategy: `url` adapters
 * run in the background service worker directly; `content-script` adapters
 * relay to the page's content script, which requires the captured tab's id.
 * Callers that already hold a narrowed `mode: 'url'` strategy (resync,
 * context-menu link capture) may call its `capture` directly instead.
 */
export function captureSource(
  adapter: SourceAdapter,
  url: string,
  ctx: { tabId?: number; options?: CaptureOptions } = {},
): Effect.Effect<Capture, PorterError, Http | DebugLog | Tabs> {
  if (adapter.strategy.mode === 'url') {
    return adapter.strategy.capture(url, ctx.options)
  }
  const tabId = ctx.tabId
  if (tabId === undefined) {
    return Effect.fail(new IpcError({ reason: 'This site captures from its open tab only' }))
  }
  return captureViaContentScript(tabId)
}

/** Relays one extract request to the tab's content script and validates the reply. */
export function captureViaContentScript(tabId: number): Effect.Effect<Capture, IpcError, Tabs> {
  return Effect.gen(function* () {
    const tabs = yield* Tabs
    const response = yield* tabs.sendMessage(tabId, {
      type: 'porter/extract-thread',
    } satisfies ContentRequest)
    if (!isExtractResponse(response)) {
      return yield* Effect.fail(new IpcError({ reason: 'Malformed content-script response' }))
    }
    if (!response.ok) {
      return yield* Effect.fail(new IpcError({ reason: response.error }))
    }
    return response.capture
  })
}
