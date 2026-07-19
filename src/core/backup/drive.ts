/**
 * Google Drive backup — pure request-descriptor builders (design §2: v1.5,
 * user-requested, explicit-action backup of captured sources into one Drive
 * folder; Drive revisions give version history so update-not-duplicate is
 * the shape everywhere below). No fetch, no `browser.*` — callers in
 * `capture.ts`/entrypoints own the actual network calls and OAuth redirect.
 */
import { sha256Base64Url } from '../crypto'
import { sanitizeFilenameBase } from '../filename'

export interface DriveRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'
export const DRIVE_MARKDOWN_MIME = 'text/markdown'
export const DRIVE_ARTIFACT_PROPERTY = 'notebookLmPorterArtifact'
export const DRIVE_FOLDER_ARTIFACT = 'backup-folder:v1'
const SOURCE_ARTIFACT_PREFIX = 'source:v1:'
const SHORT_DIGEST_LENGTH = 12
const MAX_FILENAME_LENGTH = 100

/**
 * Builds the implicit-grant (`token`) OAuth URL. `prompt=select_account`
 * forces Google's account chooser so the user picks WHICH of their signed-in
 * Google identities (and therefore which Drive) receives the backup, rather
 * than silently reusing whatever session cookie happens to be active.
 */
export function buildAuthUrl(opts: { clientId: string; redirectUri: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'token',
    scope: 'https://www.googleapis.com/auth/drive.file',
    prompt: 'select_account',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

export type AuthRedirectResult = { accessToken: string; expiresInSec: number } | { error: string }

/**
 * The implicit grant returns the token in the URL FRAGMENT, never the query
 * string, so it never hits Google's (or our) server logs. `expires_in`
 * arrives as a string; a non-numeric value is treated as a protocol-drift
 * error rather than silently becoming `NaN`.
 */
export function parseAuthRedirect(redirectUrl: string): AuthRedirectResult {
  let url: URL
  try {
    url = new URL(redirectUrl)
  } catch {
    return { error: 'invalid-redirect-url' }
  }

  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
  if (fragment.length === 0) {
    return { error: 'missing-fragment' }
  }

  const params = new URLSearchParams(fragment)
  const oauthError = params.get('error')
  if (oauthError !== null) {
    return { error: oauthError }
  }

  const accessToken = params.get('access_token')
  if (accessToken === null || accessToken.length === 0) {
    return { error: 'missing-access-token' }
  }

  const expiresInRaw = params.get('expires_in')
  if (expiresInRaw === null || !/^\d+$/.test(expiresInRaw)) {
    return { error: 'missing-or-invalid-expires-in' }
  }

  return { accessToken, expiresInSec: Number.parseInt(expiresInRaw, 10) }
}

function authHeaders(token: string, extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...extra }
}

/**
 * Escapes `'` and `\` per Drive's query syntax (both are the string
 * delimiter's escape targets) so a title containing either doesn't break out
 * of the quoted literal or get treated as a query operator.
 */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function filesListRequest(token: string, query: string, pageToken?: string): DriveRequest {
  const params = new URLSearchParams({
    q: query,
    pageSize: '1000',
    fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,appProperties)',
  })
  if (pageToken !== undefined) {
    params.set('pageToken', pageToken)
  }
  return {
    url: `${DRIVE_FILES_URL}?${params.toString()}`,
    method: 'GET',
    headers: authHeaders(token),
  }
}

export function buildFindFolderRequest(
  token: string,
  name: string,
  pageToken?: string,
): DriveRequest {
  const escaped = escapeDriveQueryValue(name)
  const query = `name='${escaped}' and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false`
  return filesListRequest(token, query, pageToken)
}

function appPropertyQuery(value: string): string {
  return `appProperties has { key='${DRIVE_ARTIFACT_PROPERTY}' and value='${escapeDriveQueryValue(value)}' }`
}

export function buildFindManagedFolderRequest(token: string, pageToken?: string): DriveRequest {
  const query = `${appPropertyQuery(DRIVE_FOLDER_ARTIFACT)} and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false`
  return filesListRequest(token, query, pageToken)
}

export function buildCreateFolderRequest(token: string, name: string): DriveRequest {
  return {
    url: `${DRIVE_FILES_URL}?fields=id`,
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name,
      mimeType: DRIVE_FOLDER_MIME,
      appProperties: { [DRIVE_ARTIFACT_PROPERTY]: DRIVE_FOLDER_ARTIFACT },
    }),
  }
}

