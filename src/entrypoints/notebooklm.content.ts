/**
 * NotebookLM ingest assist. Runs on notebooklm.google.com; on
 * 'porter/dom-deliver' it will drive the Add Source dialog for one immutable
 * unit. It deliberately stays pre-submit until an authenticated selector
 * profile is observed and reviewed against a disposable NotebookLM notebook.
 */
import {
  isDomDeliveryRequest,
  isTargetNotebookUrl,
  type DomDeliveryResult,
} from '../core/ingest/dom/contracts'
import { activeDomSelectorProfile } from '../core/ingest/dom/selectors'
import { hasMessageType } from '../core/messaging'

export default defineContentScript({
  matches: ['https://notebooklm.google.com/*'],
  main() {
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!hasMessageType(message, 'porter/dom-deliver')) return
      const profile = activeDomSelectorProfile()
      const response: DomDeliveryResult = !isDomDeliveryRequest(message.request)
        ? { status: 'unavailable', reason: 'NotebookLM DOM request was invalid' }
        : !isTargetNotebookUrl(location.href, message.request.notebookId)
          ? { status: 'unavailable', reason: 'NotebookLM tab does not match the queued target' }
          : profile === undefined
            ? {
                status: 'unavailable',
                reason: 'NotebookLM DOM selectors await authenticated live verification',
              }
            : {
                status: 'unavailable',
                reason: `NotebookLM DOM profile ${profile.id} has no verified driver yet`,
              }
      sendResponse(response)
    })
  },
})
