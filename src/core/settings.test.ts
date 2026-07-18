import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { kvTest } from './fx/testing'
import {
  DEFAULT_SETTINGS,
  getSettings,
  notebookTargetPatch,
  resolveNotebookTarget,
  updateSettings,
} from './settings'

describe('settings', () => {
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
})
