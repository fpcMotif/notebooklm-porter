import { Effect } from 'effect'
import { IpcError, type PorterError } from '../fx/errors'
import type { DebugLog, Http } from '../fx/services'
import { Tabs } from '../fx/services'
import { decodeExtractResponse, type ContentRequest } from '../messaging'
import type { Capture, SiteId } from '../model/types'
import { resolveCapturable, type ResolvedCapturable } from './registry'
import type { CaptureOptions, CaptureStrategy, SourceAdapter } from './types'

type UrlCaptureStrategy = Extract<CaptureStrategy, { mode: 'url' }>

export type ResolvedUrlCapturable = ResolvedCapturable & {
  adapter: SourceAdapter & { strategy: UrlCaptureStrategy }
}

export function isResolvedUrlCapturable(
  resolved: ResolvedCapturable,
): resolved is ResolvedUrlCapturable {
  return resolved.adapter.strategy.mode === 'url'
}

/**
 * The one place that resolves an adapter's capture strategy: `url` adapters
 * run in the background service worker directly; `content-script` adapters
 * relay to the page's content script, which requires the captured tab's id.
 * URL-only callers use `captureResolvedUrl`, which keeps their environment
 * narrow while retaining the same returned-capture validation.
 */
export function captureSource(
  resolved: ResolvedCapturable,
  ctx: { tabId?: number; options?: CaptureOptions } = {},
): Effect.Effect<Capture, PorterError, Http | DebugLog | Tabs> {
  if (isResolvedUrlCapturable(resolved)) {
    return captureResolvedUrl(resolved, ctx.options)
  }
  const tabId = ctx.tabId
  if (tabId === undefined) {
    return Effect.fail(new IpcError({ reason: 'This site captures from its open tab only' }))
  }
  return captureViaContentScript(tabId).pipe(Effect.flatMap(validateCapture(resolved)))
}

/** Runs a resolved background capture without widening its environment to Tabs. */
export function captureResolvedUrl(
  resolved: ResolvedUrlCapturable,
  options?: CaptureOptions,
): Effect.Effect<Capture, PorterError, Http | DebugLog> {
  return resolved.adapter.strategy
    .capture(resolved.url, options)
    .pipe(Effect.flatMap(validateCapture(resolved)))
}

function captureSite(capture: Capture): SiteId {
  switch (capture.kind) {
    case 'thread':
      return capture.thread.site
    case 'playlist':
    case 'video':
      return 'youtube'
    case 'web':
      return 'web'
  }
}

/** Guards the adapter boundary before an untrusted result reaches storage. */
function validateCapture(resolved: ResolvedCapturable) {
  return (capture: Capture): Effect.Effect<Capture, IpcError> => {
    const returned = resolveCapturable(captureUrl(capture))
    if (
      capture.kind !== resolved.capturable.kind ||
      captureSite(capture) !== resolved.adapter.id ||
      returned === undefined ||
      returned.adapter.id !== resolved.adapter.id ||
      returned.capturable.kind !== resolved.capturable.kind ||
      returned.capturable.identity !== resolved.capturable.identity
    ) {
      return Effect.fail(new IpcError({ reason: 'Captured source did not match this URL' }))
    }
    return Effect.succeed(capture)
  }
}

function captureUrl(capture: Capture): string {
  switch (capture.kind) {
    case 'thread':
      return capture.thread.url
    case 'playlist':
      return capture.playlist.url
    case 'video':
      return capture.video.url
    case 'web':
      return capture.web.url
  }
}

/** Relays one extract request to the tab's content script and validates the reply. */
export function captureViaContentScript(tabId: number): Effect.Effect<Capture, IpcError, Tabs> {
  return Effect.gen(function* () {
    const tabs = yield* Tabs
    const response = yield* tabs.sendMessage(tabId, {
      type: 'porter/extract-thread',
    } satisfies ContentRequest)
    const decoded = decodeExtractResponse(response)
    if (decoded === undefined) {
      return yield* Effect.fail(new IpcError({ reason: 'Malformed content-script response' }))
    }
    if (!decoded.ok) {
      return yield* Effect.fail(new IpcError({ reason: decoded.error }))
    }
    return decoded.capture
  })
}
