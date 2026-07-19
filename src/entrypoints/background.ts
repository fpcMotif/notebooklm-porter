import { dbg } from '../core/debug'
import {
  captureContextMenuClick,
  CONTEXT_MENU_IDS,
  isContextMenuId,
} from '../core/context-menu/handler'
import { porterRuntime } from '../core/fx/runtime'
import { decodePorterMessage } from '../core/messaging'
import { drainQueue } from '../core/queue/drain'
import { QUEUE_ALARM } from '../core/queue/queue'
import { domainsForMessage, handlePorterMessage, LANE_ORDER } from '../core/router'
import { makeStorageLaneScheduler } from '../core/storage-lanes'
import { resyncOneDueWatch } from '../core/watch/resync'
import { WATCH_ALARM } from '../core/watch/watch'

export default defineBackground(() => {
  // A long capture holds only `docs`; disjoint queue drains can keep firing.
  const storageLanes = makeStorageLaneScheduler(LANE_ORDER)

  const drainOnce = () => {
    void storageLanes
      .run(['queue'], () => porterRuntime.runPromise(drainQueue()))
      .catch((err: unknown) => {
        console.error('[porter] queue drain died', err)
        dbg('bg', 'queue drain died', { error: String(err) })
      })
  }
  const resyncOnce = () => {
    void storageLanes
      .run(['docs', 'watches', 'queue'], () => porterRuntime.runPromise(resyncOneDueWatch()))
      .catch((err: unknown) => {
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
    void storageLanes
      .run(['docs'], () =>
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
    const decoded = decodePorterMessage(message)
    if (decoded === undefined) return
    const run = () => porterRuntime.runPromise(handlePorterMessage(decoded))
    const domains = domainsForMessage(decoded.type)
    const messagePromise = domains.length > 0 ? storageLanes.run(domains, run) : run()
    messagePromise.then(sendResponse).catch((err: unknown) => {
      // Defects only — typed failures are flattened inside handlePorterMessage.
      const detail = err instanceof Error && err.stack ? err.stack : err
      console.error('[porter]', decoded.type, detail)
      dbg('bg', `${decoded.type} died`, {
        error: String(err),
        ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
      })
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
    })
    return true
  })
})
