/**
 * The sole registry for verified NotebookLM DOM selectors. It is intentionally
 * empty until an authenticated disposable notebook supplies live evidence.
 */
import { activeRemoteSelectorProfile } from '../remote-profile'

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

/**
 * A valid, version-compatible remote profile (Convex-published, applied by
 * remote-profile-loader.ts) wins over the bundled registry; with none applied
 * this is exactly the bundled lookup.
 */
export function activeDomSelectorProfile(): DomSelectorProfile | undefined {
  return activeRemoteSelectorProfile() ?? verifiedDomSelectorProfiles[0]
}

/**
 * Tier B may only be *attempted* where a live-verified DOM driver profile
 * exists. While the registry is empty this is `false`, so the queue never
 * routes a job into a fallback that cannot succeed.
 */
export function hasVerifiedDomDriver(): boolean {
  return activeDomSelectorProfile() !== undefined
}
