import type { Effect } from 'effect'
import { adapterForUrl } from '../core/adapters/registry'
import {
  captureSuccessBadge,
  decideBadge,
  type BadgeQueueCounts,
  type BadgeState,
} from '../core/badge/badge'
import {
  captureContextMenuClick,
  CONTEXT_MENU_IDS,
  isContextMenuId,
} from '../core/context-menu/handler'
import { dbg } from '../core/debug'
import { porterRuntime } from '../core/fx/runtime'
import { REMOTE_PROFILE_ALARM, refreshRemoteProfile } from '../core/ingest/remote-profile-loader'
import { decodePorterMessage, type PorterMessage, type PorterReply } from '../core/messaging'
import { formatDrainBurstNotification } from '../core/notify/notify'
import {
  buildCaptureSuggestion,
  buildDocSuggestion,
  classifyEnteredOmniboxText,
  fuzzyMatchDocs,
  parseOmniboxInput,
  type OmniboxSuggestion,
} from '../core/omnibox/omnibox'
import { drainQueue } from '../core/queue/drain'
import { QUEUE_ALARM, QUEUE_STORAGE_KEY, queueCounts, type QueueState } from '../core/queue/queue'
import {
  domainsForMessage,
  handlePorterMessage,
  LANE_ORDER,
  type PorterServices,
} from '../core/router'
import { makeStorageLaneScheduler } from '../core/storage-lanes'
import { listDocs } from '../core/store'
import { resyncOneDueWatch } from '../core/watch/resync'
import { WATCH_ALARM } from '../core/watch/watch'

const CAPTURE_COMMAND = 'capture-current-tab'
/** How long the post-capture checkmark stays up before the badge reverts to its normal state. */
const CAPTURE_FLASH_MS = 2000
/** Fixed id: a second burst notification updates this one instead of stacking a new one. */
const DRAIN_NOTIFICATION_ID = 'porter/drain-burst'
const NOTEBOOKLM_URL = 'https://notebooklm.google.com/'

/** Reads the durable queue straight from storage — cheap enough for a badge refresh. */
async function readQueueBadgeCounts(): Promise<BadgeQueueCounts> {
  const got = await browser.storage.local.get(QUEUE_STORAGE_KEY)
  const state = got[QUEUE_STORAGE_KEY] as QueueState | undefined
  return state === undefined ? { queued: 0, failed: 0 } : queueCounts(state)
}

async function setTabBadge(tabId: number, state: BadgeState | undefined): Promise<void> {
  if (state === undefined) {
    await browser.action.setBadgeText({ tabId, text: '' })
    return
  }
  await browser.action.setBadgeText({ tabId, text: state.text })
  await browser.action.setBadgeBackgroundColor({ tabId, color: state.color })
}

async function setGlobalBadge(state: BadgeState | undefined): Promise<void> {
  if (state === undefined) {
    await browser.action.setBadgeText({ text: '' })
    return
  }
  await browser.action.setBadgeText({ text: state.text })
  await browser.action.setBadgeBackgroundColor({ color: state.color })
}

/** Recomputes and sets one tab's badge from its url plus the current queue state. */
async function refreshTabBadge(tabId: number, url: string | undefined): Promise<void> {
  const capturable = url !== undefined ? (adapterForUrl(url)?.detect(url) ?? null) : null
  const queue = await readQueueBadgeCounts()
  await setTabBadge(tabId, decideBadge(capturable, queue))
}

/**
 * Sets the tabId-less default badge from queue counts alone — the fallback
 * every tab shows until it gets its own capturable-hint override, so a new
 * tab reflects a failed/queued burst immediately.
 */
async function refreshGlobalBadge(): Promise<void> {
  const queue = await readQueueBadgeCounts()
  await setGlobalBadge(decideBadge(null, queue))
}

/** A per-tab override outlives a queue-count change, so every active tab is recomputed too. */
async function refreshActiveTabBadges(): Promise<void> {
  const tabs = await browser.tabs.query({ active: true })
  await Promise.all(
    tabs.map((tab) => (tab.id !== undefined ? refreshTabBadge(tab.id, tab.url) : undefined)),
  )
}

function flashCaptureBadge(tabId: number, url: string | undefined): Promise<void> {
  return setTabBadge(tabId, captureSuccessBadge()).then(() => {
    setTimeout(() => {
      void refreshTabBadge(tabId, url).catch(() => undefined)
    }, CAPTURE_FLASH_MS)
    return undefined
  })
}

/** `browser.action.openPopup` needs a user gesture and can still reject; a notebooklm.google.com tab always works. */
async function openNotebookLmOrPopup(): Promise<void> {
  try {
    await browser.action.openPopup()
  } catch {
    await browser.tabs.create({ url: NOTEBOOKLM_URL }).catch(() => undefined)
  }
}

/**
 * `handlePorterMessage` is typed over the whole `PorterMessage` union, so its
 * return type doesn't narrow to one message's reply from a single call site.
 * This in-process dispatch (the command + omnibox capture paths, which never
 * go through `runtime.sendMessage`) narrows it back with one documented
 * cast — the same trick the popup↔background wire uses in fx/layers.ts.
 */
