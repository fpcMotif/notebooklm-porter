import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Result } from 'effect'
import { DriveApiError, DriveAuthError, HttpStatusError } from '../fx/errors'
import type { HttpInit } from '../fx/services'
import { Http, Identity } from '../fx/services'
import { debugLogTest, identityTest, kvTest } from '../fx/testing'
import { DRIVE_TOKEN_CACHE_KEY, backupDocsToDrive } from './client'
import type { CachedToken } from './token-cache'
import type { SourceDoc, ThreadSourceDoc } from '../model/types'

const NoopDebugLog = debugLogTest()

const AuthOk = identityTest('https://abc.chromiumapp.org/#access_token=token-1&expires_in=3599')
const sourceId = (nativeId: string) => `reddit:${nativeId}`

function noAuthLayer(calls: { count: number }) {
  return Layer.succeed(
    Identity,
    Identity.of({
      redirectUrl: () => {
        calls.count += 1
        return 'https://test.chromiumapp.org/'
      },
      launchAuthFlow: () =>
        Effect.sync(() => {
          calls.count += 1
          return 'https://test.chromiumapp.org/#access_token=unused&expires_in=3599'
        }),
    }),
  )
}

function makeDoc(
  overrides: Partial<ThreadSourceDoc> & Pick<ThreadSourceDoc, 'id'>,
): ThreadSourceDoc {
  return {
    site: 'reddit',
    kind: 'thread',
    title: 'Some Title',
    canonicalUrl: 'https://www.reddit.com/r/porter/comments/test/',
    capturedAt: '2026-01-01T00:00:00.000Z',
    markdown: '# doc',
    wordCount: 1,
    truncated: false,
    ...overrides,
  }
}

function makeKvLayer(docs: SourceDoc[], driveClientId?: string) {
  return kvTest({
    'porter/docs': docs,
    'porter/settings': { driveClientId },
  })
}

/** Drive's `files.list` query is a `q=` param; folder queries filter on `mimeType`. */
function isFolderQuery(url: string): boolean {
  return decodeURIComponent(url).includes("mimeType='application/vnd.google-apps.folder'")
}

function listResponse(
  files: { id: string; name: string; mimeType?: string; appProperties?: Record<string, string> }[],
  extra: { nextPageToken?: string; incompleteSearch?: boolean } = {},
): string {
  return JSON.stringify({
    files: files.map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType ?? 'text/markdown',
      appProperties: file.appProperties ?? {},
    })),
    incompleteSearch: extra.incompleteSearch ?? false,
    ...(extra.nextPageToken !== undefined ? { nextPageToken: extra.nextPageToken } : {}),
  })
}

interface HttpFixture {
  /** Existing folder id, or undefined to force a create. */
  folderId?: string
  /** Names whose create/update PATCH/POST should fail (simulating a per-doc error). */
  failNames?: string[]
  managedFiles?: {
    id: string
    name: string
    mimeType?: string
    appProperties?: Record<string, string>
  }[]
  legacyFilesByName?: Record<
    string,
    { id: string; name: string; mimeType?: string; appProperties?: Record<string, string> }[]
  >
  legacyContentById?: Record<string, string>
  failUrlContains?: string
  failMethod?: string
  requests?: { url: string; method: string; body: string }[]
  /** Sink for each request's bearer token — lets a test assert which token was used. */
  authLog?: string[]
}

