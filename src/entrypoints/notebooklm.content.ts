/**
 * NotebookLM ingest assist. Runs on notebooklm.google.com; on
 * 'porter/ingest-doc' it drives the Add Source → Copied text dialog for
 * one doc and reports success/failure so the background can pace a queue.
 *
 * TODO(codegen): implement per docs/superpowers/specs design §Ingest.
 */
export default defineContentScript({
  matches: ['https://notebooklm.google.com/*'],
  main() {
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if ((message as { type?: string }).type !== 'porter/ingest-doc') return
      sendResponse({ ok: false, error: 'NotebookLM ingest assist not implemented yet' })
    })
  },
})
