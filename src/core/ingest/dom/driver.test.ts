import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { makeDomTabs, notebookTabUrl } from './driver'

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
