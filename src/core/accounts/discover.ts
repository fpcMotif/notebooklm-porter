import { homeUrl } from '../ingest/rpc/protocol'
import { parseNblmHome, type NblmAccount } from './parse'

/**
 * Probes NotebookLM's `?authuser=N` homepages in order to enumerate the
 * signed-in Google accounts available to it. Runs in the background service
 * worker (needs the notebooklm.google.com session cookie). Authuser indices
 * are contiguous, so the first logged-out slot ends the scan.
 */
export async function discoverAccounts(max = 5): Promise<NblmAccount[]> {
  const accounts: NblmAccount[] = []
  for (let authuser = 0; authuser < max; authuser++) {
    // Sequential by necessity: each fetch decides whether to probe the next
    // authuser slot at all, so this can't become a Promise.all.
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(homeUrl(authuser), { credentials: 'include' })
    // eslint-disable-next-line no-await-in-loop
    const html = await res.text()
    const parsed = parseNblmHome(html)
    if (!parsed.loggedIn) break
    accounts.push({ authuser, email: parsed.email ?? '' })
  }
  return accounts
}
