import { describe, expect, it } from 'vitest'
import { captureSuccessBadge, decideBadge } from './badge'

describe('decideBadge', () => {
  it('clears the badge when nothing is capturable and the queue is empty', () => {
    expect(decideBadge(null, { queued: 0, failed: 0 })).toBeUndefined()
  })

  it('shows the capturable kind as a single letter', () => {
    expect(
      decideBadge(
        { kind: 'thread', label: 'Capture this thread', identity: 't-1' },
        { queued: 0, failed: 0 },
      ),
    ).toEqual({
      text: 'T',
      color: '#2563eb',
    })
    expect(
      decideBadge(
        { kind: 'playlist', label: 'Capture this playlist', identity: 'p-1' },
        { queued: 0, failed: 0 },
      ),
    ).toEqual({ text: 'P', color: '#2563eb' })
    expect(
      decideBadge(
        { kind: 'video', label: 'Capture this video', identity: 'v-1' },
        { queued: 0, failed: 0 },
      ),
    ).toEqual({
      text: 'V',
      color: '#2563eb',
    })
  })

  it('prefers a queued count over a capturable hint', () => {
    expect(
      decideBadge(
        { kind: 'thread', label: 'Capture this thread', identity: 't-1' },
        { queued: 3, failed: 0 },
      ),
    ).toEqual({ text: '3', color: '#6b7280' })
  })

  it('prefers a failed count over both queued and capturable', () => {
    expect(
      decideBadge(
        { kind: 'thread', label: 'Capture this thread', identity: 't-1' },
        { queued: 3, failed: 2 },
      ),
    ).toEqual({ text: '2', color: '#dc2626' })
  })

  it('shows a failed count even with an empty tab', () => {
    expect(decideBadge(null, { queued: 0, failed: 5 })).toEqual({ text: '5', color: '#dc2626' })
  })

  it('caps large counts instead of overflowing the badge', () => {
    expect(decideBadge(null, { queued: 0, failed: 140 })).toEqual({ text: '99+', color: '#dc2626' })
  })
})

describe('captureSuccessBadge', () => {
  it('is a fixed green checkmark', () => {
    expect(captureSuccessBadge()).toEqual({ text: '✓', color: '#16a34a' })
  })
})
