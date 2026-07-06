/**
 * Multi-account NotebookLM support hinges on scraping two tokens out of the
 * NBLM homepage HTML per Google account (`?authuser=N`): the CSRF token used
 * to sign RPCs (design §4) and the account's own email, for the account
 * switcher UI. Pure — the caller (background SW) owns the fetch.
 */
export interface NblmAccount {
  authuser: number
  email: string
}

const CSRF_RE = /"SNlM0e":"([^"]+)"/
const EMAIL_RE = /"oPEP7c":"([^"]+)"/
const GENERIC_EMAIL_RE = /"([\w.+-]+@[\w-]+(?:\.[\w-]+)+)"/

/**
 * loggedIn is true iff a CSRF token is present — that's the one signal that
 * survives markup churn (jetpack's homepage layout assumptions don't).
 */
export function parseNblmHome(html: string): {
  loggedIn: boolean
  email?: string
  csrfToken?: string
} {
  const csrfMatch = CSRF_RE.exec(html)
  const csrfToken = csrfMatch?.[1]

  const email = EMAIL_RE.exec(html)?.[1] ?? GENERIC_EMAIL_RE.exec(html)?.[1]

  return {
    loggedIn: csrfToken !== undefined,
    ...(email !== undefined ? { email } : {}),
    ...(csrfToken !== undefined ? { csrfToken } : {}),
  }
}
