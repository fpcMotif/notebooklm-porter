import type { NblmAccount } from './accounts/parse'

const KEY = 'porter/settings'

/**
 * Cross-cutting extension settings: discovered NotebookLM Google accounts
 * to target for ingest.
 */
export interface PorterSettings {
  nblmAuthuser: number
  accounts: NblmAccount[]
}

export const DEFAULT_SETTINGS: PorterSettings = {
  nblmAuthuser: 0,
  accounts: [],
}

export async function getSettings(): Promise<PorterSettings> {
  const got = await browser.storage.local.get(KEY)
  const stored = got[KEY] as Partial<PorterSettings> | undefined
  return { ...DEFAULT_SETTINGS, ...stored }
}

export async function updateSettings(patch: Partial<PorterSettings>): Promise<PorterSettings> {
  const current = await getSettings()
  const next: PorterSettings = { ...current, ...patch }
  await browser.storage.local.set({ [KEY]: next })
  return next
}
