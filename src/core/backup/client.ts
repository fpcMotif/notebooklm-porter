/**
 * Drive backup — thin service-worker wrapper around the pure request
 * builders in `drive.ts`. Owns everything `drive.ts` deliberately doesn't:
 * OAuth (`Identity`), fetch (`Http`), and the find-or-create/update flow
 * against the "NotebookLM Porter" Drive folder.
 */
import { Effect, Result } from 'effect'
import {
  buildAuthUrl,
  buildCreateFileRequest,
  buildCreateFolderRequest,
  buildFindFileRequest,
  buildFindFolderRequest,
  buildUpdateFileRequest,
  docFileName,
  parseAuthRedirect,
  type DriveRequest,
} from './drive'
import { DriveAuthError, DriveApiError, HttpStatusError, type StorageError } from '../fx/errors'
import { DebugLog, Http, Identity, Kv } from '../fx/services'
import { getSettings } from '../settings'
import { listDocs } from '../store'

const BACKUP_FOLDER_NAME = 'NotebookLM Porter'

export interface BackupOutcome {
  docId: string
  ok: boolean
  error?: string
}

interface DriveFile {
  id: string
  name: string
}

function driveFetch(step: string, req: DriveRequest): Effect.Effect<unknown, DriveApiError, Http> {
  return Effect.gen(function* () {
    const http = yield* Http
    const result = yield* Effect.result(
      http.text(req.url, {
        method: req.method,
        headers: req.headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
      }),
    )
    if (Result.isFailure(result)) {
      const status = result.failure instanceof HttpStatusError ? result.failure.status : 0
      return yield* Effect.fail(new DriveApiError({ step, status }))
    }
    const text = result.success
    return text.length > 0 ? JSON.parse(text) : {}
  })
}

function listFiles(
  step: string,
  req: DriveRequest,
): Effect.Effect<DriveFile[], DriveApiError, Http> {
  return Effect.gen(function* () {
    const parsed = (yield* driveFetch(step, req)) as { files?: DriveFile[] }
    return parsed.files ?? []
  })
}

function authenticate(clientId: string): Effect.Effect<string, DriveAuthError, Identity> {
  return Effect.gen(function* () {
    const identity = yield* Identity
    const redirectUri = identity.redirectUrl()
    const authUrl = buildAuthUrl({ clientId, redirectUri })
    const redirectUrl = yield* identity.launchAuthFlow(authUrl)

    const result = parseAuthRedirect(redirectUrl)
    if ('error' in result) {
      return yield* Effect.fail(new DriveAuthError({ reason: result.error }))
    }
    return result.accessToken
  })
}

function findOrCreateFolder(token: string): Effect.Effect<string, DriveApiError, Http | DebugLog> {
  return Effect.gen(function* () {
    const debugLog = yield* DebugLog
    const existing = yield* listFiles(
      'find-folder',
      buildFindFolderRequest(token, BACKUP_FOLDER_NAME),
    )
    const found = existing[0]
    if (found !== undefined) {
      yield* debugLog.log('drive', 'folder', { outcome: 'found', id: found.id })
      return found.id
    }

    const created = (yield* driveFetch(
      'create-folder',
      buildCreateFolderRequest(token, BACKUP_FOLDER_NAME),
    )) as { id: string }
    yield* debugLog.log('drive', 'folder', { outcome: 'created', id: created.id })
    return created.id
  })
}

/**
 * Backs up the given docs to the user's Drive, one file per doc inside a
 * single "NotebookLM Porter" folder. Per-doc isolation via `Effect.result`
 * so one failing upload never aborts the rest of the batch.
 */
export function backupDocsToDrive(
  docIds: string[],
): Effect.Effect<BackupOutcome[], DriveAuthError | StorageError, Http | Identity | Kv | DebugLog> {
  return Effect.gen(function* () {
    const settings = yield* getSettings()
    const clientId = settings.driveClientId
    if (clientId === undefined || clientId.length === 0) {
      return yield* Effect.fail(new DriveAuthError({ reason: 'missing-client-id' }))
    }

    const token = yield* authenticate(clientId)
    const folderResult = yield* Effect.result(findOrCreateFolder(token))
    if (Result.isFailure(folderResult)) {
      return yield* Effect.fail(
        new DriveAuthError({ reason: `folder setup failed: ${folderResult.failure.step}` }),
      )
    }
    const folderId = folderResult.success

    const docs = yield* listDocs()
    const byId = new Map(docs.map((doc) => [doc.id, doc]))

    const outcomes: BackupOutcome[] = []
    for (const docId of docIds) {
      const doc = byId.get(docId)
      if (doc === undefined) {
        outcomes.push({ docId, ok: false, error: 'Doc not found' })
        continue
      }

      // Sequential + isolated by design: one doc's failure must not abort the
      // rest of the batch, and Drive quota is per-request anyway.
      outcomes.push(yield* backupOne(token, folderId, docId, doc.title, doc.markdown))
    }
    return outcomes
  })
}

function backupOne(
  token: string,
  folderId: string,
  docId: string,
  title: string,
  content: string,
): Effect.Effect<BackupOutcome, never, Http | DebugLog> {
  return Effect.gen(function* () {
    const debugLog = yield* DebugLog
    const result = yield* Effect.result(
      Effect.gen(function* () {
        const name = docFileName(title)
        const existing = yield* listFiles('find-file', buildFindFileRequest(token, name, folderId))
        const found = existing[0]
        if (found !== undefined) {
          yield* driveFetch('update-file', buildUpdateFileRequest(token, found.id, content))
          yield* debugLog.log('drive', 'upload', { docId, outcome: 'updated', id: found.id })
        } else {
          yield* driveFetch(
            'create-file',
            buildCreateFileRequest(token, {
              name,
              folderId,
              content,
              boundary: crypto.randomUUID(),
            }),
          )
          yield* debugLog.log('drive', 'upload', { docId, outcome: 'created' })
        }
      }),
    )

    if (Result.isFailure(result)) {
      const message = `${result.failure.step}: ${result.failure.status}`
      yield* debugLog.log('drive', 'upload', { docId, outcome: 'failed', error: message })
      return { docId, ok: false, error: message }
    }
    return { docId, ok: true }
  })
}
