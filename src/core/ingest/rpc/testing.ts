/** Shared NotebookLM wire fixtures for tests that cross the RPC seam. */
import { RPC_IDS } from './protocol'
import type { NotebookMeta } from '../../notebooks/model'

export function rpcResponse(rpcId: string, payload: unknown): string {
  const line = JSON.stringify([['wrb.fr', rpcId, JSON.stringify(payload)]])
  return `)]}'\n${line.length}\n${line}\n`
}

export function rpcRefusedResponse(rpcId: string, code: string): string {
  const line = JSON.stringify([['er', rpcId, code]])
  return `)]}'\n${line.length}\n${line}\n`
}

export function nblmSessionHtml(
  options: {
    readonly csrfToken?: string
    readonly fSid?: string
    readonly email?: string
  } = {},
): string {
  const parts = [
    `"SNlM0e":"${options.csrfToken ?? 'csrf-token-1'}"`,
    `"FdrFJe":"${options.fSid ?? 'fsid-1'}"`,
    ...(options.email !== undefined ? [`"oPEP7c":"${options.email}"`] : []),
  ]
  return parts.join('....')
}

export function notebookListResponse(notebooks: readonly NotebookMeta[]): string {
  return rpcResponse(RPC_IDS.listNotebooks, [
    notebooks.map((notebook) => [notebook.title, null, notebook.id]),
  ])
}

export function webSourceEntry(id: string, url: string, statusCode: number): unknown[] {
  return [[id], id, [null, null, [100], null, 5, null, null, [url]], [null, statusCode]]
}

export function youtubeSourceEntry(id: string, url: string, statusCode: number): unknown[] {
  return [[id], id, [null, null, null, null, 9, [url]], [null, statusCode]]
}

export function notebookWithSources(entries: unknown[]): unknown {
  return [['meta', entries]]
}
