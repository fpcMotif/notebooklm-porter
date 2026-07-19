import { describe, expect, it } from 'vitest'
import {
  emptyDrainBurstCounts,
  formatDrainBurstNotification,
  shouldNotifyDrainBurst,
} from './notify'

describe('shouldNotifyDrainBurst', () => {
  it('is false for an idle/all-clear burst', () => {
    expect(shouldNotifyDrainBurst(emptyDrainBurstCounts())).toBe(false)
    expect(shouldNotifyDrainBurst({ ...emptyDrainBurstCounts(), sent: 4 })).toBe(false)
  })

  it('is true once sent reaches the threshold', () => {
    expect(shouldNotifyDrainBurst({ ...emptyDrainBurstCounts(), sent: 5 })).toBe(true)
  })

  it('is true for any trouble, even a single job', () => {
    expect(shouldNotifyDrainBurst({ ...emptyDrainBurstCounts(), failed: 1 })).toBe(true)
    expect(shouldNotifyDrainBurst({ ...emptyDrainBurstCounts(), blocked: 1 })).toBe(true)
    expect(shouldNotifyDrainBurst({ ...emptyDrainBurstCounts(), uncertain: 1 })).toBe(true)
  })
})

describe('formatDrainBurstNotification', () => {
  it('returns undefined when the burst is not notification-worthy', () => {
    expect(formatDrainBurstNotification(emptyDrainBurstCounts())).toBeUndefined()
  })

  it('formats a mixed sent/failed burst', () => {
    expect(
      formatDrainBurstNotification({ ...emptyDrainBurstCounts(), sent: 7, failed: 2 }),
    ).toEqual({ title: 'NotebookLM Porter', message: 'Porter: 7 synced, 2 failed' })
  })

  it('formats a trouble-only burst', () => {
    expect(
      formatDrainBurstNotification({ ...emptyDrainBurstCounts(), blocked: 1, uncertain: 1 }),
    ).toEqual({ title: 'NotebookLM Porter', message: 'Porter: 1 blocked, 1 uncertain' })
  })

  it('formats an all-sent burst at threshold', () => {
    expect(formatDrainBurstNotification({ ...emptyDrainBurstCounts(), sent: 5 })).toEqual({
      title: 'NotebookLM Porter',
      message: 'Porter: 5 synced',
    })
  })
})