export function buildTagFolderRequest(token: string, folderId: string): DriveRequest {
  return {
    url: `${DRIVE_FILES_URL}/${encodeURIComponent(folderId)}`,
    method: 'PATCH',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      appProperties: { [DRIVE_ARTIFACT_PROPERTY]: DRIVE_FOLDER_ARTIFACT },
    }),
  }
}

export function buildFindFileRequest(
  token: string,
  name: string,
  folderId: string,
  pageToken?: string,
): DriveRequest {
  const escapedName = escapeDriveQueryValue(name)
  const escapedFolderId = escapeDriveQueryValue(folderId)
  const query = `name='${escapedName}' and '${escapedFolderId}' in parents and mimeType!='${DRIVE_FOLDER_MIME}' and trashed=false`
  return filesListRequest(token, query, pageToken)
}

export function buildFindManagedFileRequest(
  token: string,
  artifact: string,
  folderId: string,
  pageToken?: string,
): DriveRequest {
  const escapedFolderId = escapeDriveQueryValue(folderId)
  const query = `${appPropertyQuery(artifact)} and '${escapedFolderId}' in parents and mimeType!='${DRIVE_FOLDER_MIME}' and trashed=false`
  return filesListRequest(token, query, pageToken)
}

export function buildDownloadFileRequest(token: string, fileId: string): DriveRequest {
  const params = new URLSearchParams({ alt: 'media' })
  return {
    url: `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?${params.toString()}`,
    method: 'GET',
    headers: authHeaders(token),
  }
}

/**
 * multipart/related upload: a JSON metadata part followed by the Markdown
 * media part, CRLF-framed per the multipart spec (Drive's parser is strict
 * about this). `boundary` is caller-injected so the exact body is
 * deterministic and testable without touching randomness.
 */
export function buildCreateFileRequest(
  token: string,
  opts: { name: string; folderId: string; content: string; artifact: string; boundary: string },
): DriveRequest {
  const metadata = JSON.stringify({
    name: opts.name,
    parents: [opts.folderId],
    appProperties: { [DRIVE_ARTIFACT_PROPERTY]: opts.artifact },
  })
  const body =
    `--${opts.boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${opts.boundary}\r\n` +
    `Content-Type: ${DRIVE_MARKDOWN_MIME}\r\n\r\n` +
    `${opts.content}\r\n` +
    `--${opts.boundary}--`

  return {
    url: `${DRIVE_UPLOAD_URL}?uploadType=multipart`,
    method: 'POST',
    headers: authHeaders(token, {
      'Content-Type': `multipart/related; boundary=${opts.boundary}`,
    }),
    body,
  }
}

/**
 * Multipart update replaces content while atomically renaming and tagging the
 * existing file, preserving Drive's revision history.
 */
export function buildUpdateFileRequest(
  token: string,
  fileId: string,
  opts: { name: string; content: string; artifact: string; boundary: string },
): DriveRequest {
  const metadata = JSON.stringify({
    name: opts.name,
    appProperties: { [DRIVE_ARTIFACT_PROPERTY]: opts.artifact },
  })
  const body =
    `--${opts.boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${metadata}\r\n` +
    `--${opts.boundary}\r\n` +
    `Content-Type: ${DRIVE_MARKDOWN_MIME}\r\n\r\n` +
    `${opts.content}\r\n` +
    `--${opts.boundary}--`
  return {
    url: `${DRIVE_UPLOAD_URL}/${encodeURIComponent(fileId)}?uploadType=multipart`,
    method: 'PATCH',
    headers: authHeaders(token, {
      'Content-Type': `multipart/related; boundary=${opts.boundary}`,
    }),
    body,
  }
}

/** SHA-256 identity key, short enough for Drive's private property limit. */
export async function sourceArtifactKey(sourceDocId: string): Promise<string> {
  return `${SOURCE_ARTIFACT_PREFIX}${await sha256Base64Url(sourceDocId)}`
}

/** Filesystem-safe Drive doc filename. The digest is presentation, never identity. */
export function docFileName(title: string, artifact: string): string {
  const digest = artifact.slice(
    SOURCE_ARTIFACT_PREFIX.length,
    SOURCE_ARTIFACT_PREFIX.length + SHORT_DIGEST_LENGTH,
  )
  const suffix = `--${digest}.md`
  const sanitized = sanitizeFilenameBase(title, MAX_FILENAME_LENGTH - suffix.length)
  const base = sanitized.length > 0 ? sanitized : 'untitled'
  return `${base}${suffix}`
}

export function legacyDocFileName(title: string): string {
  const sanitized = sanitizeFilenameBase(title, 100)
  const base = sanitized.length > 0 ? sanitized : 'untitled'
  return `${base}.md`
}
