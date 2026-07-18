import { isRecord } from '../../fx/guards'
import type { IngestUnit } from '../units'

/** One visible-tab attempt for an immutable queue unit. */
export interface DomDeliveryRequest {
  notebookId: string
  authuser: number
  unit: IngestUnit
}

/**
 * `unavailable` proves no DOM action started; `uncertain` is reserved for a
 * relay or postcondition break after the content script might have acted.
 */
export type DomDeliveryResult =
  | { status: 'sent' }
  | { status: 'unavailable'; reason: string }
  | { status: 'uncertain'; reason: string }

function isIngestUnit(value: unknown): value is IngestUnit {
  if (!isRecord(value)) return false
  if (
    typeof value.docId !== 'string' ||
    typeof value.id !== 'string' ||
    typeof value.contentHash !== 'string'
  ) {
    return false
  }
  if (value.kind === 'text') {
    return typeof value.title === 'string' && typeof value.markdown === 'string'
  }
  return value.kind === 'youtube' && typeof value.url === 'string'
}

export function isDomDeliveryRequest(value: unknown): value is DomDeliveryRequest {
  return (
    isRecord(value) &&
    typeof value.notebookId === 'string' &&
    value.notebookId.length > 0 &&
    typeof value.authuser === 'number' &&
    Number.isInteger(value.authuser) &&
    value.authuser >= 0 &&
    isIngestUnit(value.unit)
  )
}

/** A DOM driver may submit only in the exact notebook path requested by the queue. */
export function isTargetNotebookUrl(url: string, notebookId: string): boolean {
  try {
    const parsed = new URL(url)
    const targetPath = `/notebook/${encodeURIComponent(notebookId)}`
    return (
      parsed.origin === 'https://notebooklm.google.com' &&
      (parsed.pathname === targetPath || parsed.pathname === `${targetPath}/`)
    )
  } catch {
    return false
  }
}

export function isDomDeliveryResult(value: unknown): value is DomDeliveryResult {
  if (!isRecord(value) || typeof value.status !== 'string') return false
  if (value.status === 'sent') return true
  return (
    (value.status === 'unavailable' || value.status === 'uncertain') &&
    typeof value.reason === 'string' &&
    value.reason.length > 0
  )
}

/** A malformed relay response is never treated as a safe retry. */
export function normalizeDomDeliveryResult(value: unknown): DomDeliveryResult {
  return isDomDeliveryResult(value)
    ? value
    : { status: 'uncertain', reason: 'NotebookLM DOM relay returned an invalid response' }
}
