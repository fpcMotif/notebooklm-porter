/**
 * Thin service-worker wrapper around the pure builders in ./protocol.ts.
 * Owns everything protocol.ts deliberately doesn't: fetch, credentials, and
 * distinguishing not-logged-in from a bad HTTP response. Untested —
 * exercised by the real extension (CLAUDE.md: SW fetch wrappers are thin
 * glue, business logic stays in the pure/tested layer).
 */
import { parseNblmHome } from '../../accounts/parse'
import {
  addTextSourceParams,
  addUrlSourceParams,
  addYoutubeSourceParams,
  buildEnvelope,
  buildRpcUrl,
  createNotebookParams,
  homeUrl,
  listNotebooksParams,
  parseBatchexecuteResponse,
  parseNotebookList,
  RPC_IDS,
} from './protocol'

export interface NblmSession {
  csrfToken: string
  fSid?: string
}

function notebookSourcePath(notebookId: string): string {
  return `/notebook/${encodeURIComponent(notebookId)}`
}

export async function fetchSession(authuser: number): Promise<NblmSession> {
  const res = await fetch(homeUrl(authuser), { credentials: 'include' })
  const html = await res.text()
  const parsed = parseNblmHome(html)
  if (!parsed.loggedIn || parsed.csrfToken === undefined) {
    throw new Error('not-logged-in: open notebooklm.google.com and sign in')
  }
  return {
    csrfToken: parsed.csrfToken,
    ...(parsed.fSid !== undefined ? { fSid: parsed.fSid } : {}),
  }
}

export async function rpcCall(
  rpcId: string,
  params: unknown,
  session: NblmSession,
  authuser: number,
  sourcePath?: string,
): Promise<unknown> {
  const url = buildRpcUrl({
    rpcId,
    authuser,
    ...(session.fSid !== undefined ? { fSid: session.fSid } : {}),
    ...(sourcePath !== undefined ? { sourcePath } : {}),
  })
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: buildEnvelope(rpcId, params, session.csrfToken),
  })
  if (!res.ok) {
    throw new Error(`rpc-http-error: ${res.status} ${res.statusText}`)
  }
  const text = await res.text()
  return parseBatchexecuteResponse(text, rpcId)
}

export async function listNotebooks(
  session: NblmSession,
  authuser: number,
): Promise<{ id: string; title: string }[]> {
  const result = await rpcCall(RPC_IDS.listNotebooks, listNotebooksParams(), session, authuser, '/')
  return parseNotebookList(result)
}

export async function createNotebook(
  title: string,
  session: NblmSession,
  authuser: number,
): Promise<unknown> {
  return rpcCall(RPC_IDS.createNotebook, createNotebookParams(title), session, authuser, '/')
}

export async function addYoutubeSource(
  notebookId: string,
  url: string,
  session: NblmSession,
  authuser: number,
): Promise<unknown> {
  return rpcCall(
    RPC_IDS.addSource,
    addYoutubeSourceParams(notebookId, url),
    session,
    authuser,
    notebookSourcePath(notebookId),
  )
}

export async function addUrlSource(
  notebookId: string,
  url: string,
  session: NblmSession,
  authuser: number,
): Promise<unknown> {
  return rpcCall(
    RPC_IDS.addSource,
    addUrlSourceParams(notebookId, url),
    session,
    authuser,
    notebookSourcePath(notebookId),
  )
}

export async function addTextSource(
  notebookId: string,
  title: string,
  content: string,
  session: NblmSession,
  authuser: number,
): Promise<unknown> {
  return rpcCall(
    RPC_IDS.addSource,
    addTextSourceParams(notebookId, title, content),
    session,
    authuser,
    notebookSourcePath(notebookId),
  )
}
