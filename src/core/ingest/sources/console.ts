/**
 * Composes a full source-console view from a notebook's source list: the raw
 * sources, their duplicate groups, and diagnoses for the failed ones. Pure so
 * the router handler stays a thin RPC-list → scan → reply shell, and the whole
 * analysis is unit-testable without the wire.
 */
import { duplicateRemovalIds, findDuplicateGroups, type DuplicateGroup } from './dedup'
import { diagnoseFailedSources, type SourceDiagnosis } from './diagnose'
import type { NotebookSource } from './model'

export interface ConsoleScan {
  sources: NotebookSource[]
  duplicateGroups: DuplicateGroup[]
  failed: SourceDiagnosis[]
  /** Total redundant copies across all groups — the count the console would remove. */
  duplicateCount: number
}

export function scanSources(sources: NotebookSource[]): ConsoleScan {
  const duplicateGroups = findDuplicateGroups(sources)
  return {
    sources,
    duplicateGroups,
    failed: diagnoseFailedSources(sources),
    duplicateCount: duplicateRemovalIds(duplicateGroups).length,
  }
}
