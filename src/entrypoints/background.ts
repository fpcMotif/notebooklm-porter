import { dbg } from '../core/debug'
import {
  captureContextMenuClick,
  CONTEXT_MENU_IDS,
  isContextMenuId,
} from '../core/context-menu/handler'
import { porterRuntime } from '../core/fx/runtime'
import { isPorterMessage } from '../core/messaging'
import { drainQueue } from '../core/queue/drain'
import { QUEUE_ALARM } from '../core/queue/queue'
import { handlePorterMessage } from '../core/router'
import { resyncOneDueWatch } from '../core/watch/resync'
import { WATCH_ALARM } from '../core/watch/watch'

/** Storage domains, listed in the fixed global lane-acquisition order. */
type SerializedDomain = 'docs' | 'watches' | 'queue'
const LANE_ORDER: readonly SerializedDomain[] = ['docs', 'watches', 'queue']

/**
 * Which storage domains a message mutates. Work spanning several domains
 * (delete-doc, and the internal watch resync) holds all their lanes, always
 * acquired in LANE_ORDER so the composition stays deadlock-free. Network-bearing
 * captures live on the `docs` lane alone, so a long transcript capture never
 * starves queue drains — which only touch the disjoint `queue` domain. Messages
 * that mutate no shared storage run unserialized.
 */
function serializedDomainsFor(type: string): SerializedDomain[] {
  if (type.startsWith('porter/queue-')) return ['queue']
  if (type.startsWith('porter/watch-')) return ['watches']
  if (
    type === 'porter/capture-url' ||
    type === 'porter/capture-page' ||
    type === 'porter/capture-result'
  ) {
    return ['docs']
  }
  if (type === 'porter/delete-doc') return ['docs', 'watches']
  return []
}

/** A promise-chain mutex over one storage domain. */
type Lane = <A>(run: () => Promise<A>) => Promise<A>

/**
 * One serialization lane. A long network capture only holds the `docs` lane,
 * so durable queue drains (the `queue` lane) keep firing on their alarm
 * instead of queuing behind it.
 */
function makeLane(): Lane {
  let tail: Promise<void> = Promise.resolve()
  return (run) => {
    const next = tail.then(run, run)
    tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

export default defineBackground(() => {
  const lanes: Record<SerializedDomain, Lane> = {
    docs: makeLane(),
    watches: makeLane(),
    queue: makeLane(),
  }
  // Hold every needed lane, acquired outermost-first in LANE_ORDER.
  const serialize = <A>(domains: readonly SerializedDomain[], run: () => Promise<A>): Promise<A> =>
    LANE_ORDER.filter((domain) => domains.includes(domain)).reduceRight<() => Promise<A>>(
      (acc, domain) => () => lanes[domain](acc),
      run,
    )()

  const drainOnce = () => {
    void serialize(['queue'], () => porterRuntime.runPromise(drainQueue())).catch(
      (err: unknown) => {
        console.error('[porter] queue drain died', err)
        dbg('bg', 'queue drain died', { error: String(err) })
      },
    )
  }
  const resyncOnce = () => {
    void serialize(['docs', 'watches', 'queue'], () =>
      porterRuntime.runPromise(resyncOneDueWatch()),
    ).catch((err: unknown) => {
      console.error('[porter] watch resync died', err)
      dbg('bg', 'watch resync died', { error: String(err) })
    })
  }

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === QUEUE_ALARM) drainOnce()
    if (alarm.name === WATCH_ALARM) resyncOnce()
  })
  drainOnce()
  resyncOnce()

  void browser.contextMenus
    .removeAll()
    .then(() => {
      browser.contextMenus.create({
        id: CONTEXT_MENU_IDS.selection,
        title: 'Capture selection in NotebookLM Porter',
        contexts: ['selection'],
      })
      browser.contextMenus.create({
        id: CONTEXT_MENU_IDS.page,
        title: 'Capture page in NotebookLM Porter',
        contexts: ['page'],
      })
      browser.contextMenus.create({
        id: CONTEXT_MENU_IDS.link,
        title: 'Capture link in NotebookLM Porter',
        contexts: ['link'],
      })
      return undefined
    })
    .catch((err: unknown) => {
      dbg('bg', 'context-menu registration failed', { error: String(err) })
    })

  browser.contextMenus.onClicked.addListener((info, tab) => {
    const menuId = info.menuItemId
    if (!isContextMenuId(menuId)) return
    void serialize(['docs'], () =>
      porterRuntime.runPromise(
        captureContextMenuClick({
          menuId,
          ...(tab?.id !== undefined ? { tabId: tab.id } : {}),
          ...(info.pageUrl !== undefined ? { pageUrl: info.pageUrl } : {}),
          ...(tab?.title !== undefined ? { pageTitle: tab.title } : {}),
          ...(info.selectionText !== undefined ? { selectionText: info.selectionText } : {}),
          ...(info.linkUrl !== undefined ? { linkUrl: info.linkUrl } : {}),
        }),
      ),
    )
      .then((doc) => {
        if (doc !== undefined) dbg('bg', 'context-menu capture stored', { docId: doc.id })
        return undefined
      })
      .catch((err: unknown) => {
        dbg('bg', 'context-menu capture failed', { error: String(err) })
        return undefined
      })
  })

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isPorterMessage(message)) return
    const run = () => porterRuntime.runPromise(handlePorterMessage(message))
    const domains = serializedDomainsFor(message.type)
    const messagePromise = domains.length > 0 ? serialize(domains, run) : run()
    messagePromise.then(sendResponse).catch((err: unknown) => {
      // Defects only — typed failures are flattened inside handlePorterMessage.
      const detail = err instanceof Error && err.stack ? err.stack : err
      console.error('[porter]', message.type, detail)
      dbg('bg', `${message.type} died`, {
        error: String(err),
        ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
      })
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
    })
    return true
  })
})
