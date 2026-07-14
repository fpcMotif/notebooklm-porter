/**
 * The NotebookLM source-console domain model. A `NotebookSource` is one source
 * row *inside* a notebook, decoded from the GET_NOTEBOOK (rLM1Ne) response.
 * NotebookLM is the management backend here — the console reads these rows to
 * find duplicate sources and diagnose failed loads, then acts via DELETE_SOURCE
 * / REFRESH_SOURCE. Kept pure + unit-tested; the wire decode lives in
 * `../rpc/protocol.ts` and hands back these shapes.
 *
 * Status + type codes are the ones NotebookLM ships at `entry[3][1]` and
 * `metadata[4]` (verified against notebooklm-py's `rpc/types.py`).
 */

/** Processing state of a source. `error` is the retry/diagnose target. */
export type SourceLoadStatus = 'processing' | 'ready' | 'error' | 'preparing' | 'unknown'

/** What a source was created from. Drives failure diagnosis + retry strategy. */
export type SourceKind =
  | 'google_docs'
  | 'google_other'
  | 'pdf'
  | 'pasted_text'
  | 'web_page'
  | 'generated_text'
  | 'youtube'
  | 'unknown'

export interface NotebookSource {
  /** Server-assigned source id — the handle DELETE_SOURCE / REFRESH_SOURCE take. */
  id: string
  title: string
  /** Canonical source URL when the source has one (web/youtube/drive); omitted for pasted text. */
  url?: string
  kind: SourceKind
  status: SourceLoadStatus
  /** Creation timestamp (seconds since epoch) when the wire exposed one. */
  createdAt?: number
}

/** NotebookLM `SourceStatus` codes at `entry[3][1]`. */
export const SOURCE_STATUS_BY_CODE: Readonly<Record<number, SourceLoadStatus>> = {
  1: 'processing',
  2: 'ready',
  3: 'error',
  5: 'preparing',
}

/** NotebookLM `SourceType` codes at `metadata[4]`. */
export const SOURCE_KIND_BY_CODE: Readonly<Record<number, SourceKind>> = {
  1: 'google_docs',
  2: 'google_other',
  3: 'pdf',
  4: 'pasted_text',
  5: 'web_page',
  8: 'generated_text',
  9: 'youtube',
}

export function sourceStatusFromCode(code: unknown): SourceLoadStatus {
  return typeof code === 'number' ? (SOURCE_STATUS_BY_CODE[code] ?? 'unknown') : 'unknown'
}

export function sourceKindFromCode(code: unknown): SourceKind {
  return typeof code === 'number' ? (SOURCE_KIND_BY_CODE[code] ?? 'unknown') : 'unknown'
}

/** A source NotebookLM reports as failed to load — the retry/diagnose target. */
export function isFailedSource(source: NotebookSource): boolean {
  return source.status === 'error'
}
