/**
 * Drive backup — thin service-worker wrapper around the pure request
 * builders in `drive.ts`. Owns everything `drive.ts` deliberately doesn't:
 * OAuth (`Identity`), fetch (`Http`), and the find-or-create/update flow
 * against the "NotebookLM Porter" Drive folder.
 */
import { Effect, Result, Semaphore } from 'effect'
import {
  buildAuthUrl,
  buildCreateFileRequest,
  buildCreateFolderRequest,
  buildDownloadFileRequest,
  buildFindFileRequest,
  buildFindFolderRequest,
  buildFindManagedFileRequest,
  buildFindManagedFolderRequest,
  buildTagFolderRequest,
  buildUpdateFileRequest,
  DRIVE_ARTIFACT_PROPERTY,
  DRIVE_FOLDER_MIME,
  DRIVE_MARKDOWN_MIME,
  docFileName,
  legacyDocFileName,
  parseAuthRedirect,
  sourceArtifactKey,
  type DriveRequest,
} from './drive'
import { DriveAuthError, DriveApiError, HttpStatusError, type StorageError } from '../fx/errors'
import { DebugLog, Http, Identity, Kv } from '../fx/services'
import { getSettings } from '../settings'
import { listDocs } from '../store'

const BACKUP_FOLDER_NAME = 'NotebookLM Porter'
const backupPermit = Semaphore.makeUnsafe(1)
const MAX_LIST_PAGES = 100

export interface BackupOutcome {
  docId: string
  ok: boolean
  error?: string
}

interface DriveFile {
  id: string
  name: string
  mimeType: string
  appProperties: Record<string, string>
}

interface DriveListResponse {
  files: DriveFile[]
  nextPageToken?: string
  incompleteSearch: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeDriveFile(value: unknown): DriveFile | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.name !== 'string' ||
    typeof value.mimeType !== 'string'
  ) {
    return undefined
  }
  const appProperties: Record<string, string> = {}
  const rawAppProperties = value.appProperties
  if (rawAppProperties !== undefined && !isRecord(rawAppProperties)) return undefined
  for (const [key, property] of Object.entries(rawAppProperties ?? {})) {
    if (typeof property !== 'string') {
      return undefined
    }
    appProperties[key] = property
  }
  return {
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    appProperties,
  }
}

function decodeListResponse(value: unknown): DriveListResponse | undefined {
  if (!isRecord(value)) return undefined
  const rawFiles = value.files ?? []
  if (!Array.isArray(rawFiles)) return undefined
  const incompleteSearch = value.incompleteSearch ?? false
  if (typeof incompleteSearch !== 'boolean') return undefined
  if (
    value.nextPageToken !== undefined &&
    value.nextPageToken !== null &&
    (typeof value.nextPageToken !== 'string' || value.nextPageToken.length === 0)
  ) {
    return undefined
  }
  const files: DriveFile[] = []
  for (const rawFile of rawFiles) {
    const file = decodeDriveFile(rawFile)
    if (file === undefined) {
      return undefined
    }
    files.push(file)
  }
  return {
    files,
    incompleteSearch,
    ...(typeof value.nextPageToken === 'string' ? { nextPageToken: value.nextPageToken } : {}),
  }
}

function decodeCreatedId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0
    ? value.id
    : undefined
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
    return yield* Effect.try({
      try: () => (result.success.length > 0 ? JSON.parse(result.success) : {}),
      catch: () => new DriveApiError({ step, status: 0 }),
    })
  })
}

function driveDownload(
  step: string,
  req: DriveRequest,
): Effect.Effect<string, DriveApiError, Http> {
  return Effect.gen(function* () {
    const http = yield* Http
    const result = yield* Effect.result(
      http.text(req.url, { method: req.method, headers: req.headers }),
    )
    if (Result.isFailure(result)) {
      const status = result.failure instanceof HttpStatusError ? result.failure.status : 0
      return yield* Effect.fail(new DriveApiError({ step, status }))
    }
    return result.success
  })
}

function listAllFiles(
  step: string,
  buildRequest: (pageToken?: string) => DriveRequest,
): Effect.Effect<DriveFile[], DriveApiError, Http> {
  return Effect.gen(function* () {
    const files: DriveFile[] = []
    let pageToken: string | undefined
    const seenTokens = new Set<string>()
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      if (pageToken !== undefined && !seenTokens.add(pageToken)) {
        return yield* Effect.fail(new DriveApiError({ step, status: 0 }))
      }
      const decoded = decodeListResponse(yield* driveFetch(step, buildRequest(pageToken)))
      if (decoded === undefined || decoded.incompleteSearch) {
        return yield* Effect.fail(new DriveApiError({ step, status: 0 }))
      }
      files.push(...decoded.files)
      pageToken = decoded.nextPageToken
      if (pageToken === undefined) {
        return files
      }
    }
    return yield* Effect.fail(new DriveApiError({ step, status: 0 }))
  })
}

function isUnownedFile(file: DriveFile): boolean {
  return (
    file.mimeType === DRIVE_MARKDOWN_MIME &&
    file.appProperties[DRIVE_ARTIFACT_PROPERTY] === undefined
  )
}

