import { adapterForUrl } from '../core/adapters/registry'
import { isPorterMessage, type PorterMessage, type PorterResponse } from '../core/messaging'
import { deleteDoc, listDocs, upsertDoc } from '../core/store'

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isPorterMessage(message)) return
    handle(message)
      .then(sendResponse)
      .catch((err: unknown) => {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
      })
    return true
  })
})

async function handle(msg: PorterMessage): Promise<PorterResponse> {
  switch (msg.type) {
    case 'porter/detect': {
      const capturable = adapterForUrl(msg.url)?.detect(msg.url)
      return { ok: true, ...(capturable ? { capturable: capturable.label } : {}) }
    }
    case 'porter/capture-url': {
      const adapter = adapterForUrl(msg.url)
      if (!adapter?.captureFromUrl) return { ok: false, error: 'Nothing capturable on this page' }
      const capture = await adapter.captureFromUrl(msg.url)
      const { formatCapture } = await import('../core/format/format')
      const doc = formatCapture(capture)
      await upsertDoc(doc)
      return { ok: true, docs: [doc] }
    }
    case 'porter/capture-page': {
      const response: unknown = await browser.tabs.sendMessage(msg.tabId, {
        type: 'porter/extract-thread',
      })
      const result = response as { ok: boolean; capture?: unknown; error?: string }
      if (!result.ok || !result.capture) {
        return { ok: false, error: result.error ?? 'Extraction failed' }
      }
      const { formatCapture } = await import('../core/format/format')
      const doc = formatCapture(result.capture as Parameters<typeof formatCapture>[0])
      await upsertDoc(doc)
      return { ok: true, docs: [doc] }
    }
    case 'porter/capture-result': {
      const { formatCapture } = await import('../core/format/format')
      const doc = formatCapture(msg.capture)
      await upsertDoc(doc)
      return { ok: true, docs: [doc] }
    }
    case 'porter/list-docs':
      return { ok: true, docs: await listDocs() }
    case 'porter/delete-doc':
      await deleteDoc(msg.docId)
      return { ok: true }
    case 'porter/export': {
      const { exportDocs } = await import('../core/ingest/export')
      await exportDocs(msg.docIds, msg.format)
      return { ok: true }
    }
    case 'porter/ingest': {
      const { ingestIntoNotebook } = await import('../core/ingest/notebooklm')
      const { getSettings } = await import('../core/settings')
      const settings = await getSettings()
      await ingestIntoNotebook(msg.docIds, { authuser: settings.nblmAuthuser })
      return { ok: true }
    }
    case 'porter/accounts-refresh': {
      const { discoverAccounts } = await import('../core/accounts/discover')
      const { getSettings, updateSettings } = await import('../core/settings')
      const [accounts, current] = await Promise.all([discoverAccounts(), getSettings()])
      const stillValid = accounts.some((a) => a.authuser === current.nblmAuthuser)
      const nblmAuthuser = stillValid ? current.nblmAuthuser : (accounts[0]?.authuser ?? 0)
      await updateSettings({ accounts, nblmAuthuser })
      return { ok: true, accounts }
    }
    case 'porter/get-settings': {
      const { getSettings } = await import('../core/settings')
      return { ok: true, settings: await getSettings() }
    }
    case 'porter/update-settings': {
      const { updateSettings } = await import('../core/settings')
      const settings = await updateSettings(msg.patch)
      return { ok: true, settings }
    }
  }
}
