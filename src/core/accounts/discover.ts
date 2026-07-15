import { Effect } from 'effect'
import type { FetchError, HttpStatusError } from '../fx/errors'
import { DebugLog, Http, withHttpTimeout } from '../fx/services'
import { homeUrl } from '../ingest/rpc/protocol'
import { parseNblmHome, type NblmAccount } from './parse'

/**
 * Probes NotebookLM's `?authuser=N` homepages in order to enumerate the
 * signed-in Google accounts available to it. Runs in the background service
 * worker (needs the notebooklm.google.com session cookie). Authuser indices
 * are contiguous, so the first logged-out slot ends the scan.
 */
export function discoverAccounts(
  max = 5,
): Effect.Effect<NblmAccount[], FetchError | HttpStatusError, Http | DebugLog> {
  return Effect.gen(function* () {
    const http = yield* Http
    const debugLog = yield* DebugLog

    const accounts: NblmAccount[] = []
    for (let authuser = 0; authuser < max; authuser++) {
      // Sequential by necessity: each fetch decides whether to probe the next
      // authuser slot at all, so this can't become an Effect.all.
      const url = homeUrl(authuser)
      const html = yield* withHttpTimeout(http.text(url, { credentials: 'include' }), url)
      const parsed = parseNblmHome(html)
      yield* debugLog.log('accounts', 'probe', {
        authuser,
        loggedIn: parsed.loggedIn,
        ...(parsed.email !== undefined ? { email: parsed.email } : {}),
      })
      if (!parsed.loggedIn) break
      accounts.push({ authuser, email: parsed.email ?? '' })
    }
    return accounts
  })
}
