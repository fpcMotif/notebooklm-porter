import { afterEach, describe, expect, it } from 'vitest'
import { activeDomSelectorProfile, hasVerifiedDomDriver } from './dom/selectors'
import {
  applyRemoteProfile,
  compareVersions,
  decideProfileSource,
  effectiveRpcId,
  isRemoteProfile,
  isVersionCompatible,
  REMOTE_PROFILE_SCHEMA_VERSION,
  remoteProfileFromCache,
  type RemoteProfile,
} from './remote-profile'
import { RPC_IDS } from './rpc/protocol'

const selectors = {
  id: 'nblm-2026-07',
  addSourceTriggers: ['button.add-source'],
  copiedTextChoices: ['[data-choice="copied-text"]'],
  titleInputs: ['input[name="title"]'],
  textInputs: ['textarea'],
  submitButtons: ['button[type="submit"]'],
  sourceListSignals: ['.source-list'],
}

const validProfile: RemoteProfile = {
  schemaVersion: REMOTE_PROFILE_SCHEMA_VERSION,
  publishedAt: '2026-07-19T00:00:00.000Z',
  minExtensionVersion: '0.1.0',
  selectors,
  rpcOverrides: { addSource: 'zzNewId' },
}

afterEach(() => {
  applyRemoteProfile(undefined)
})

describe('isRemoteProfile', () => {
  it('accepts a full profile and a minimal one without payloads', () => {
    expect(isRemoteProfile(validProfile)).toBe(true)
    expect(
      isRemoteProfile({
        schemaVersion: 1,
        publishedAt: '2026-07-19T00:00:00.000Z',
        minExtensionVersion: '0.1',
      }),
    ).toBe(true)
  })

  it('tolerates rpc override keys this build does not know', () => {
    expect(isRemoteProfile({ ...validProfile, rpcOverrides: { futureRpc: 'abc123' } })).toBe(true)
  })

  it('rejects structural corruption', () => {
    expect(isRemoteProfile(null)).toBe(false)
    expect(isRemoteProfile([])).toBe(false)
    expect(isRemoteProfile({ ...validProfile, schemaVersion: '1' })).toBe(false)
    expect(isRemoteProfile({ ...validProfile, publishedAt: 'not-a-date' })).toBe(false)
    expect(isRemoteProfile({ ...validProfile, minExtensionVersion: 'abc' })).toBe(false)
    expect(
      isRemoteProfile({ ...validProfile, selectors: { ...selectors, titleInputs: 'x' } }),
    ).toBe(false)
    expect(
      isRemoteProfile({ ...validProfile, selectors: { ...selectors, submitButtons: [''] } }),
    ).toBe(false)
    expect(isRemoteProfile({ ...validProfile, selectors: { ...selectors, id: '' } })).toBe(false)
    expect(isRemoteProfile({ ...validProfile, rpcOverrides: { addSource: '' } })).toBe(false)
    expect(isRemoteProfile({ ...validProfile, rpcOverrides: { addSource: 7 } })).toBe(false)
  })
})

describe('version compatibility', () => {
  it('compares dotted versions numerically with implicit zeros', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.2', '0.2.0')).toBe(0)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '2')).toBe(-1)
  })

  it('requires the exact schema version and an extension at/above the floor', () => {
    expect(isVersionCompatible(validProfile, '0.1.0')).toBe(true)
    expect(isVersionCompatible(validProfile, '0.2.0')).toBe(true)
    expect(isVersionCompatible(validProfile, '0.0.9')).toBe(false)
    expect(isVersionCompatible({ ...validProfile, schemaVersion: 2 }, '0.1.0')).toBe(false)
  })
})

describe('decideProfileSource', () => {
  it('rules remote only for a valid, compatible profile', () => {
    expect(decideProfileSource(validProfile, '0.1.0')).toEqual({
      source: 'remote',
      profile: validProfile,
    })
  })

  it('falls back to bundled for absent, invalid, and incompatible remotes', () => {
    expect(decideProfileSource(null, '0.1.0')).toEqual({ source: 'bundled', reason: 'absent' })
    expect(decideProfileSource(undefined, '0.1.0')).toEqual({ source: 'bundled', reason: 'absent' })
    expect(decideProfileSource({ garbage: true }, '0.1.0')).toEqual({
      source: 'bundled',
      reason: 'invalid',
    })
    expect(decideProfileSource({ ...validProfile, minExtensionVersion: '9.0.0' }, '0.1.0')).toEqual(
      { source: 'bundled', reason: 'incompatible' },
    )
  })
})

describe('remoteProfileFromCache', () => {
  it('unwraps a valid cache entry and rejects everything else', () => {
    const cached = { profile: validProfile, fetchedAt: '2026-07-19T01:00:00.000Z' }
    expect(remoteProfileFromCache(cached, '0.1.0')).toEqual(validProfile)
    expect(remoteProfileFromCache(null, '0.1.0')).toBeUndefined()
    expect(remoteProfileFromCache({ fetchedAt: 'x' }, '0.1.0')).toBeUndefined()
    expect(
      remoteProfileFromCache({ profile: { corrupt: true }, fetchedAt: 'x' }, '0.1.0'),
    ).toBeUndefined()
    expect(remoteProfileFromCache(cached, '0.0.1')).toBeUndefined()
  })
})

describe('applied-profile lookup points', () => {
  it('effectiveRpcId prefers a remote override and falls back to the bundled id', () => {
    expect(effectiveRpcId('addSource')).toBe(RPC_IDS.addSource)
    applyRemoteProfile(validProfile)
    expect(effectiveRpcId('addSource')).toBe('zzNewId')
    expect(effectiveRpcId('listNotebooks')).toBe(RPC_IDS.listNotebooks)
    applyRemoteProfile(undefined)
    expect(effectiveRpcId('addSource')).toBe(RPC_IDS.addSource)
  })

  it('activeDomSelectorProfile serves remote selectors and gates the Tier-B driver', () => {
    expect(activeDomSelectorProfile()).toBeUndefined()
    expect(hasVerifiedDomDriver()).toBe(false)
    applyRemoteProfile(validProfile)
    expect(activeDomSelectorProfile()).toEqual(selectors)
    expect(hasVerifiedDomDriver()).toBe(true)
    const { selectors: _selectors, ...withoutSelectors } = validProfile
    applyRemoteProfile(withoutSelectors)
    expect(activeDomSelectorProfile()).toBeUndefined()
  })
})
