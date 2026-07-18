import { assert, describe, it } from '@effect/vitest'
import { Effect, Result } from 'effect'
import { AlarmError, FetchError, HttpStatusError, IpcError } from './errors'
import {
  makeAlarms,
  makeDomTabs,
  makeHttp,
  makeScripting,
  makeTabs,
  notebookTabUrl,
} from './services'

const domRequest = {
  notebookId: 'nb-1',
  authuser: 2,
  unit: {
    kind: 'text' as const,
    docId: 'reddit:1',
    id: 'reddit:1',
    contentHash: 'hash',
    title: 'Thread',
    markdown: '# Thread',
  },
}

function fakeFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return impl as unknown as typeof fetch
}

describe('makeHttp', () => {
  it.effect('text() resolves on a 200 response', () =>
    Effect.gen(function* () {
      const http = makeHttp(fakeFetch(async () => new Response('hello', { status: 200 })))
      const body = yield* http.text('https://example.com')
      assert.strictEqual(body, 'hello')
    }),
  )

  it.effect('json() resolves parsed JSON on a 200 response', () =>
    Effect.gen(function* () {
      const http = makeHttp(
        fakeFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
      )
      const body = yield* http.json('https://example.com')
      assert.deepStrictEqual(body, { ok: true })
    }),
  )

  it.effect('maps a rejected fetch to FetchError', () =>
    Effect.gen(function* () {
      const http = makeHttp(
        fakeFetch(async () => {
          throw new Error('network down')
        }),
      )
      const result = yield* Effect.result(http.text('https://example.com'))
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, FetchError)
        assert.strictEqual(result.failure.url, 'https://example.com')
      }
    }),
  )

  it.effect('maps a non-ok response to HttpStatusError', () =>
    Effect.gen(function* () {
      const http = makeHttp(fakeFetch(async () => new Response('nope', { status: 500 })))
      const result = yield* Effect.result(http.text('https://example.com'))
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, HttpStatusError)
        assert.strictEqual(result.failure.status, 500)
      }
    }),
  )

  it.effect('maps a rejected .json() body read to FetchError', () =>
    Effect.gen(function* () {
      const http = makeHttp(fakeFetch(async () => new Response('not json', { status: 200 })))
      const result = yield* Effect.result(http.json('https://example.com'))
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, FetchError)
      }
    }),
  )
})

describe('makeAlarms', () => {
  it.effect('schedules and clears named alarms', () =>
    Effect.gen(function* () {
      const calls: unknown[][] = []
      const alarms = makeAlarms({
        create: async (name, info) => {
          calls.push(['create', name, info])
        },
        clear: async (name) => {
          calls.push(['clear', name])
          return true
        },
      })

      yield* alarms.schedule('porter/ingest-drain', 1234)
      const cleared = yield* alarms.clear('porter/ingest-drain')

      assert.isTrue(cleared)
      assert.deepStrictEqual(calls, [
        ['create', 'porter/ingest-drain', { when: 1234 }],
        ['clear', 'porter/ingest-drain'],
      ])
    }),
  )

  it.effect('maps alarm API failures to AlarmError with the operation', () =>
    Effect.gen(function* () {
      const alarms = makeAlarms({
        create: async () => {
          throw new Error('not allowed')
        },
        clear: async () => {
          throw new Error('not allowed')
        },
      })

      const scheduled = yield* Effect.result(alarms.schedule('porter/ingest-drain', 1234))
      const cleared = yield* Effect.result(alarms.clear('porter/ingest-drain'))

      assert.isTrue(Result.isFailure(scheduled))
      assert.isTrue(Result.isFailure(cleared))
      if (Result.isFailure(scheduled)) {
        assert.instanceOf(scheduled.failure, AlarmError)
        assert.strictEqual(scheduled.failure.operation, 'schedule')
      }
      if (Result.isFailure(cleared)) {
        assert.instanceOf(cleared.failure, AlarmError)
        assert.strictEqual(cleared.failure.operation, 'clear')
      }
    }),
  )
})

describe('makeScripting', () => {
  it.effect('returns the first injected page result', () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const scripting = makeScripting({
        executeScript: async (details) => {
          calls.push(details)
          return [{ result: { title: 'Article', text: 'Readable text' } }]
        },
      })

      const page = yield* scripting.extractPageText(42)

      assert.deepStrictEqual(page, { title: 'Article', text: 'Readable text' })
      assert.strictEqual(calls.length, 1)
    }),
  )

  it.effect('maps a missing injected result to IpcError', () =>
    Effect.gen(function* () {
      const scripting = makeScripting({ executeScript: async () => [] })
      const result = yield* Effect.result(scripting.extractPageText(42))

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, IpcError)
    }),
  )
})

