/**
 * Sync ledger (design §9): per-notebook record of which external items are
 * already synced, keyed by `SourceDoc.id` ("<site>:<nativeId>"). Enables
 * idempotent re-import (skip what's already there), staleness diffing
 * (detect a thread whose content changed since last sync), and cross-import
 * dedup (a video reachable via two different captures syncs once).
 *
 * Reducers below are pure — no storage access — so the classification and
 * update logic is fully unit-testable without mocking `browser.storage`.
 */

export interface LedgerEntry {
  contentHash: string
  lastSynced: string
}

export type Ledger = Record<string, Record<string, LedgerEntry>>

export interface LedgerDoc {
  id: string
  contentHash: string
}

export interface DiffResult {
  /** Not present in the ledger for this notebook at all. */
  fresh: string[]
  /** Present, but the stored contentHash differs — stale, needs re-sync. */
  changed: string[]
  /** Present with a matching contentHash — already synced, skip. */
  unchanged: string[]
}

/**
 * Classifies each doc against what's already recorded for `notebookId`.
 * Order of the input `docs` is preserved within each bucket.
 */
export function diffAgainstLedger(
  ledger: Ledger,
  notebookId: string,
  docs: LedgerDoc[],
): DiffResult {
  const notebook = ledger[notebookId]
  const fresh: string[] = []
  const changed: string[] = []
  const unchanged: string[] = []

  for (const doc of docs) {
    const entry = notebook?.[doc.id]
    if (!entry) {
      fresh.push(doc.id)
    } else if (entry.contentHash !== doc.contentHash) {
      changed.push(doc.id)
    } else {
      unchanged.push(doc.id)
    }
  }

  return { fresh, changed, unchanged }
}

export interface SyncedEntry {
  id: string
  contentHash: string
  now: string
}

/**
 * Returns a NEW ledger with `entries` upserted under `notebookId`. Never
 * mutates the input ledger (or its nested notebook record) — callers may
 * hold onto the old reference (e.g. for a diff-before/after comparison).
 */
export function recordSynced(ledger: Ledger, notebookId: string, entries: SyncedEntry[]): Ledger {
  const existingNotebook = ledger[notebookId] ?? {}
  const nextNotebook = { ...existingNotebook }

  for (const entry of entries) {
    nextNotebook[entry.id] = { contentHash: entry.contentHash, lastSynced: entry.now }
  }

  return { ...ledger, [notebookId]: nextNotebook }
}

/**
 * Deterministic, non-cryptographic hash (FNV-1a, 32-bit) rendered as an
 * 8-char hex string. Used only for change detection, never for security —
 * collisions are acceptable at this scale but should be vanishingly rare
 * for the thread/playlist-length markdown bodies this hashes.
 */
export function contentHash(markdown: string): string {
  let hash = 0x811c9dc5

  for (let i = 0; i < markdown.length; i++) {
    hash ^= markdown.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

const STORAGE_KEY = 'porter/ledger'

/** Thin storage.local wrapper — logic lives in the pure reducers above. */
export async function loadLedger(): Promise<Ledger> {
  const got = await browser.storage.local.get(STORAGE_KEY)
  return (got[STORAGE_KEY] ?? {}) as Ledger
}

export async function saveLedger(ledger: Ledger): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEY]: ledger })
}
