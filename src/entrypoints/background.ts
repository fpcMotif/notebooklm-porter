import { dbg } from '../core/debug'
import { porterRuntime } from '../core/fx/runtime'
import { isPorterMessage } from '../core/messaging'
import { handlePorterMessage } from '../core/router'

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isPorterMessage(message)) return
    porterRuntime
      .runPromise(handlePorterMessage(message))
      .then(sendResponse)
      .catch((err: unknown) => {
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