function isUnownedFolder(file: DriveFile): boolean {
  return (
    file.mimeType === DRIVE_FOLDER_MIME && file.appProperties[DRIVE_ARTIFACT_PROPERTY] === undefined
  )
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
    const managed = yield* listAllFiles('find-managed-folder', (pageToken) =>
      buildFindManagedFolderRequest(token, pageToken),
    )
    if (managed.length === 1) {
      const found = managed[0]
      if (found === undefined) {
        return yield* Effect.fail(new DriveApiError({ step: 'find-managed-folder', status: 0 }))
      }
      yield* debugLog.log('drive', 'folder', { outcome: 'found', id: found.id })
      return found.id
    }
    if (managed.length > 1) {
      return yield* Effect.fail(new DriveApiError({ step: 'ambiguous-managed-folder', status: 0 }))
    }

    const legacy = (yield* listAllFiles('find-folder', (pageToken) =>
      buildFindFolderRequest(token, BACKUP_FOLDER_NAME, pageToken),
    )).filter(isUnownedFolder)
    if (legacy.length === 1) {
      const folder = legacy[0]
      if (folder === undefined) {
        return yield* Effect.fail(new DriveApiError({ step: 'find-folder', status: 0 }))
      }
      yield* driveFetch('tag-folder', buildTagFolderRequest(token, folder.id))
      yield* debugLog.log('drive', 'folder', { outcome: 'adopted', id: folder.id })
      return folder.id
    }

    const created = decodeCreatedId(
      yield* driveFetch('create-folder', buildCreateFolderRequest(token, BACKUP_FOLDER_NAME)),
    )
    if (created === undefined) {
      return yield* Effect.fail(new DriveApiError({ step: 'create-folder', status: 0 }))
    }
    yield* debugLog.log('drive', 'folder', { outcome: 'created', id: created })
    return created
  })
}

/**
 * Backs up the given docs to the user's Drive, one file per doc inside a
 * single "NotebookLM Porter" folder. Per-doc isolation via `Effect.result`
 * so one failing upload never aborts the rest of the batch.
 */
export function backupDocsToDrive(
  docIds: string[],
): Effect.Effect<
  BackupOutcome[],
  DriveAuthError | DriveApiError | StorageError,
  Http | Identity | Kv | DebugLog
> {
  return backupPermit.withPermit(
    Effect.gen(function* () {
      // Resolve the requested docs before touching Drive. A stale selection must
      // not trigger OAuth, create a folder, or otherwise mutate the account.
      const docs = yield* listDocs()
      const byId = new Map(docs.map((doc) => [doc.id, doc]))
      const requested = docIds.map((docId) => ({ docId, doc: byId.get(docId) }))
      if (!requested.some(({ doc }) => doc !== undefined)) {
        return requested.map(({ docId }) => ({ docId, ok: false, error: 'Doc not found' }))
      }

      const settings = yield* getSettings()
      const clientId = settings.driveClientId
      if (clientId === undefined || clientId.trim().length === 0) {
        return yield* Effect.fail(new DriveAuthError({ reason: 'missing-client-id' }))
      }

      const token = yield* authenticate(clientId)
      const folderId = yield* findOrCreateFolder(token)

      const outcomes: BackupOutcome[] = []
      for (const { docId, doc } of requested) {
        if (doc === undefined) {
          outcomes.push({ docId, ok: false, error: 'Doc not found' })
          continue
        }

        // Sequential + isolated by design: one doc's failure must not abort the
        // rest of the batch, and Drive quota is per-request anyway.
        outcomes.push(yield* backupOne(token, folderId, docId, doc.title, doc.markdown))
      }
      return outcomes
    }),
  )
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
        const artifact = yield* Effect.tryPromise({
          try: () => sourceArtifactKey(docId),
          catch: () => new DriveApiError({ step: 'source-artifact-key', status: 0 }),
        })
        const name = docFileName(title, artifact)
        const managed = yield* listAllFiles('find-managed-file', (pageToken) =>
          buildFindManagedFileRequest(token, artifact, folderId, pageToken),
        )
        if (managed.length > 1) {
          return yield* Effect.fail(
            new DriveApiError({ step: 'ambiguous-managed-file', status: 0 }),
          )
        }

        const found = managed[0]
        if (found !== undefined) {
          yield* driveFetch(
            'update-file',
            buildUpdateFileRequest(token, found.id, {
              name,
              content,
              artifact,
              boundary: crypto.randomUUID(),
            }),
          )
          yield* debugLog.log('drive', 'upload', { docId, outcome: 'updated', id: found.id })
        } else {
          const legacyName = legacyDocFileName(title)
          const legacy = (yield* listAllFiles('find-legacy-file', (pageToken) =>
            buildFindFileRequest(token, legacyName, folderId, pageToken),
          )).filter(isUnownedFile)
          if (legacy.length > 1) {
            return yield* Effect.fail(
              new DriveApiError({ step: 'ambiguous-legacy-file', status: 0 }),
            )
          }
          const candidate = legacy[0]
          if (candidate !== undefined) {
            const legacyContent = yield* driveDownload(
              'download-legacy-file',
              buildDownloadFileRequest(token, candidate.id),
            )
            if (legacyContent === content) {
              yield* driveFetch(
                'adopt-legacy-file',
                buildUpdateFileRequest(token, candidate.id, {
                  name,
                  content,
                  artifact,
                  boundary: crypto.randomUUID(),
                }),
              )
              yield* debugLog.log('drive', 'upload', {
                docId,
                outcome: 'adopted',
                id: candidate.id,
              })
              return
            }
          }
          yield* driveFetch(
            'create-file',
            buildCreateFileRequest(token, {
              name,
              folderId,
              content,
              artifact,
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