describe('makeTabs', () => {
  it.effect('reports the active tab id and url when both are present', () =>
    Effect.gen(function* () {
      const tabs = makeTabs({
        query: async () => [{ id: 7, url: 'https://example.com' }],
        sendMessage: async () => 'unused',
      })

      const tab = yield* tabs.activeTab()

      assert.deepStrictEqual(tab, { id: 7, url: 'https://example.com' })
    }),
  )

  it.effect('omits id and url fields entirely when the active tab reports neither', () =>
    Effect.gen(function* () {
      const tabs = makeTabs({
        query: async () => [{}],
        sendMessage: async () => 'unused',
      })

      const tab = yield* tabs.activeTab()

      assert.deepStrictEqual(tab, {})
      assert.isFalse('id' in tab)
      assert.isFalse('url' in tab)
    }),
  )

  it.effect('maps a rejected tabs.query to IpcError', () =>
    Effect.gen(function* () {
      const tabs = makeTabs({
        query: async () => {
          throw new Error('no active tab')
        },
        sendMessage: async () => 'unused',
      })

      const result = yield* Effect.result(tabs.activeTab())

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, IpcError)
    }),
  )

  it.effect('maps a rejected tabs.sendMessage to IpcError', () =>
    Effect.gen(function* () {
      const tabs = makeTabs({
        query: async () => [],
        sendMessage: async () => {
          throw new Error('receiving end does not exist')
        },
      })

      const result = yield* Effect.result(tabs.sendMessage(42, { type: 'ping' }))

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, IpcError)
    }),
  )

  it.effect('relays a successful tabs.sendMessage response', () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const tabs = makeTabs({
        query: async () => [],
        sendMessage: async (tabId, message) => {
          calls.push([tabId, message])
          return { ok: true }
        },
      })

      const response = yield* tabs.sendMessage(42, { type: 'ping' })

      assert.deepStrictEqual(response, { ok: true })
      assert.deepStrictEqual(calls, [[42, { type: 'ping' }]])
    }),
  )
})

describe('makeDomTabs', () => {
  it.effect('opens the exact target notebook visibly and relays one immutable unit', () =>
    Effect.gen(function* () {
      const calls: unknown[] = []
      const domTabs = makeDomTabs({
        query: async (query) => {
          calls.push(['query', query])
          return []
        },
        create: async (details) => {
          calls.push(['create', details])
          return { id: 42 }
        },
        sendMessage: async (tabId, message) => {
          calls.push(['sendMessage', tabId, message])
          return { status: 'sent' }
        },
      })

      const result = yield* domTabs.deliver(domRequest)

      assert.deepStrictEqual(result, { status: 'sent' })
      assert.deepStrictEqual(calls, [
        ['query', { url: 'https://notebooklm.google.com/notebook/nb-1*' }],
        ['create', { active: true, url: notebookTabUrl('nb-1', 2) }],
        ['sendMessage', 42, { type: 'porter/dom-deliver', request: domRequest }],
      ])
    }),
  )

  it.live('is conservative when relay transport or the returned shape is not proven safe', () =>
    Effect.gen(function* () {
      const malformed = makeDomTabs({
        query: async () => [{ id: 42 }],
        create: async () => ({ id: 43 }),
        sendMessage: async () => ({ ok: true }),
      })
      const missingReceiver = makeDomTabs({
        query: async () => [{ id: 42 }],
        create: async () => ({ id: 43 }),
        sendMessage: async () => {
          throw new Error('Could not establish connection. Receiving end does not exist.')
        },
      })
      const interrupted = makeDomTabs({
        query: async () => [{ id: 42 }],
        create: async () => ({ id: 43 }),
        sendMessage: async () => {
          throw new Error('tab closed')
        },
      })

      assert.deepStrictEqual(yield* malformed.deliver(domRequest), {
        status: 'uncertain',
        reason: 'NotebookLM DOM relay returned an invalid response',
      })
      assert.deepStrictEqual(yield* missingReceiver.deliver(domRequest), {
        status: 'unavailable',
        reason: 'NotebookLM DOM assist is not loaded in the target tab',
      })
      const interruptedResult = yield* interrupted.deliver(domRequest)
      assert.strictEqual(interruptedResult.status, 'uncertain')
    }),
  )
})
