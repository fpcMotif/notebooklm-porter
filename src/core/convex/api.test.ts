import { describe, expect, it } from 'vitest'
import {
  convexMutationRequest,
  convexQueryRequest,
  isValidConvexUrl,
  normalizeConvexUrl,
  parseConvexResult,
} from './api'

describe('isValidConvexUrl', () => {
  it('accepts https deployment URLs', () => {
    expect(isValidConvexUrl('https://happy-otter-123.convex.cloud')).toBe(true)
    expect(isValidConvexUrl('  https://happy-otter-123.convex.cloud/  ')).toBe(true)
  })

  it('rejects non-https and non-URL values', () => {
    expect(isValidConvexUrl('http://happy-otter-123.convex.cloud')).toBe(false)
    expect(isValidConvexUrl('happy-otter-123.convex.cloud')).toBe(false)
    expect(isValidConvexUrl('not a url')).toBe(false)
    expect(isValidConvexUrl('')).toBe(false)
  })
})

describe('normalizeConvexUrl', () => {
  it('trims and strips trailing slashes', () => {
    expect(normalizeConvexUrl(' https://x.convex.cloud/// ')).toBe('https://x.convex.cloud')
    expect(normalizeConvexUrl('https://x.convex.cloud')).toBe('https://x.convex.cloud')
  })
})

describe('convex function requests', () => {
  it('builds a POST /api/query with a JSON-format body', () => {
    const request = convexQueryRequest('https://x.convex.cloud/', 'profiles:getLatestProfile', {})
    expect(request.url).toBe('https://x.convex.cloud/api/query')
    expect(request.init.method).toBe('POST')
    expect(request.init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(request.init.body ?? '')).toEqual({
      path: 'profiles:getLatestProfile',
      args: {},
      format: 'json',
    })
  })

  it('builds a POST /api/mutation carrying the args', () => {
    const request = convexMutationRequest('https://x.convex.cloud', 'kv:kvUpsert', {
      installId: 'i-1',
      rows: [{ key: 'a', value: 1, updatedAt: 5 }],
    })
    expect(request.url).toBe('https://x.convex.cloud/api/mutation')
    expect(JSON.parse(request.init.body ?? '')).toEqual({
      path: 'kv:kvUpsert',
      args: { installId: 'i-1', rows: [{ key: 'a', value: 1, updatedAt: 5 }] },
      format: 'json',
    })
  })
})

describe('parseConvexResult', () => {
  it('unwraps a success value', () => {
    expect(parseConvexResult({ status: 'success', value: { a: 1 } })).toEqual({
      ok: true,
      value: { a: 1 },
    })
    expect(parseConvexResult({ status: 'success', value: null })).toEqual({
      ok: true,
      value: null,
    })
  })

  it('surfaces the function error message', () => {
    expect(parseConvexResult({ status: 'error', errorMessage: 'boom' })).toEqual({
      ok: false,
      error: 'boom',
    })
    expect(parseConvexResult({ status: 'error' })).toEqual({
      ok: false,
      error: 'unknown Convex error',
    })
  })

  it('rejects unrecognized shapes', () => {
    expect(parseConvexResult(null).ok).toBe(false)
    expect(parseConvexResult('nope').ok).toBe(false)
    expect(parseConvexResult({ value: 1 }).ok).toBe(false)
  })
})
