import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Result } from 'effect'
import { HttpStatusError, IpcError, NotLoggedIn, ProtocolDrift } from '../fx/errors'
import { debugLogTest, httpTest, type RecordedHttpRequest } from '../fx/testing'
import { buildRpcUrl, homeUrl, RPC_IDS } from '../ingest/rpc/protocol'
import { nblmSessionHtml, rpcResponse } from '../ingest/rpc/testing'
import {
  accountBindingFor,
  authenticateBoundAccount,
  notebookTargetFor,
  notebookTargetKey,
  sameAccountBinding,
  sameNotebookTarget,
  verifyNotebookTarget,
} from './ownership'

const SESSION_HTML = nblmSessionHtml({ email: 'f@example.com' })

function ownershipLayer(home = SESSION_HTML, requests: RecordedHttpRequest[] = []) {
  return Layer.mergeAll(httpTest({ [homeUrl(0)]: home }, requests), debugLogTest())
}

describe('NotebookLM account ownership', () => {
  it('derives immutable bindings from the active authenticated account', () => {
    const settings = {
      nblmAuthuser: 1,
      accounts: [
        { authuser: 0, email: 'zero@example.com' },
        { authuser: 1, email: 'one@example.com' },
      ],
      notebookTargets: {},
    }

    const binding = accountBindingFor(settings)
    const target = notebookTargetFor(settings, 'nb-1')

    assert.deepStrictEqual(binding, { authuser: 1, accountEmail: 'one@example.com' })
    assert.deepStrictEqual(target, {
      authuser: 1,
      accountEmail: 'one@example.com',
      notebookId: 'nb-1',
    })
    if (binding === undefined) throw new Error('Expected account binding')
    assert.isTrue(sameAccountBinding(binding, { authuser: 1, accountEmail: 'one@example.com' }))
    assert.isFalse(sameAccountBinding(binding, { authuser: 0, accountEmail: 'one@example.com' }))
    if (target === undefined) throw new Error('Expected notebook target')
    assert.isTrue(
      sameNotebookTarget(target, {
        authuser: 1,
        accountEmail: 'one@example.com',
        notebookId: 'nb-1',
      }),
    )
    assert.isFalse(
      sameNotebookTarget(target, {
        authuser: 1,
        accountEmail: 'one@example.com',
        notebookId: 'nb-2',
      }),
    )
  })

  it('uses a versioned, collision-safe key for the full notebook target', () => {
    const first = { authuser: 0, accountEmail: 'a:b@example.com', notebookId: 'c' }
    const second = { authuser: 0, accountEmail: 'a', notebookId: 'b@example.com:c' }

    assert.notStrictEqual(notebookTargetKey(first), notebookTargetKey(second))
    assert.isTrue(notebookTargetKey(first).startsWith('["notebook-target:v1",'))
  })

  it('accepts deeply readonly settings snapshots', () => {
    const settings = {
      nblmAuthuser: 0,
      accounts: [{ authuser: 0, email: 'f@example.com' }],
    } as const

    assert.deepStrictEqual(notebookTargetFor(settings, 'nb-1'), {
      authuser: 0,
      accountEmail: 'f@example.com',
      notebookId: 'nb-1',
    })
  })

  it('derives no binding without an observed email or concrete notebook', () => {
    const settings = { nblmAuthuser: 0, accounts: [], notebookTargets: {} }

    assert.isUndefined(accountBindingFor(settings))
    assert.isUndefined(notebookTargetFor(settings, 'nb-1'))
    assert.isUndefined(
      notebookTargetFor(
        {
          ...settings,
          accounts: [{ authuser: 0, email: 'f@example.com' }],
        },
        '',
      ),
    )
  })

  it('derives no binding from a blank observed email', () => {
    for (const email of ['', '   ']) {
      const settings = {
        nblmAuthuser: 0,
        accounts: [{ authuser: 0, email }],
      }

      assert.isUndefined(accountBindingFor(settings))
      assert.isUndefined(notebookTargetFor(settings, 'nb-1'))
    }
  })

  it.effect('authenticates an immutable account binding when the live email matches', () =>
    Effect.gen(function* () {
      const authentication = yield* authenticateBoundAccount({
        authuser: 0,
        accountEmail: 'f@example.com',
      })

      assert.strictEqual(authentication.status, 'authenticated')
      if (authentication.status === 'authenticated') {
        assert.strictEqual(authentication.account.authuser, 0)
        assert.strictEqual(authentication.account.email, 'f@example.com')
        assert.strictEqual(authentication.account.session.csrfToken, 'csrf-token-1')
      }
    }).pipe(Effect.provide(ownershipLayer())),
  )

  it.effect('reports a stored account binding that now names a different live email', () =>
    Effect.gen(function* () {
      const result = yield* authenticateBoundAccount({
        authuser: 0,
        accountEmail: 'old@example.com',
      })

      assert.deepStrictEqual(result, { status: 'account-changed' })
    }).pipe(
      Effect.provide(ownershipLayer('"SNlM0e":"csrf-token-1"...."oPEP7c":"new@example.com"')),
    ),
  )

  it.effect('reports a stored account binding whose live session omits its email', () =>
    Effect.gen(function* () {
      const result = yield* authenticateBoundAccount({
        authuser: 0,
        accountEmail: 'f@example.com',
      })

      assert.deepStrictEqual(result, { status: 'account-changed' })
    }).pipe(Effect.provide(ownershipLayer('"SNlM0e":"csrf-token-1"'))),
  )

  it.effect('keeps stored-binding transport failures in the error channel', () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        authenticateBoundAccount({ authuser: 0, accountEmail: 'f@example.com' }),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, HttpStatusError)
    }).pipe(Effect.provide(Layer.mergeAll(httpTest({}), debugLogTest()))),
  )

  it.effect('verifies an immutable notebook target through a fresh authenticated listing', () =>
    Effect.gen(function* () {
      const verified = yield* verifyNotebookTarget({
        notebookId: 'nb-1',
        authuser: 0,
        accountEmail: 'f@example.com',
      })

      assert.deepStrictEqual(verified.target, {
        notebookId: 'nb-1',
        authuser: 0,
        accountEmail: 'f@example.com',
      })
      assert.strictEqual(verified.account.email, 'f@example.com')
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          httpTest({
            [homeUrl(0)]: SESSION_HTML,
            [buildRpcUrl({
              rpcId: RPC_IDS.listNotebooks,
              authuser: 0,
              fSid: 'fsid-1',
              sourcePath: '/',
            })]: rpcResponse(RPC_IDS.listNotebooks, [[['Target', null, 'nb-1']]]),
          }),
          debugLogTest(),
        ),
      ),
    ),
  )

  it.effect('rejects a notebook absent from the bound account fresh listing', () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        verifyNotebookTarget({
          notebookId: 'missing',
          authuser: 0,
          accountEmail: 'f@example.com',
        }),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, IpcError)
        assert.strictEqual(result.failure.reason, 'Choose a notebook from the current account')
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          httpTest({
            [homeUrl(0)]: SESSION_HTML,
            [buildRpcUrl({
              rpcId: RPC_IDS.listNotebooks,
              authuser: 0,
              fSid: 'fsid-1',
              sourcePath: '/',
            })]: rpcResponse(RPC_IDS.listNotebooks, [[['Other', null, 'nb-other']]]),
          }),
          debugLogTest(),
        ),
      ),
    ),
  )

  it.effect('rejects a reassigned target before listing notebooks', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const result = yield* Effect.result(
        verifyNotebookTarget({
          notebookId: 'nb-1',
          authuser: 0,
          accountEmail: 'old@example.com',
        }).pipe(
          Effect.provide(
            ownershipLayer('"SNlM0e":"csrf-token-1"...."oPEP7c":"new@example.com"', requests),
          ),
        ),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, NotLoggedIn)
      assert.strictEqual(requests.length, 1)
    }),
  )

  it.effect('rejects a partial notebook listing as protocol drift', () => {
    const listUrl = buildRpcUrl({
      rpcId: RPC_IDS.listNotebooks,
      authuser: 0,
      fSid: 'fsid-1',
      sourcePath: '/',
    })
    return Effect.gen(function* () {
      const result = yield* Effect.result(
        verifyNotebookTarget({
          notebookId: 'nb-1',
          authuser: 0,
          accountEmail: 'f@example.com',
        }),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, ProtocolDrift)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          httpTest({
            [homeUrl(0)]: SESSION_HTML,
            [listUrl]: rpcResponse(RPC_IDS.listNotebooks, [
              [
                ['Target', null, 'nb-1'],
                ['Malformed', null, null],
              ],
            ]),
          }),
          debugLogTest(),
        ),
      ),
    )
  })
})
