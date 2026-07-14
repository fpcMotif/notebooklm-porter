import { describe, expect, it } from 'vitest'
import {
  buildAuthUrl,
  buildCreateFileRequest,
  buildCreateFolderRequest,
  buildFindFileRequest,
  buildFindFolderRequest,
  buildUpdateFileRequest,
  docFileName,
  parseAuthRedirect,
} from './drive'

describe('buildAuthUrl', () => {
  it('builds the implicit-grant auth URL with drive.file scope and account chooser', () => {
    const url = buildAuthUrl({
      clientId: 'client-123.apps.googleusercontent.com',
      redirectUri: 'https://abc.chromiumapp.org/',
    })
    const parsed = new URL(url)

    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(parsed.searchParams.get('client_id')).toBe('client-123.apps.googleusercontent.com')
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://abc.chromiumapp.org/')
    expect(parsed.searchParams.get('response_type')).toBe('token')
    expect(parsed.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file')
    expect(parsed.searchParams.get('prompt')).toBe('select_account')
  })

  it('URL-encodes special characters in the redirect URI', () => {
    const url = buildAuthUrl({
      clientId: 'client-123',
      redirectUri: 'https://abc.chromiumapp.org/callback?x=1&y=2',
    })
    expect(url).toContain(encodeURIComponent('https://abc.chromiumapp.org/callback?x=1&y=2'))
    expect(url).not.toContain('callback?x=1&y=2&')
  })
})

describe('parseAuthRedirect', () => {
  it('parses a happy-path fragment', () => {
    const result = parseAuthRedirect(
      'https://abc.chromiumapp.org/#access_token=ya29.abc123&expires_in=3599&token_type=Bearer',
    )
    expect(result).toEqual({ accessToken: 'ya29.abc123', expiresInSec: 3599 })
  })

  it('returns the oauth error when Google reports one', () => {
    const result = parseAuthRedirect('https://abc.chromiumapp.org/#error=access_denied&state=xyz')
    expect(result).toEqual({ error: 'access_denied' })
  })

  it('returns missing-fragment when there is no fragment at all', () => {
    const result = parseAuthRedirect('https://abc.chromiumapp.org/')
    expect(result).toEqual({ error: 'missing-fragment' })
  })

  it('returns missing-access-token when the fragment lacks a token', () => {
    const result = parseAuthRedirect('https://abc.chromiumapp.org/#expires_in=3599')
    expect(result).toEqual({ error: 'missing-access-token' })
  })

  it('returns missing-or-invalid-expires-in when expires_in is absent', () => {
    const result = parseAuthRedirect('https://abc.chromiumapp.org/#access_token=ya29.abc123')
    expect(result).toEqual({ error: 'missing-or-invalid-expires-in' })
  })

  it('returns missing-or-invalid-expires-in when expires_in is non-numeric', () => {
    const result = parseAuthRedirect(
      'https://abc.chromiumapp.org/#access_token=ya29.abc123&expires_in=not-a-number',
    )
    expect(result).toEqual({ error: 'missing-or-invalid-expires-in' })
  })

  it('returns invalid-redirect-url for a malformed URL', () => {
    const result = parseAuthRedirect('not a url at all')
    expect(result).toEqual({ error: 'invalid-redirect-url' })
  })

  it('handles an empty-string access_token as missing', () => {
    const result = parseAuthRedirect('https://abc.chromiumapp.org/#access_token=&expires_in=3599')
    expect(result).toEqual({ error: 'missing-access-token' })
  })
})

describe('buildFindFolderRequest', () => {
  it('builds a GET with the folder query and fields', () => {
    const req = buildFindFolderRequest('token-1', 'NotebookLM Porter')
    expect(req.method).toBe('GET')
    expect(req.headers.Authorization).toBe('Bearer token-1')

    const url = new URL(req.url)
    expect(url.origin + url.pathname).toBe('https://www.googleapis.com/drive/v3/files')
    expect(url.searchParams.get('q')).toBe(
      "name='NotebookLM Porter' and mimeType='application/vnd.google-apps.folder' and trashed=false",
    )
    expect(url.searchParams.get('fields')).toBe('files(id,name)')
    expect(req.body).toBeUndefined()
  })

  it('escapes single quotes in the folder name', () => {
    const req = buildFindFolderRequest('token-1', "Bob's Folder")
    const url = new URL(req.url)
    expect(url.searchParams.get('q')).toBe(
      "name='Bob\\'s Folder' and mimeType='application/vnd.google-apps.folder' and trashed=false",
    )
  })

  it('escapes backslashes in the folder name', () => {
    const req = buildFindFolderRequest('token-1', 'weird\\name')
    const url = new URL(req.url)
    expect(url.searchParams.get('q')).toBe(
      "name='weird\\\\name' and mimeType='application/vnd.google-apps.folder' and trashed=false",
    )
  })

  it('escapes backslashes before quotes to avoid double-escaping', () => {
    const req = buildFindFolderRequest('token-1', "a\\'b")
    const url = new URL(req.url)
    // Backslash escaped first (\\), then the quote (\') - so `\'` becomes `\\\'`.
    expect(url.searchParams.get('q')).toBe(
      "name='a\\\\\\'b' and mimeType='application/vnd.google-apps.folder' and trashed=false",
    )
  })
})

describe('buildCreateFolderRequest', () => {
  it('builds a POST with folder mimeType JSON body', () => {
    const req = buildCreateFolderRequest('token-1', 'NotebookLM Porter')
    expect(req.method).toBe('POST')
    expect(req.url).toBe('https://www.googleapis.com/drive/v3/files')
    expect(req.headers.Authorization).toBe('Bearer token-1')
    expect(req.headers['Content-Type']).toBe('application/json')
    expect(req.body).toBe(
      JSON.stringify({ name: 'NotebookLM Porter', mimeType: 'application/vnd.google-apps.folder' }),
    )
  })
})

describe('buildFindFileRequest', () => {
  it('builds a GET query scoped to name and parent folder', () => {
    const req = buildFindFileRequest('token-1', 'thread.md', 'folder-abc')
    expect(req.method).toBe('GET')
    const url = new URL(req.url)
    expect(url.searchParams.get('q')).toBe(
      "name='thread.md' and 'folder-abc' in parents and trashed=false",
    )
  })

  it('escapes single quotes in both name and folderId', () => {
    const req = buildFindFileRequest('token-1', "it's.md", "folder'id")
    const url = new URL(req.url)
    expect(url.searchParams.get('q')).toBe(
      "name='it\\'s.md' and 'folder\\'id' in parents and trashed=false",
    )
  })
})

describe('buildCreateFileRequest', () => {
  it('builds an exact frozen multipart body with the injected boundary', () => {
    const req = buildCreateFileRequest('token-1', {
      name: 'thread.md',
      folderId: 'folder-abc',
      content: '# Title\n\nBody text.',
      boundary: 'BOUNDARY123',
    })

    expect(req.method).toBe('POST')
    expect(req.url).toBe('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart')
    expect(req.headers.Authorization).toBe('Bearer token-1')
    expect(req.headers['Content-Type']).toBe('multipart/related; boundary=BOUNDARY123')

    const metadata = JSON.stringify({ name: 'thread.md', parents: ['folder-abc'] })
    const expectedBody =
      `--BOUNDARY123\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadata}\r\n` +
      `--BOUNDARY123\r\n` +
      `Content-Type: text/markdown\r\n\r\n` +
      `# Title\n\nBody text.\r\n` +
      `--BOUNDARY123--`

    expect(req.body).toBe(expectedBody)
  })
})

describe('buildUpdateFileRequest', () => {
  it('builds a PATCH to the media upload endpoint with text/markdown body', () => {
    const req = buildUpdateFileRequest('token-1', 'file-xyz', '# Updated\n\nNew body.')
    expect(req.method).toBe('PATCH')
    expect(req.url).toBe(
      'https://www.googleapis.com/upload/drive/v3/files/file-xyz?uploadType=media',
    )
    expect(req.headers.Authorization).toBe('Bearer token-1')
    expect(req.headers['Content-Type']).toBe('text/markdown')
    expect(req.body).toBe('# Updated\n\nNew body.')
  })
})

describe('docFileName', () => {
  it('appends .md to a simple title', () => {
    expect(docFileName('My Great Thread')).toBe('My Great Thread.md')
  })

  it('replaces path separators and Windows-reserved glyphs with a hyphen', () => {
    expect(docFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j.md')
  })

  it('collapses whitespace runs', () => {
    expect(docFileName('too    many     spaces')).toBe('too many spaces.md')
  })

  it('trims leading/trailing whitespace', () => {
    expect(docFileName('   padded   ')).toBe('padded.md')
  })

  it('falls back to untitled for an empty title', () => {
    expect(docFileName('')).toBe('untitled.md')
  })

  it('falls back to untitled for a whitespace-only title', () => {
    expect(docFileName('   \t\n  ')).toBe('untitled.md')
  })

  it('caps length to ~100 chars', () => {
    const longTitle = 'x'.repeat(300)
    const result = docFileName(longTitle)
    expect(result).toBe('x'.repeat(100) + '.md')
  })

  it('leaves emoji and unicode letters intact', () => {
    expect(docFileName('🚀 Launch 日本語')).toBe('🚀 Launch 日本語.md')
  })
})
