import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { kvTest } from './fx/testing'
import {
  convexUrlFromSettings,
  DEFAULT_SETTINGS,
  decodeSettingsPatch,
  decodeStoredSettings,
  getSettings,
  notebookTargetPatch,
  resolveNotebookTarget,
  sanitizeConvexUrl,
  updateSettings,
} from './settings'

describe('settings', () => {
  it('strictly decodes complete settings patches into fresh values', () => {
    const input = {
      nblmAuthuser: 2,
      accounts: [{ authuser: 2, email: 'two@example.com' }],
      notebookTargets: { reddit: 'nb-reddit' },
      driveClientId: '',
    }

    const patch = decodeSettingsPatch(input)

    assert.deepStrictEqual(patch, input)
    assert.notStrictEqual(patch?.accounts, input.accounts)
    assert.notStrictEqual(patch?.notebookTargets, input.notebookTargets)
  })

  it('rejects malformed, unknown, and explicitly undefined patch fields', () => {
    assert.isUndefined(decodeSettingsPatch([]))
    assert.deepStrictEqual(decodeSettingsPatch({}), {})
    assert.isUndefined(decodeSettingsPatch({ unknown: true }))
    assert.isUndefined(decodeSettingsPatch({ nblmAuthuser: undefined }))
    assert.isUndefined(decodeSettingsPatch({ nblmAuthuser: -1 }))
    assert.isUndefined(decodeSettingsPatch({ accounts: [{ authuser: 0, email: '' }] }))
    assert.isUndefined(decodeSettingsPatch({ notebookTargets: { unknown: 'nb-1' } }))
    assert.isUndefined(decodeSettingsPatch({ notebookTargets: { reddit: '' } }))
    assert.isUndefined(decodeSettingsPatch({ driveClientId: undefined }))
  })

  it('recovers valid persisted settings siblings and drops malformed values', () => {
    const stored = decodeStoredSettings({
      nblmAuthuser: -1,
      accounts: [
        { authuser: 1, email: 'one@example.com' },
        { authuser: -1, email: 'bad@example.com' },
        { authuser: 2, email: '   ' },
        { authuser: 3, email: 'three@example.com', extra: true },
      ],
      notebookTargets: { reddit: 'nb-reddit', unknown: 'nb-unknown', youtube: '' },
      stickyRoutes: {
        'example.com': { notebookId: 'nb-web', authuser: 2, updatedAt: '2026-01-01T00:00:00.000Z' },
        reddit: { notebookId: '', authuser: 0, updatedAt: '2026-01-01T00:00:00.000Z' },
        youtube: { notebookId: 'nb-yt', authuser: -1, updatedAt: '2026-01-01T00:00:00.000Z' },
        hackernews: { notebookId: 'nb-hn', authuser: 0 },
      },
      driveClientId: 42,
      unknown: true,
    })

    assert.deepStrictEqual(stored, {
      nblmAuthuser: 0,
      accounts: [
        { authuser: 1, email: 'one@example.com' },
        { authuser: 3, email: 'three@example.com' },
      ],
      notebookTargets: { reddit: 'nb-reddit' },
      stickyRoutes: {
        'example.com': { notebookId: 'nb-web', authuser: 2, updatedAt: '2026-01-01T00:00:00.000Z' },
      },
      autoExportVault: false,
    })
  })

  it('creates fresh default collections and rejects inherited patches', () => {
    const first = decodeStoredSettings(undefined)
    const second = decodeStoredSettings(undefined)

    assert.notStrictEqual(first.accounts, second.accounts)
    assert.notStrictEqual(first.notebookTargets, second.notebookTargets)
    assert.isUndefined(decodeSettingsPatch(Object.create({ nblmAuthuser: 1 }) as unknown))
  })

  it.effect('getSettings returns defaults when nothing is stored', () =>
    Effect.gen(function* () {
      const settings = yield* getSettings()
      assert.deepStrictEqual(settings, DEFAULT_SETTINGS)
    }).pipe(Effect.provide(kvTest())),
  )

  it.effect('updateSettings merges the patch into current settings and persists it', () =>
    Effect.gen(function* () {
      const first = yield* updateSettings({ driveClientId: 'client-1' })
      assert.strictEqual(first.driveClientId, 'client-1')
      assert.strictEqual(first.nblmAuthuser, 0)

      const second = yield* updateSettings({ nblmAuthuser: 2 })
      assert.strictEqual(second.nblmAuthuser, 2)
      assert.strictEqual(second.driveClientId, 'client-1')

      const reread = yield* getSettings()
      assert.deepStrictEqual(reread, second)
    }).pipe(Effect.provide(kvTest())),
  )

  it('resolves only notebook IDs present in the freshly listed active account', () => {
    const targets = { youtube: 'old-account', reddit: 'nb-reddit' }
    const notebooks = [{ id: 'nb-default' }, { id: 'nb-reddit' }]

    assert.strictEqual(
      resolveNotebookTarget(notebooks, [{ site: 'youtube' }, { site: 'reddit' }], targets),
      'nb-default',
    )
    assert.strictEqual(
      resolveNotebookTarget(notebooks, [{ site: 'youtube' }], targets, 'old-account'),
      'nb-default',
    )
    assert.strictEqual(
      resolveNotebookTarget(notebooks, [{ site: 'youtube' }], targets, 'nb-reddit'),
      'nb-reddit',
    )
    assert.strictEqual(
      resolveNotebookTarget(notebooks, [{ site: 'reddit' }, { site: 'hackernews' }], {
        reddit: 'nb-reddit',
        hackernews: 'nb-reddit',
      }),
      'nb-reddit',
    )
  })

  it('records successful targets without replacing targets for other sites', () => {
    assert.deepStrictEqual(
      notebookTargetPatch({ youtube: 'nb-youtube', x: 'nb-x' }, ['reddit', 'hackernews'], 'nb-a'),
      {
        youtube: 'nb-youtube',
        x: 'nb-x',
        reddit: 'nb-a',
        hackernews: 'nb-a',
      },
    )
  })

  it.effect('validates convexUrl on write: normalizes valid, clears empty or invalid', () =>
    Effect.gen(function* () {
      const set = yield* updateSettings({ convexUrl: ' https://demo.convex.cloud/ ' })
      assert.strictEqual(set.convexUrl, 'https://demo.convex.cloud')

      const invalid = yield* updateSettings({ convexUrl: 'http://not-https.example' })
      assert.isFalse('convexUrl' in invalid)

      const restored = yield* updateSettings({ convexUrl: 'https://demo.convex.cloud' })
      assert.strictEqual(restored.convexUrl, 'https://demo.convex.cloud')

      const cleared = yield* updateSettings({ convexUrl: '' })
      assert.isFalse('convexUrl' in cleared)
    }).pipe(Effect.provide(kvTest())),
  )

  it('reads the convex URL only through the sanitizing read path', () => {
    assert.strictEqual(
      convexUrlFromSettings({ ...DEFAULT_SETTINGS, convexUrl: 'https://demo.convex.cloud/' }),
      'https://demo.convex.cloud',
    )
    assert.strictEqual(convexUrlFromSettings(DEFAULT_SETTINGS), undefined)
    assert.strictEqual(convexUrlFromSettings({ ...DEFAULT_SETTINGS, convexUrl: 'junk' }), undefined)
    assert.strictEqual(sanitizeConvexUrl('   '), undefined)
  })
})
