import { Effect, Result } from 'effect'
import { adapterForUrl } from '../adapters/registry'
import type { PorterError, StorageError } from '../fx/errors'
import { DebugLog, Http, Scripting, type Kv } from '../fx/services'
import { formatCapture } from '../format/format'
import type { Capture, SourceDoc } from '../model/types'
import { storeCapturedDoc } from '../store'
import { createWebCapture } from './capture'

export const CONTEXT_MENU_IDS = {
  selection: 'porter/capture-selection',
  page: 'porter/capture-page',
  link: 'porter/capture-link',
} as const

export type ContextMenuId = (typeof CONTEXT_MENU_IDS)[keyof typeof CONTEXT_MENU_IDS]

export interface ContextMenuClick {
  menuId: ContextMenuId
  tabId?: number
  pageUrl?: string
  pageTitle?: string
  selectionText?: string
  linkUrl?: string
}

export function isContextMenuId(value: unknown): value is ContextMenuId {
  return Object.values(CONTEXT_MENU_IDS).includes(value as ContextMenuId)
}

function storeCapture(capture: Capture): Effect.Effect<SourceDoc, StorageError, DebugLog | Kv> {
  const doc = formatCapture(capture)
  return storeCapturedDoc(doc).pipe(Effect.as(doc))
}

function genericLinkCapture(click: ContextMenuClick): Capture | undefined {
  if (click.linkUrl === undefined) return undefined
  const web = createWebCapture({
    mode: 'link',
    url: click.linkUrl,
    text: click.linkUrl,
    ...(click.pageTitle !== undefined ? { title: click.pageTitle } : {}),
  })
  return web === undefined ? undefined : { kind: 'web', web }
}

function genericSelectionCapture(click: ContextMenuClick): Capture | undefined {
  if (click.pageUrl === undefined || click.selectionText === undefined) return undefined
  const web = createWebCapture({
    mode: 'selection',
    url: click.pageUrl,
    text: click.selectionText,
    ...(click.pageTitle !== undefined ? { title: click.pageTitle } : {}),
  })
  return web === undefined ? undefined : { kind: 'web', web }
}

function genericPageCapture(
  click: ContextMenuClick,
): Effect.Effect<Capture | undefined, never, DebugLog | Scripting> {
  if (click.tabId === undefined || click.pageUrl === undefined) return Effect.succeed(undefined)
  const { tabId, pageUrl } = click
  return Effect.gen(function* () {
    const scripting = yield* Scripting
    const extracted = yield* Effect.result(scripting.extractPageText(tabId))
    if (Result.isFailure(extracted)) {
      // A blocked injection (chrome://, PDF viewer, store pages) otherwise
      // looks identical to "nothing selected" — leave a breadcrumb.
      const debugLog = yield* DebugLog
      yield* debugLog.log(
        'context-menu',
        'page text extraction failed',
        { tabId, error: String(extracted.failure) },
        { level: 'warn' },
      )
      return undefined
    }
    const title = extracted.success.title || click.pageTitle
    const web = createWebCapture({
      mode: 'page',
      url: pageUrl,
      text: extracted.success.text,
      ...(title !== undefined ? { title } : {}),
    })
    return web === undefined ? undefined : { kind: 'web', web }
  })
}

function adapterLinkCapture(
  linkUrl: string,
): Effect.Effect<SourceDoc | undefined, PorterError, Http | DebugLog | Kv> {
  const adapter = adapterForUrl(linkUrl)
  if (adapter === undefined || adapter.strategy.mode !== 'url' || adapter.detect(linkUrl) === null)
    return Effect.succeed(undefined)
  return adapter.strategy.capture(linkUrl).pipe(Effect.flatMap(storeCapture))
}

/**
 * Captures browser context locally. It deliberately never enqueues a remote
 * NotebookLM mutation: target selection and durable queueing remain explicit
 * popup actions.
 */
export function captureContextMenuClick(
  click: ContextMenuClick,
): Effect.Effect<SourceDoc | undefined, PorterError, Http | DebugLog | Kv | Scripting> {
  if (click.menuId === CONTEXT_MENU_IDS.selection) {
    const capture = genericSelectionCapture(click)
    return capture === undefined ? Effect.succeed(undefined) : storeCapture(capture)
  }

  if (click.menuId === CONTEXT_MENU_IDS.page) {
    return Effect.gen(function* () {
      const capture = yield* genericPageCapture(click)
      return capture === undefined ? undefined : yield* storeCapture(capture)
    })
  }

  if (click.linkUrl === undefined) return Effect.succeed(undefined)
  const { linkUrl } = click
  return Effect.gen(function* () {
    const debugLog = yield* DebugLog
    const adapterDoc = yield* adapterLinkCapture(linkUrl)
    if (adapterDoc !== undefined) {
      yield* debugLog.log('context-menu', 'link captured', {
        via: 'adapter',
        adapterId: adapterForUrl(linkUrl)?.id ?? 'none',
        docId: adapterDoc.id,
      })
      return adapterDoc
    }
    const capture = genericLinkCapture(click)
    if (capture === undefined) {
      yield* debugLog.log('context-menu', 'link capture rejected', {}, { level: 'warn' })
      return undefined
    }
    const doc = yield* storeCapture(capture)
    yield* debugLog.log('context-menu', 'link captured', { via: 'generic', docId: doc.id })
    return doc
  })
}
