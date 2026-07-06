/**
 * Drive backup — thin service-worker wrapper around the pure request
 * builders in `drive.ts`. Owns everything `drive.ts` deliberately doesn't:
 * OAuth (`browser.identity`), fetch, and the find-or-create/update flow
 * against the "NotebookLM Porter" Drive folder.
 */
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

async function driveFetch(req: DriveRequest): Promise<unknown> {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
  })
  if (!res.ok) {
    throw new Error(`Drive request failed: ${res.status} ${res.statusText}`)
  }
  const text = await res.text()
  return text.length > 0 ? JSON.parse(text) : {}
}

async function listFiles(req: DriveRequest): Promise<DriveFile[]> {
  const parsed = (await driveFetch(req)) as { files?: DriveFile[] }
  return parsed.files ?? []
}

async function authenticate(clientId: string): Promise<string> {
  const redirectUri = browser.identity.getRedirectURL()
  const authUrl = buildAuthUrl({ clientId, redirectUri })
  const redirectUrl = await browser.identity.launchWebAuthFlow({ url: authUrl, interactive: true })
  if (redirectUrl === undefined) {
    throw new Error('Google sign-in was cancelled')
  }

  const result = parseAuthRedirect(redirectUrl)
  if ('error' in result) {
    throw new Error(`Google sign-in failed: ${result.error}`)
  }
  return result.accessToken
}

async function findOrCreateFolder(token: string): Promise<string> {
  const existing = await listFiles(buildFindFolderRequest(token, BACKUP_FOLDER_NAME))
  const found = existing[0]
  if (found !== undefined) return found.id

  const created = (await driveFetch(buildCreateFolderRequest(token, BACKUP_FOLDER_NAME))) as {
    id: string
  }
  return created.id
}

/**
 * Backs up the given docs to the user's Drive, one file per doc inside a
 * single "NotebookLM Porter" folder. Per-doc try/catch so one failing
 * upload never aborts the rest of the batch.
 */
export async function backupDocsToDrive(docIds: string[]): Promise<BackupOutcome[]> {
  const settings = await getSettings()
  const clientId = settings.driveClientId
  if (clientId === undefined || clientId.length === 0) {
    throw new Error('Set your Google OAuth Client ID in Settings first')
  }

  const token = await authenticate(clientId)
  const folderId = await findOrCreateFolder(token)

  const docs = await listDocs()
  const byId = new Map(docs.map((doc) => [doc.id, doc]))

  const outcomes: BackupOutcome[] = []
  for (const docId of docIds) {
    const doc = byId.get(docId)
    if (doc === undefined) {
      outcomes.push({ docId, ok: false, error: 'Doc not found' })
      continue
    }

    // eslint-disable-next-line no-await-in-loop
    outcomes.push(await backupOne(token, folderId, docId, doc.title, doc.markdown))
  }
  return outcomes
}

async function backupOne(
  token: string,
  folderId: string,
  docId: string,
  title: string,
  content: string,
): Promise<BackupOutcome> {
  try {
    const name = docFileName(title)
    const existing = await listFiles(buildFindFileRequest(token, name, folderId))
    const found = existing[0]
    if (found !== undefined) {
      await driveFetch(buildUpdateFileRequest(token, found.id, content))
    } else {
      await driveFetch(
        buildCreateFileRequest(token, { name, folderId, content, boundary: crypto.randomUUID() }),
      )
    }
    return { docId, ok: true }
  } catch (err) {
    return { docId, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
