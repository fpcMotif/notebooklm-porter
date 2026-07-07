import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Result } from 'effect'
import { HttpStatusError } from '../fx/errors'
import type { HttpInit } from '../fx/services'
import { DebugLog, Http, Identity, Kv } from '../fx/services'
import { backupDocsToDrive } from './client'
import type { SourceDoc } from '../model/types'

const NoopDebugLog = Layer.succeed(
  DebugLog,
  DebugLog.of({
    log: () => Effect.void,
  }),
)

const AuthOk = Layer.succeed(
  Identity,
  Identity.of({
    redirectUrl: () => 'https://abc.chromiumapp.org/',
    launchAuthFlow: () =>
      Effect.succeed('https://abc.chromiumapp.org/#access_token=token-1&expires_in=3599'),
  }),
)

function makeDoc(overrides: Partial<SourceDoc> & Pick<SourceDoc, 'id'>): SourceDoc {
  return {
    site: 'reddit',
    kind: 'thread',
    title: 'Some Title',
    canonicalUrl: 'https://example.com',
    capturedAt: '2026-01-01T00:00:00.000Z',
    markdown: '# doc',
    wordCount: 1,
    truncated: false,
    ...overrides,
  }
}

function makeKvLayer(docs: SourceDoc[], driveClientId?: string) {
  return Layer.succeed(
    Kv,
    Kv.of({
      get: <T>(key: string) =>
        Effect.succeed(
          (key === 'porter/docs'
            ? docs
            : key === 'porter/settings'
              ? { driveClientId }
              : undefined) as T | undefined,
        ),
      set: () => Effect.void,
    }),
  )
}

/** Drive's `files.list` query is a `q=` param; folder queries filter on `mimeType`. */
function isFolderQuery(url: string): boolean {
  return decodeURIComponent(url).includes('mimeType')
}

interface HttpFixture {
  /** Existing folder id, or undefined to force a create. */
  folderId?: string
  /** Existing file id by (decoded) name, for the update-in-place path. */
  fileIdByName?: Record<string, string>
  /** Names whose create/update PATCH/POST should fail (simulating a per-doc error). */
  failNames?: string[]
}

function makeHttpLayer(fixture: HttpFixture) {
  return Layer.succeed(
    Http,
    Http.of({
      text: (url: string, init?: HttpInit) =>
        Effect.gen(function* () {
          const method = init?.method ?? 'GET'
          const decoded = decodeURIComponent(url)

          if (method === 'GET' && isFolderQuery(url)) {
            const files =
              fixture.folderId !== undefined
                ? [{ id: fixture.folderId, name: 'NotebookLM Porter' }]
                : []
            return JSON.stringify({ files })
          }

          if (method === 'GET') {
            const match = Object.entries(fixture.fileIdByName ?? {}).find(([name]) =>
              decoded.includes(name),
            )
            return JSON.stringify({ files: match ? [{ id: match[1], name: match[0] }] : [] })
          }

          const body = init?.body ?? ''
          const shouldFail = (fixture.failNames ?? []).some((name) => body.includes(name))
          if (shouldFail) {
            return yield* Effect.fail(new HttpStatusError({ url, status: 500 }))
          }

          if (method === 'POST' && !decoded.includes('uploadType')) {
            return JSON.stringify({ id: 'new-folder-id' })
          }
          return JSON.stringify({ id: 'new-file-id' })
        }),
      json: () => Effect.die('unused in backup tests'),
    }),
  )
}

describe('backupDocsToDrive', () => {
  it.effect('fails with DriveAuthError when no client id is configured', () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(backupDocsToDrive(['a']))
      assert.isTrue(Result.isFailure(result))
    }).pipe(
      Effect.provide(makeKvLayer([], undefined)),
      Effect.provide(AuthOk),
      Effect.provide(makeHttpLayer({})),
      Effect.provide(NoopDebugLog),
    ),
  )

  it.effect('reports "Doc not found" for an unknown docId without aborting the batch', () =>
    Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive(['unknown', 'known'])
      assert.deepStrictEqual(outcomes[0], { docId: 'unknown', ok: false, error: 'Doc not found' })
      assert.strictEqual(outcomes[1]?.docId, 'known')
      assert.strictEqual(outcomes[1]?.ok, true)
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: 'known' })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(makeHttpLayer({})),
      Effect.provide(NoopDebugLog),
    ),
  )

  it.effect('creates the folder and file when neither exists yet', () =>
    Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive(['a'])
      assert.deepStrictEqual(outcomes, [{ docId: 'a', ok: true }])
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: 'a', title: 'Fresh Doc' })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(makeHttpLayer({})),
      Effect.provide(NoopDebugLog),
    ),
  )

  it.effect('updates the file in place when one with the same name already exists', () =>
    Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive(['a'])
      assert.deepStrictEqual(outcomes, [{ docId: 'a', ok: true }])
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: 'a', title: 'Existing Doc' })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(
        makeHttpLayer({
          folderId: 'folder-1',
          fileIdByName: { 'Existing Doc.md': 'file-1' },
        }),
      ),
      Effect.provide(NoopDebugLog),
    ),
  )

  it.effect('isolates a per-doc failure: one bad upload does not abort the rest', () =>
    Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive(['ok', 'bad'])
      assert.strictEqual(outcomes[0]?.docId, 'ok')
      assert.strictEqual(outcomes[0]?.ok, true)
      assert.strictEqual(outcomes[1]?.docId, 'bad')
      assert.strictEqual(outcomes[1]?.ok, false)
    }).pipe(
      Effect.provide(
        makeKvLayer(
          [makeDoc({ id: 'ok', title: 'Good Doc' }), makeDoc({ id: 'bad', title: 'Bad Doc' })],
          'client-1',
        ),
      ),
      Effect.provide(AuthOk),
      Effect.provide(makeHttpLayer({ failNames: ['Bad Doc'] })),
      Effect.provide(NoopDebugLog),
    ),
  )
})