function dispatchCaptureUrl(
  msg: Extract<PorterMessage, { type: 'porter/capture-url' }>,
): Effect.Effect<PorterReply<'porter/capture-url'>, never, PorterServices> {
  return handlePorterMessage(msg) as Effect.Effect<
    PorterReply<'porter/capture-url'>,
    never,
    PorterServices
  >
}

// Unserialized: the profile refresh touches only its own storage key.
const refreshProfileOnce = () => {
  void porterRuntime.runPromise(refreshRemoteProfile()).catch((err: unknown) => {
    console.error('[porter] remote profile refresh died', err)
    dbg('bg', 'remote profile refresh died', { error: String(err) })
  })
}

export default defineBackground(() => {
  // A long capture holds only `docs`; disjoint queue drains can keep firing.
  const storageLanes = makeStorageLaneScheduler(LANE_ORDER)

  /** Shared by the keyboard command and the omnibox: capture a URL through the docs lane. */
  const runCaptureUrl = (url: string, tabId: number) =>
    storageLanes.run(['docs'], () =>
      porterRuntime.runPromise(dispatchCaptureUrl({ type: 'porter/capture-url', url, tabId })),
    )

  const drainOnce = () => {
    void storageLanes
      .run(['queue'], () => porterRuntime.runPromise(drainQueue()))
      .then((result) => {
        const notification = formatDrainBurstNotification(result.counts)
        if (notification === undefined) return undefined
        return browser.notifications
          .create(DRAIN_NOTIFICATION_ID, {
            type: 'basic',
            iconUrl: browser.runtime.getURL('/icon/128.png'),
            title: notification.title,
            message: notification.message,
          })
          .then(() => undefined)
          .catch((err: unknown) => {
            dbg('bg', 'drain notification failed', { error: String(err) })
          })
      })
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
    if (alarm.name === REMOTE_PROFILE_ALARM) refreshProfileOnce()
  })
  drainOnce()
  resyncOnce()
  refreshProfileOnce()

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

  // --- 1. Keyboard command: capture the active tab without opening the popup ---
  browser.commands.onCommand.addListener((command) => {
    if (command !== CAPTURE_COMMAND) return
    void (async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
      if (tab?.id === undefined || tab.url === undefined) return
      const reply = await runCaptureUrl(tab.url, tab.id)
      if (reply.ok) {
        dbg('bg', 'command capture stored', { docs: reply.docs.length })
        await flashCaptureBadge(tab.id, tab.url)
      } else {
        dbg('bg', 'command capture failed', { error: reply.error })
      }
    })().catch((err: unknown) => {
      dbg('bg', 'command capture died', { error: String(err) })
    })
  })

  // --- 2. Capturable-page badge + queue counts ---
  browser.tabs.onActivated.addListener((activeInfo) => {
    void browser.tabs
      .get(activeInfo.tabId)
      .then((tab) => refreshTabBadge(activeInfo.tabId, tab.url))
      .catch(() => undefined)
  })
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url === undefined && changeInfo.status !== 'complete') return
    void refreshTabBadge(tabId, tab.url).catch(() => undefined)
  })
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(QUEUE_STORAGE_KEY in changes)) return
    void refreshGlobalBadge().catch(() => undefined)
    void refreshActiveTabBadges().catch(() => undefined)
  })
  void refreshGlobalBadge().catch(() => undefined)
  void refreshActiveTabBadges().catch(() => undefined)

  // --- 3. Omnibox "nlm" keyword ---
  void browser.omnibox.setDefaultSuggestion({
    description: 'Capture this URL, or search your captured docs',
  })
  browser.omnibox.onInputChanged.addListener((text, suggest) => {
    const intent = parseOmniboxInput(text)
    const urlSuggestions: OmniboxSuggestion[] = []
    if (intent.kind === 'url') {
      const adapter = adapterForUrl(intent.url)
      const capturable = adapter?.detect(intent.url) ?? null
      if (capturable !== null) urlSuggestions.push(buildCaptureSuggestion(intent.url, capturable))
    }
    void porterRuntime
      .runPromise(listDocs())
      .then((docs) => {
        suggest([...urlSuggestions, ...fuzzyMatchDocs(docs, text).map(buildDocSuggestion)])
        return undefined
      })
      .catch(() => suggest(urlSuggestions))
  })
  browser.omnibox.onInputEntered.addListener((text) => {
    const intent = classifyEnteredOmniboxText(text)
    if (intent.kind === 'capture') {
      void runCaptureUrl(intent.url, browser.tabs.TAB_ID_NONE)
        .then((reply) => {
          dbg(
            'bg',
            'omnibox capture',
            reply.ok ? { docs: reply.docs.length } : { error: reply.error },
          )
          return undefined
        })
        .catch((err: unknown) => {
          dbg('bg', 'omnibox capture died', { error: String(err) })
        })
    } else if (intent.kind === 'open-doc') {
      void openNotebookLmOrPopup()
    } else if (intent.kind === 'open-url') {
      void browser.tabs.create({ url: intent.url }).catch(() => undefined)
    }
  })

  // --- 4. Drain-outcome notification click → jump to NotebookLM ---
  browser.notifications.onClicked.addListener((notificationId) => {
    if (notificationId !== DRAIN_NOTIFICATION_ID) return
    void openNotebookLmOrPopup()
  })
})
