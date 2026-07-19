import { assert, describe, it } from '@effect/vitest'
import {
  STICKY_ROUTE_LIMIT,
  preferredRoute,
  preferredRouteForDocs,
  recordRoute,
  stickyRouteKey,
} from './sticky'

function target(notebookId: string, authuser = 0, updatedAt = '2026-01-01T00:00:00.000Z') {
  return { notebookId, authuser, updatedAt }
}

describe('stickyRouteKey', () => {
  it('keys non-web sites by SiteId', () => {
    assert.strictEqual(stickyRouteKey('youtube', 'https://youtube.com/playlist?list=x'), 'youtube')
    assert.strictEqual(stickyRouteKey('reddit', 'https://reddit.com/r/x'), 'reddit')
  })

  it('keys web captures by hostname so distinct domains do not collide', () => {
    assert.strictEqual(stickyRouteKey('web', 'https://example.com/a/b'), 'example.com')
    assert.strictEqual(stickyRouteKey('web', 'https://other.example.com/x'), 'other.example.com')
  })

  it('falls back to the site id for an unparsable web url', () => {
    assert.strictEqual(stickyRouteKey('web', 'not a url'), 'web')
  })
})

describe('recordRoute / preferredRoute', () => {
  it('is empty for a site with no recorded route', () => {
    assert.isUndefined(preferredRoute({}, 'youtube'))
  })

  it('records a new route', () => {
    const map = recordRoute({}, 'youtube', target('nb-1'))
    assert.deepStrictEqual(preferredRoute(map, 'youtube'), target('nb-1'))
  })

  it('overwrites an existing route for the same site, leaving others untouched', () => {
    let map = recordRoute({}, 'youtube', target('nb-1', 0, '2026-01-01T00:00:00.000Z'))
    map = recordRoute(map, 'reddit', target('nb-2', 0, '2026-01-01T00:00:00.000Z'))
    map = recordRoute(map, 'youtube', target('nb-3', 1, '2026-01-02T00:00:00.000Z'))

    assert.deepStrictEqual(
      preferredRoute(map, 'youtube'),
      target('nb-3', 1, '2026-01-02T00:00:00.000Z'),
    )
    assert.deepStrictEqual(
      preferredRoute(map, 'reddit'),
      target('nb-2', 0, '2026-01-01T00:00:00.000Z'),
    )
  })

  it('returns undefined for a site that was never recorded, even with other sites present', () => {
    const map = recordRoute({}, 'youtube', target('nb-1'))
    assert.isUndefined(preferredRoute(map, 'hackernews'))
  })

  it('evicts the single least-recently-updated OTHER entry once the map exceeds the bound', () => {
    let map: Record<string, ReturnType<typeof target>> = {}
    for (let i = 0; i < STICKY_ROUTE_LIMIT; i += 1) {
      map = recordRoute(
        map,
        `site-${i}`,
        target(`nb-${i}`, 0, `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`),
      )
    }
    assert.strictEqual(Object.keys(map).length, STICKY_ROUTE_LIMIT)

    // site-0 has the oldest updatedAt, so the next insert should evict it.
    map = recordRoute(map, 'site-new', target('nb-new', 0, '2026-01-01T01:00:00.000Z'))

    assert.strictEqual(Object.keys(map).length, STICKY_ROUTE_LIMIT)
    assert.isUndefined(preferredRoute(map, 'site-0'))
    assert.isDefined(preferredRoute(map, 'site-1'))
    assert.deepStrictEqual(
      preferredRoute(map, 'site-new'),
      target('nb-new', 0, '2026-01-01T01:00:00.000Z'),
    )
  })

  it('stays bounded across repeated evictions', () => {
    let map: Record<string, ReturnType<typeof target>> = {}
    for (let i = 0; i < STICKY_ROUTE_LIMIT + 20; i += 1) {
      map = recordRoute(
        map,
        `site-${i}`,
        target(`nb-${i}`, 0, `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`),
      )
    }
    assert.strictEqual(Object.keys(map).length, STICKY_ROUTE_LIMIT)
    // The most recently written entries all survive.
    assert.isDefined(preferredRoute(map, `site-${STICKY_ROUTE_LIMIT + 19}`))
  })
})

describe('preferredRouteForDocs', () => {
  it('returns undefined for an empty doc set', () => {
    assert.isUndefined(preferredRouteForDocs({}, []))
  })

  it('returns the shared target when every doc agrees', () => {
    const map = recordRoute({}, 'youtube', target('nb-1', 2))
    assert.deepStrictEqual(
      preferredRouteForDocs(map, [{ site: 'youtube', canonicalUrl: 'https://youtube.com/a' }]),
      target('nb-1', 2),
    )
  })

  it('returns undefined when any doc has no sticky entry', () => {
    const map = recordRoute({}, 'youtube', target('nb-1'))
    assert.isUndefined(
      preferredRouteForDocs(map, [
        { site: 'youtube', canonicalUrl: 'https://youtube.com/a' },
        { site: 'reddit', canonicalUrl: 'https://reddit.com/r/x' },
      ]),
    )
  })

  it('returns undefined when docs disagree on notebook or account', () => {
    let map = recordRoute({}, 'youtube', target('nb-1', 0))
    map = recordRoute(map, 'reddit', target('nb-2', 0))
    assert.isUndefined(
      preferredRouteForDocs(map, [
        { site: 'youtube', canonicalUrl: 'https://youtube.com/a' },
        { site: 'reddit', canonicalUrl: 'https://reddit.com/r/x' },
      ]),
    )
  })
})