function makeHttpLayer(fixture: HttpFixture) {
  return Layer.succeed(
    Http,
    Http.of({
      text: (url: string, init?: HttpInit) =>
        Effect.gen(function* () {
          const method = init?.method ?? 'GET'
          const decoded = decodeURIComponent(url)
          const body = init?.body ?? ''
          fixture.requests?.push({ url: decoded, method, body })
          const auth = init?.headers?.Authorization ?? ''
          fixture.authLog?.push(auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : auth)

          if (method === 'GET' && isFolderQuery(url)) {
            const files =
              fixture.folderId !== undefined
                ? [{ id: fixture.folderId, name: 'NotebookLM Porter' }]
                : []
            return listResponse(
              files.map((file) => ({
                id: file.id,
                name: file.name,
                mimeType: 'application/vnd.google-apps.folder',
                appProperties: { notebookLmPorterArtifact: 'backup-folder:v1' },
              })),
            )
          }

          if (method === 'GET') {
            if (decoded.includes("value='source:v1:")) {
              return listResponse(fixture.managedFiles ?? [])
            }
            const downloadId = Object.keys(fixture.legacyContentById ?? {}).find((id) =>
              decoded.includes(`/files/${id}?alt=media`),
            )
            if (downloadId !== undefined) {
              return fixture.legacyContentById?.[downloadId] ?? ''
            }
            const legacyMatch = Object.entries(fixture.legacyFilesByName ?? {}).find(([name]) =>
              decoded.includes(name),
            )
            if (legacyMatch !== undefined) {
              return listResponse(legacyMatch[1])
            }
            return listResponse([])
          }

          if (
            fixture.failUrlContains !== undefined &&
            decoded.includes(fixture.failUrlContains) &&
            (fixture.failMethod === undefined || fixture.failMethod === method)
          ) {
            return yield* Effect.fail(new HttpStatusError({ url, status: 500 }))
          }
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

interface HttpRequest {
  url: string
  method: string
  body: string
}

function makeScriptedHttpLayer(
  handler: (request: HttpRequest) => Effect.Effect<string, HttpStatusError>,
) {
  return Layer.succeed(
    Http,
    Http.of({
      text: (url, init) =>
        handler({
          url: decodeURIComponent(url),
          method: init?.method ?? 'GET',
          body: init?.body ?? '',
        }),
      json: () => Effect.die('unused in backup tests'),
    }),
  )
}

function isManagedFolderQuery(url: string): boolean {
  return new URL(url).searchParams.get('q')?.includes("value='backup-folder:v1'") ?? false
}

function isManagedFileQuery(url: string): boolean {
  return new URL(url).searchParams.get('q')?.includes("value='source:v1:") ?? false
}

describe('backupDocsToDrive', () => {
  it.effect('fails with DriveAuthError when no client id is configured', () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(backupDocsToDrive([sourceId('a')]))
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, DriveAuthError)
        assert.strictEqual(result.failure.reason, 'missing-client-id')
      }
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a') })], undefined)),
      Effect.provide(AuthOk),
      Effect.provide(makeHttpLayer({})),
      Effect.provide(NoopDebugLog),
    ),
  )

  it.effect('keeps OAuth cancellation as DriveAuthError', () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(backupDocsToDrive([sourceId('a')]))
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, DriveAuthError)
        assert.strictEqual(result.failure.reason, 'cancelled')
      }
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a') })], 'client-1')),
      Effect.provide(identityTest()),
      Effect.provide(makeHttpLayer({})),
      Effect.provide(NoopDebugLog),
    ),
  )

  it.effect('preserves folder API failures without mutating documents', () => {
    const requests: HttpRequest[] = []
    return Effect.gen(function* () {
      const result = yield* Effect.result(backupDocsToDrive([sourceId('a')]))
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, DriveApiError)
        assert.strictEqual(result.failure.step, 'find-managed-folder')
        assert.strictEqual(result.failure.status, 503)
      }
      assert.isFalse(requests.some((request) => request.method !== 'GET'))
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a') })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(
        makeScriptedHttpLayer((request) => {
          requests.push(request)
          return isManagedFolderQuery(request.url)
            ? Effect.fail(new HttpStatusError({ url: request.url, status: 503 }))
            : Effect.succeed(listResponse([]))
        }),
      ),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('reports "Doc not found" for an unknown docId without aborting the batch', () =>
    Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('unknown'), sourceId('known')])
      assert.deepStrictEqual(outcomes[0], {
        docId: sourceId('unknown'),
        ok: false,
        error: 'Doc not found',
      })
      assert.strictEqual(outcomes[1]?.docId, sourceId('known'))
      assert.strictEqual(outcomes[1]?.ok, true)
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('known') })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(makeHttpLayer({})),
      Effect.provide(NoopDebugLog),
    ),
  )

  it.effect('returns stale-only selections without OAuth, HTTP, or Drive mutation', () => {
    const requests: HttpRequest[] = []
    const authCalls = { count: 0 }
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('stale-a'), sourceId('stale-b')])
      assert.deepStrictEqual(outcomes, [
        { docId: sourceId('stale-a'), ok: false, error: 'Doc not found' },
        { docId: sourceId('stale-b'), ok: false, error: 'Doc not found' },
      ])
      assert.strictEqual(authCalls.count, 0)
      assert.deepStrictEqual(requests, [])
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('known') })], undefined)),
      Effect.provide(noAuthLayer(authCalls)),
      Effect.provide(makeHttpLayer({ requests })),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('returns an empty selection without OAuth, HTTP, or Drive mutation', () => {
    const requests: HttpRequest[] = []
    const authCalls = { count: 0 }
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([])
      assert.deepStrictEqual(outcomes, [])
      assert.strictEqual(authCalls.count, 0)
      assert.deepStrictEqual(requests, [])
    }).pipe(
      Effect.provide(makeKvLayer([], undefined)),
      Effect.provide(noAuthLayer(authCalls)),
      Effect.provide(makeHttpLayer({ requests })),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('creates the folder and file when neither exists yet', () =>
    Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [{ docId: sourceId('a'), ok: true }])
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a'), title: 'Fresh Doc' })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(makeHttpLayer({})),
      Effect.provide(NoopDebugLog),
    ),
  )

  it.effect('updates one managed Drive id and never posts a second file', () => {
    const requests: { url: string; method: string; body: string }[] = []
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [{ docId: sourceId('a'), ok: true }])
      assert.isTrue(
        requests.some((request) => request.method === 'PATCH' && request.url.includes('file-1')),
      )
      assert.isFalse(
        requests.some(
          (request) => request.method === 'POST' && request.url.includes('uploadType=multipart'),
        ),
      )
    }).pipe(
      Effect.provide(
        makeKvLayer([makeDoc({ id: sourceId('a'), title: 'Existing Doc' })], 'client-1'),
      ),
      Effect.provide(AuthOk),
      Effect.provide(
        makeHttpLayer({
          folderId: 'folder-1',
          managedFiles: [{ id: 'file-1', name: 'Existing Doc--digest.md' }],
          requests,
        }),
      ),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('isolates a per-doc failure: one bad upload does not abort the rest', () =>
    Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('ok'), sourceId('bad')])
      assert.strictEqual(outcomes[0]?.docId, sourceId('ok'))
      assert.strictEqual(outcomes[0]?.ok, true)
      assert.strictEqual(outcomes[1]?.docId, sourceId('bad'))
      assert.strictEqual(outcomes[1]?.ok, false)
    }).pipe(
      Effect.provide(
        makeKvLayer(
          [
            makeDoc({ id: sourceId('ok'), title: 'Good Doc' }),
            makeDoc({ id: sourceId('bad'), title: 'Bad Doc' }),
          ],
          'client-1',
        ),
      ),
      Effect.provide(AuthOk),
      Effect.provide(makeHttpLayer({ failNames: ['Bad Doc'] })),
      Effect.provide(NoopDebugLog),
    ),
  )

  it.effect('creates distinct managed artifacts for docs with the same title', () => {
    const requests: { url: string; method: string; body: string }[] = []
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a'), sourceId('b')])
      assert.deepStrictEqual(outcomes, [
        { docId: sourceId('a'), ok: true },
        { docId: sourceId('b'), ok: true },
      ])
      const uploads = requests.filter(
        (request) => request.method === 'POST' && request.url.includes('uploadType=multipart'),
      )
      assert.strictEqual(uploads.length, 2)
      assert.notStrictEqual(
        uploads[0]?.body.match(/source:v1:[^"}]+/)?.[0],
        uploads[1]?.body.match(/source:v1:[^"}]+/)?.[0],
      )
    }).pipe(
      Effect.provide(
        makeKvLayer(
          [
            makeDoc({ id: sourceId('a'), title: 'Same' }),
            makeDoc({ id: sourceId('b'), title: 'Same' }),
          ],
          'client-1',
        ),
      ),
      Effect.provide(AuthOk),
      Effect.provide(makeHttpLayer({ folderId: 'folder-1', requests })),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('updates the managed Drive id and renames when the title changes', () => {
    const requests: { url: string; method: string; body: string }[] = []
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [{ docId: sourceId('a'), ok: true }])
      const update = requests.find(
        (request) => request.method === 'PATCH' && request.url.includes('file-1'),
      )
      assert.isDefined(update)
      assert.include(update?.body ?? '', 'Renamed--')
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a'), title: 'Renamed' })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(
        makeHttpLayer({
          folderId: 'folder-1',
          managedFiles: [{ id: 'file-1', name: 'Old--digest.md' }],
          requests,
        }),
      ),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('adopts exactly one byte-identical legacy file without creating another', () => {
    const requests: { url: string; method: string; body: string }[] = []
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [{ docId: sourceId('a'), ok: true }])
      assert.isTrue(
        requests.some((request) => request.method === 'PATCH' && request.url.includes('legacy-1')),
      )
      assert.isFalse(
        requests.some(
          (request) => request.method === 'POST' && request.url.includes('uploadType=multipart'),
        ),
      )
    }).pipe(
      Effect.provide(
        makeKvLayer(
          [makeDoc({ id: sourceId('a'), title: 'Legacy', markdown: '# doc' })],
          'client-1',
        ),
      ),
      Effect.provide(AuthOk),
      Effect.provide(
        makeHttpLayer({
          folderId: 'folder-1',
          legacyFilesByName: { 'Legacy.md': [{ id: 'legacy-1', name: 'Legacy.md' }] },
          legacyContentById: { 'legacy-1': '# doc' },
          requests,
        }),
      ),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('leaves mismatched legacy bytes untouched and creates a managed artifact', () => {
    const requests: { url: string; method: string; body: string }[] = []
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [{ docId: sourceId('a'), ok: true }])
      assert.isFalse(
        requests.some((request) => request.method === 'PATCH' && request.url.includes('legacy-1')),
      )
      assert.isTrue(
        requests.some(
          (request) => request.method === 'POST' && request.url.includes('uploadType=multipart'),
        ),
      )
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a'), title: 'Legacy' })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(
        makeHttpLayer({
          folderId: 'folder-1',
          legacyFilesByName: { 'Legacy.md': [{ id: 'legacy-1', name: 'Legacy.md' }] },
          legacyContentById: { 'legacy-1': 'old bytes' },
          requests,
        }),
      ),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('fails ambiguous managed matches without a mutation', () => {
    const requests: { url: string; method: string; body: string }[] = []
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.strictEqual(outcomes[0]?.ok, false)
      assert.isFalse(
        requests.some((request) => request.method === 'PATCH' || request.method === 'POST'),
      )
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a') })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(
        makeHttpLayer({
          folderId: 'folder-1',
          managedFiles: [
            { id: 'file-1', name: 'one.md' },
            { id: 'file-2', name: 'two.md' },
          ],
          requests,
        }),
      ),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('does not create after a failed legacy adoption', () => {
    const requests: { url: string; method: string; body: string }[] = []
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.strictEqual(outcomes[0]?.ok, false)
      assert.isFalse(
        requests.some(
          (request) => request.method === 'POST' && request.url.includes('uploadType=multipart'),
        ),
      )
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a'), title: 'Legacy' })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(
        makeHttpLayer({
          folderId: 'folder-1',
          legacyFilesByName: { 'Legacy.md': [{ id: 'legacy-1', name: 'Legacy.md' }] },
          legacyContentById: { 'legacy-1': '# doc' },
          failUrlContains: 'legacy-1',
          failMethod: 'PATCH',
          requests,
        }),
      ),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('ignores a same-name legacy file with a foreign private marker', () => {
    const requests: HttpRequest[] = []
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [{ docId: sourceId('a'), ok: true }])
      assert.isFalse(
        requests.some((request) => request.url.includes('legacy-1') && request.method === 'PATCH'),
      )
      assert.isTrue(
        requests.some(
          (request) => request.method === 'POST' && request.url.includes('uploadType=multipart'),
        ),
      )
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a'), title: 'Legacy' })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(
        makeHttpLayer({
          folderId: 'folder-1',
          legacyFilesByName: {
            'Legacy.md': [
              {
                id: 'legacy-1',
                name: 'Legacy.md',
                appProperties: { notebookLmPorterArtifact: 'foreign' },
              },
            ],
          },
          requests,
        }),
      ),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('ignores a same-name legacy file with the wrong MIME type', () => {
    const requests: HttpRequest[] = []
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [{ docId: sourceId('a'), ok: true }])
      assert.isFalse(
        requests.some((request) => request.url.includes('legacy-1') && request.method === 'PATCH'),
      )
      assert.isTrue(
        requests.some(
          (request) => request.method === 'POST' && request.url.includes('uploadType=multipart'),
        ),
      )
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a'), title: 'Legacy' })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(
        makeHttpLayer({
          folderId: 'folder-1',
          legacyFilesByName: {
            'Legacy.md': [{ id: 'legacy-1', name: 'Legacy.md', mimeType: 'text/plain' }],
          },
          requests,
        }),
      ),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('fails ambiguous eligible legacy artifacts without a mutation', () => {
    const requests: HttpRequest[] = []
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [
        { docId: sourceId('a'), ok: false, error: 'ambiguous-legacy-file: 0' },
      ])
      assert.isFalse(
        requests.some((request) => request.method === 'PATCH' || request.method === 'POST'),
      )
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a'), title: 'Legacy' })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(
        makeHttpLayer({
          folderId: 'folder-1',
          legacyFilesByName: {
            'Legacy.md': [
              { id: 'one', name: 'Legacy.md' },
              { id: 'two', name: 'Legacy.md' },
            ],
          },
          requests,
        }),
      ),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('isolates malformed Drive JSON and shapes from later docs', () => {
    const requests: HttpRequest[] = []
    let managedLists = 0
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([
        sourceId('bad-json'),
        sourceId('bad-shape'),
        sourceId('good'),
      ])
      assert.deepStrictEqual(outcomes[0], {
        docId: sourceId('bad-json'),
        ok: false,
        error: 'find-managed-file: 0',
      })
      assert.deepStrictEqual(outcomes[1], {
        docId: sourceId('bad-shape'),
        ok: false,
        error: 'find-managed-file: 0',
      })
      assert.deepStrictEqual(outcomes[2], { docId: sourceId('good'), ok: true })
      assert.isTrue(
        requests.some(
          (request) => request.method === 'POST' && request.url.includes('uploadType=multipart'),
        ),
      )
    }).pipe(
      Effect.provide(
        makeKvLayer(
          [
            makeDoc({ id: sourceId('bad-json') }),
            makeDoc({ id: sourceId('bad-shape') }),
            makeDoc({ id: sourceId('good') }),
          ],
          'client-1',
        ),
      ),
      Effect.provide(AuthOk),
      Effect.provide(
        makeScriptedHttpLayer((request) => {
          requests.push(request)
          if (isManagedFolderQuery(request.url))
            return Effect.succeed(
              listResponse([
                {
                  id: 'folder-1',
                  name: 'NotebookLM Porter',
                  mimeType: 'application/vnd.google-apps.folder',
                },
              ]),
            )
          if (request.url.includes('source:v1:')) {
            managedLists += 1
            if (managedLists === 1) return Effect.succeed('{')
            if (managedLists === 2) return Effect.succeed(JSON.stringify({ files: [{}] }))
            return Effect.succeed(listResponse([]))
          }
          if (request.method === 'GET') return Effect.succeed(listResponse([]))
          return Effect.succeed(JSON.stringify({ id: 'new-file-id' }))
        }),
      ),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('accepts Drive list defaults when optional fields are absent', () =>
    Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [{ docId: sourceId('a'), ok: true }])
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a') })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(
        makeScriptedHttpLayer((request) => {
          if (isManagedFolderQuery(request.url)) {
            return Effect.succeed(
              JSON.stringify({
                files: [
                  {
                    id: 'folder-1',
                    name: 'NotebookLM Porter',
                    mimeType: 'application/vnd.google-apps.folder',
                  },
                ],
              }),
            )
          }
          if (isManagedFileQuery(request.url)) return Effect.succeed(JSON.stringify({ files: [] }))
          if (request.method === 'GET') return Effect.succeed(JSON.stringify({}))
          return Effect.succeed(JSON.stringify({ id: 'new-file-id' }))
        }),
      ),
      Effect.provide(NoopDebugLog),
    ),
  )

  it.effect('finds paginated duplicate managed artifacts before mutating', () => {
    const requests: HttpRequest[] = []
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [
        { docId: sourceId('a'), ok: false, error: 'ambiguous-managed-file: 0' },
      ])
      assert.isFalse(
        requests.some((request) => request.method === 'PATCH' || request.method === 'POST'),
      )
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a') })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(
        makeScriptedHttpLayer((request) => {
          requests.push(request)
          if (isManagedFolderQuery(request.url))
            return Effect.succeed(
              listResponse([
                {
                  id: 'folder-1',
                  name: 'NotebookLM Porter',
                  mimeType: 'application/vnd.google-apps.folder',
                },
              ]),
            )
          if (isManagedFileQuery(request.url))
            return Effect.succeed(
              request.url.includes('pageToken=p2')
                ? listResponse([{ id: 'two', name: 'two.md' }])
                : listResponse([{ id: 'one', name: 'one.md' }], { nextPageToken: 'p2' }),
            )
          return Effect.succeed(listResponse([]))
        }),
      ),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('fails a pagination token cycle, then releases the permit for the next backup', () => {
    let backups = 0
    let creates = 0
    return Effect.gen(function* () {
      const first = yield* backupDocsToDrive([sourceId('a')])
      const second = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(first, [
        { docId: sourceId('a'), ok: false, error: 'find-managed-file: 0' },
      ])
      assert.deepStrictEqual(second, [{ docId: sourceId('a'), ok: true }])
      assert.strictEqual(creates, 1)
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a') })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(
        makeScriptedHttpLayer((request) => {
          if (isManagedFolderQuery(request.url)) {
            backups += 1
            return Effect.succeed(
              listResponse([
                {
                  id: 'folder-1',
                  name: 'NotebookLM Porter',
                  mimeType: 'application/vnd.google-apps.folder',
                },
              ]),
            )
          }
          if (isManagedFileQuery(request.url) && backups === 1) {
            return Effect.succeed(listResponse([], { nextPageToken: 'again' }))
          }
          if (request.method === 'GET') return Effect.succeed(listResponse([]))
          if (request.method === 'POST') creates += 1
          return Effect.succeed(JSON.stringify({ id: 'new-file-id' }))
        }),
      ),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('never retags a foreign-marked legacy folder', () => {
    const requests: HttpRequest[] = []
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [{ docId: sourceId('a'), ok: true }])
      assert.isFalse(
        requests.some(
          (request) => request.method === 'PATCH' && request.url.includes('foreign-folder'),
        ),
      )
      assert.isTrue(
        requests.some(
          (request) =>
            request.method === 'POST' && request.url.endsWith('/drive/v3/files?fields=id'),
        ),
      )
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a') })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(
        makeScriptedHttpLayer((request) => {
          requests.push(request)
          if (isManagedFolderQuery(request.url)) return Effect.succeed(listResponse([]))
          if (isFolderQuery(request.url))
            return Effect.succeed(
              listResponse([
                {
                  id: 'foreign-folder',
                  name: 'NotebookLM Porter',
                  mimeType: 'application/vnd.google-apps.folder',
                  appProperties: { notebookLmPorterArtifact: 'foreign' },
                },
              ]),
            )
          if (request.method === 'GET') return Effect.succeed(listResponse([]))
          return Effect.succeed(JSON.stringify({ id: 'new-folder-or-file' }))
        }),
      ),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('tags one unowned legacy folder before using it', () => {
    const requests: HttpRequest[] = []
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [{ docId: sourceId('a'), ok: true }])
      assert.isTrue(
        requests.some(
          (request) => request.method === 'PATCH' && request.url.includes('legacy-folder'),
        ),
      )
    }).pipe(
      Effect.provide(makeKvLayer([makeDoc({ id: sourceId('a') })], 'client-1')),
      Effect.provide(AuthOk),
      Effect.provide(
        makeScriptedHttpLayer((request) => {
          requests.push(request)
          if (isManagedFolderQuery(request.url)) return Effect.succeed(listResponse([]))
          if (isFolderQuery(request.url))
            return Effect.succeed(
              listResponse([
                {
                  id: 'legacy-folder',
                  name: 'NotebookLM Porter',
                  mimeType: 'application/vnd.google-apps.folder',
                },
              ]),
            )
          if (request.method === 'GET') return Effect.succeed(listResponse([]))
          return Effect.succeed(JSON.stringify({ id: 'new-file-id' }))
        }),
      ),
      Effect.provide(NoopDebugLog),
    )
  })

  it('serializes concurrent backups into one create then one update', async () => {
    const requests: HttpRequest[] = []
    let created = false
    let startUpload!: () => void
    let releaseUpload!: () => void
    const uploadStarted = new Promise<void>((resolve) => {
      startUpload = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseUpload = resolve
    })
    const layer = Layer.mergeAll(
      makeKvLayer([makeDoc({ id: sourceId('a') })], 'client-1'),
      AuthOk,
      makeScriptedHttpLayer((request) => {
        requests.push(request)
        if (isManagedFolderQuery(request.url))
          return Effect.succeed(
            listResponse([
              {
                id: 'folder-1',
                name: 'NotebookLM Porter',
                mimeType: 'application/vnd.google-apps.folder',
              },
            ]),
          )
        if (isManagedFileQuery(request.url))
          return Effect.succeed(listResponse(created ? [{ id: 'file-1', name: 'old.md' }] : []))
        if (request.method === 'GET') return Effect.succeed(listResponse([]))
        if (request.method === 'POST' && request.url.includes('uploadType=multipart')) {
          startUpload()
          return Effect.promise(async () => {
            await release
            created = true
            return JSON.stringify({ id: 'file-1' })
          })
        }
        return Effect.succeed(JSON.stringify({ id: 'file-1' }))
      }),
      NoopDebugLog,
    )
    const first = Effect.runPromise(backupDocsToDrive([sourceId('a')]).pipe(Effect.provide(layer)))
    await uploadStarted
    const second = Effect.runPromise(backupDocsToDrive([sourceId('a')]).pipe(Effect.provide(layer)))
    await Promise.resolve()
    await Promise.resolve()
    assert.strictEqual(requests.filter((request) => isManagedFolderQuery(request.url)).length, 1)
    releaseUpload()
    const outcomes = await Promise.all([first, second])
    assert.deepStrictEqual(outcomes, [
      [{ docId: sourceId('a'), ok: true }],
      [{ docId: sourceId('a'), ok: true }],
    ])
    assert.strictEqual(
      requests.filter(
        (request) => request.method === 'POST' && request.url.includes('uploadType=multipart'),
      ).length,
      1,
    )
    assert.strictEqual(
      requests.filter((request) => request.method === 'PATCH' && request.url.includes('file-1'))
        .length,
      1,
    )
  })

  it.effect('keeps sanitized, blank, and truncated title collisions as separate artifacts', () => {
    const requests: HttpRequest[] = []
    const long = 'x'.repeat(300)
    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([
        sourceId('slash'),
        sourceId('backslash'),
        sourceId('blank'),
        sourceId('space'),
        sourceId('long-a'),
        sourceId('long-b'),
      ])
      assert.isTrue(outcomes.every((outcome) => outcome.ok))
      const names = requests
        .filter(
          (request) => request.method === 'POST' && request.url.includes('uploadType=multipart'),
        )
        .map((request) => request.body.match(/"name":"([^"]+)"/)?.[1])
      assert.strictEqual(new Set(names).size, 6)
      assert.isTrue(names.every((name) => name !== undefined && name.length <= 100))
    }).pipe(
      Effect.provide(
        makeKvLayer(
          [
            makeDoc({ id: sourceId('slash'), title: 'a/b' }),
            makeDoc({ id: sourceId('backslash'), title: 'a\\b' }),
            makeDoc({ id: sourceId('blank'), title: '' }),
            makeDoc({ id: sourceId('space'), title: '   ' }),
            makeDoc({ id: sourceId('long-a'), title: long }),
            makeDoc({ id: sourceId('long-b'), title: long }),
          ],
          'client-1',
        ),
      ),
      Effect.provide(AuthOk),
      Effect.provide(makeHttpLayer({ folderId: 'folder-1', requests })),
      Effect.provide(NoopDebugLog),
    )
  })
})

/**
 * A `kvTest`-backed store the test keeps a handle on: `kvTest` mutates the
 * `Map` in place, so `set`s land in `store` and the token cache written by
 * `authenticate`/`invalidateToken` can be read back after the effect runs.
 */
function statefulKv(seed: Record<string, unknown>) {
  const store = new Map<string, unknown>(Object.entries(seed))
  return { layer: kvTest(store), store }
}

/** Counts `launchAuthFlow` calls so tests can assert the interactive flow ran (or didn't). */
function makeIdentityLayer(opts: {
  accessToken: string
  expiresInSec?: number
  onLaunch: () => void
}) {
  return Layer.succeed(
    Identity,
    Identity.of({
      redirectUrl: () => 'https://abc.chromiumapp.org/',
      launchAuthFlow: () =>
        Effect.sync(opts.onLaunch).pipe(
          Effect.as(
            `https://abc.chromiumapp.org/#access_token=${opts.accessToken}&expires_in=${opts.expiresInSec ?? 3599}`,
          ),
        ),
    }),
  )
}

/** Every Drive request 401s unless it's bearing `validToken` — models a dead cached token. */
function makeAuthGatedHttpLayer(opts: { validToken: string; folderId?: string }) {
  return Layer.succeed(
    Http,
    Http.of({
      text: (url: string, init?: HttpInit) =>
        Effect.gen(function* () {
          const auth = init?.headers?.Authorization ?? ''
          const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : ''
          if (token !== opts.validToken) {
            return yield* Effect.fail(new HttpStatusError({ url, status: 401 }))
          }

          const method = init?.method ?? 'GET'
          const decoded = decodeURIComponent(url)
          if (method === 'GET' && isFolderQuery(url)) {
            return listResponse(
              opts.folderId !== undefined
                ? [
                    {
                      id: opts.folderId,
                      name: 'NotebookLM Porter',
                      mimeType: 'application/vnd.google-apps.folder',
                      appProperties: { notebookLmPorterArtifact: 'backup-folder:v1' },
                    },
                  ]
                : [],
            )
          }
          if (method === 'GET') return listResponse([])
          if (method === 'POST' && !decoded.includes('uploadType')) {
            return JSON.stringify({ id: 'new-folder-id' })
          }
          return JSON.stringify({ id: 'new-file-id' })
        }),
      json: () => Effect.die('unused in backup tests'),
    }),
  )
}

/** Every Drive request 401s, regardless of token — models re-auth also failing. */
const AlwaysUnauthorizedHttp = Layer.succeed(
  Http,
  Http.of({
    text: (url: string) => Effect.fail(new HttpStatusError({ url, status: 401 })),
    json: () => Effect.die('unused in backup tests'),
  }),
)

describe('backupDocsToDrive token caching', () => {
  it.effect('reuses a still-valid cached token and never runs the interactive flow', () => {
    let launchCount = 0
    const authLog: string[] = []
    const kv = statefulKv({
      'porter/docs': [makeDoc({ id: sourceId('a'), title: 'Fresh Doc' })],
      'porter/settings': { driveClientId: 'client-1' },
      [DRIVE_TOKEN_CACHE_KEY]: {
        accessToken: 'cached-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      } satisfies CachedToken,
    })

    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [{ docId: sourceId('a'), ok: true }])
      assert.strictEqual(launchCount, 0)
      assert.isTrue(authLog.every((token) => token === 'cached-token'))
      assert.isTrue(authLog.length > 0)
    }).pipe(
      Effect.provide(kv.layer),
      Effect.provide(
        makeIdentityLayer({ accessToken: 'unused', onLaunch: () => (launchCount += 1) }),
      ),
      Effect.provide(makeHttpLayer({ authLog })),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('runs the interactive flow and caches the result when there is no cached token', () => {
    let launchCount = 0
    const kv = statefulKv({
      'porter/docs': [makeDoc({ id: sourceId('a'), title: 'Fresh Doc' })],
      'porter/settings': { driveClientId: 'client-1' },
    })

    return Effect.gen(function* () {
      const before = Date.now()
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [{ docId: sourceId('a'), ok: true }])
      assert.strictEqual(launchCount, 1)

      const cached = kv.store.get(DRIVE_TOKEN_CACHE_KEY) as CachedToken
      assert.strictEqual(cached.accessToken, 'fresh-token')
      assert.isTrue(cached.expiresAt >= before + 3599 * 1000)
    }).pipe(
      Effect.provide(kv.layer),
      Effect.provide(
        makeIdentityLayer({ accessToken: 'fresh-token', onLaunch: () => (launchCount += 1) }),
      ),
      Effect.provide(makeHttpLayer({})),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('runs the interactive flow when the cached token is within the safety margin', () => {
    let launchCount = 0
    const kv = statefulKv({
      'porter/docs': [makeDoc({ id: sourceId('a'), title: 'Fresh Doc' })],
      'porter/settings': { driveClientId: 'client-1' },
      // Expires in 30s — inside the 60s safety margin, so it must not be reused.
      [DRIVE_TOKEN_CACHE_KEY]: {
        accessToken: 'about-to-expire',
        expiresAt: Date.now() + 30_000,
      } satisfies CachedToken,
    })

    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [{ docId: sourceId('a'), ok: true }])
      assert.strictEqual(launchCount, 1)
    }).pipe(
      Effect.provide(kv.layer),
      Effect.provide(
        makeIdentityLayer({ accessToken: 'fresh-token', onLaunch: () => (launchCount += 1) }),
      ),
      Effect.provide(makeHttpLayer({})),
      Effect.provide(NoopDebugLog),
    )
  })
})

describe('backupDocsToDrive 401 handling', () => {
  it.effect('clears the cached token and retries once with a fresh interactive auth', () => {
    let launchCount = 0
    const kv = statefulKv({
      'porter/docs': [makeDoc({ id: sourceId('a'), title: 'Fresh Doc' })],
      'porter/settings': { driveClientId: 'client-1' },
      [DRIVE_TOKEN_CACHE_KEY]: {
        accessToken: 'stale-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      } satisfies CachedToken,
    })

    return Effect.gen(function* () {
      const outcomes = yield* backupDocsToDrive([sourceId('a')])
      assert.deepStrictEqual(outcomes, [{ docId: sourceId('a'), ok: true }])
      // Exactly one interactive auth: the stale cached token was tried first
      // (and rejected), then a single fresh auth succeeded.
      assert.strictEqual(launchCount, 1)

      const cached = kv.store.get(DRIVE_TOKEN_CACHE_KEY) as CachedToken
      assert.strictEqual(cached.accessToken, 'fresh-token')
    }).pipe(
      Effect.provide(kv.layer),
      Effect.provide(
        makeIdentityLayer({ accessToken: 'fresh-token', onLaunch: () => (launchCount += 1) }),
      ),
      Effect.provide(makeAuthGatedHttpLayer({ validToken: 'fresh-token' })),
      Effect.provide(NoopDebugLog),
    )
  })

  it.effect('gives up after exactly one retry when re-authenticating is still unauthorized', () => {
    let launchCount = 0
    const kv = statefulKv({
      'porter/docs': [makeDoc({ id: sourceId('a'), title: 'Fresh Doc' })],
      'porter/settings': { driveClientId: 'client-1' },
      [DRIVE_TOKEN_CACHE_KEY]: {
        accessToken: 'stale-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      } satisfies CachedToken,
    })

    return Effect.gen(function* () {
      const result = yield* Effect.result(backupDocsToDrive([sourceId('a')]))
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, DriveAuthError)
        assert.strictEqual(result.failure.reason, 'still unauthorized after re-authenticating')
      }
      // Not called twice more (or in a loop): the cached token wasn't
      // interactive, then exactly one retry, then give up.
      assert.strictEqual(launchCount, 1)
    }).pipe(
      Effect.provide(kv.layer),
      Effect.provide(
        makeIdentityLayer({ accessToken: 'still-fresh-token', onLaunch: () => (launchCount += 1) }),
      ),
      Effect.provide(AlwaysUnauthorizedHttp),
      Effect.provide(NoopDebugLog),
    )
  })
})
