import { describe, expect, it } from 'vitest'
import type { NotebookTarget } from '../accounts/ownership'
import type { WatchView } from '../watch/watch'
import { watchForTarget, watchTargetLabel } from './watches'

const targetA: NotebookTarget = {
  authuser: 0,
  accountEmail: 'a@example.com',
  notebookId: 'shared-id',
}
const targetB: NotebookTarget = {
  authuser: 1,
  accountEmail: 'b@example.com',
  notebookId: 'shared-id',
}

function watch(target: NotebookTarget): WatchView {
  return {
    id: target.accountEmail,
    sourceDocId: 'reddit:one',
    target: { ...target },
    status: 'active',
    nextRunAt: 'never',
  }
}

describe('popup watch target projection', () => {
  it('keeps same-id watches separate across accounts so B can create its own watch', () => {
    const watches = [watch(targetA)]

    expect(watchForTarget(watches, 'reddit:one', targetB)).toBeUndefined()

    const withB = [...watches, watch(targetB)]
    expect(watchForTarget(withB, 'reddit:one', targetB)?.target).toEqual(targetB)
  })

  it('uses catalog titles only for the current account', () => {
    const otherAccountWatch = watch(targetA)
    const currentAccountWatch = watch(targetB)
    const notebooks = [{ id: 'shared-id', title: 'B notebook' }]

    expect(watchTargetLabel(otherAccountWatch, targetB, notebooks)).toBe('shared-id')
    expect(watchTargetLabel(currentAccountWatch, targetB, notebooks)).toBe('B notebook')
  })
})
