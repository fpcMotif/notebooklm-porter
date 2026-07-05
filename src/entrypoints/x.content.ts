/**
 * X/Twitter thread extractor. Runs on status pages; on 'porter/extract-thread'
 * it walks the loaded conversation (article[data-testid="tweet"] DOM) and
 * returns a Capture { kind: 'thread' }.
 *
 * TODO(codegen): implement per docs/superpowers/specs design §X.
 */
export default defineContentScript({
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  main() {
    browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if ((message as { type?: string }).type !== 'porter/extract-thread') return
      sendResponse({ ok: false, error: 'X extraction not implemented yet' })
    })
  },
})
