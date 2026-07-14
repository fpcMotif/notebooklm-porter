/**
 * The sole registry for verified NotebookLM DOM selectors. It is intentionally
 * empty until an authenticated disposable notebook supplies live evidence.
 */
export interface DomSelectorProfile {
  id: string
  addSourceTriggers: readonly string[]
  copiedTextChoices: readonly string[]
  titleInputs: readonly string[]
  textInputs: readonly string[]
  submitButtons: readonly string[]
  sourceListSignals: readonly string[]
}

export const verifiedDomSelectorProfiles: readonly DomSelectorProfile[] = []

export function activeDomSelectorProfile(): DomSelectorProfile | undefined {
  return verifiedDomSelectorProfiles[0]
}

/**
 * Tier B may only be *attempted* where a live-verified DOM driver profile
 * exists. While the registry is empty this is `false`, so the queue never
 * routes a job into a fallback that cannot succeed.
 */
export function hasVerifiedDomDriver(): boolean {
  return activeDomSelectorProfile() !== undefined
}
