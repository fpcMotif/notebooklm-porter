import { Effect } from 'effect'
import type { FetchError, HttpStatusError, ProtocolDrift, RpcRefused } from '../fx/errors'
import { IpcError, NotLoggedIn } from '../fx/errors'
import type { DebugLog, Http } from '../fx/services'
import { fetchSession, listNotebooks, type NblmSession } from '../ingest/rpc/client'

interface AccountBindingSettingsSnapshot {
  readonly nblmAuthuser: number
  readonly accounts: readonly {
    readonly authuser: number
    readonly email: string
  }[]
}

export interface AuthenticatedNotebookLmAccount {
  readonly authuser: number
  readonly email: string
  readonly session: NblmSession
}

export interface NotebookLmAccountBinding {
  readonly authuser: number
  readonly accountEmail: string
}

export interface NotebookTarget extends NotebookLmAccountBinding {
  readonly notebookId: string
}

/** Canonical, collision-safe scope for durable work owned by one notebook target. */
export function notebookTargetKey(target: NotebookTarget): string {
  return JSON.stringify([
    'notebook-target:v1',
    target.authuser,
    target.accountEmail,
    target.notebookId,
  ])
}

export interface VerifiedNotebookTarget {
  readonly account: AuthenticatedNotebookLmAccount
  readonly target: NotebookTarget
}

export type BoundAccountAuthentication =
  | { readonly status: 'authenticated'; readonly account: AuthenticatedNotebookLmAccount }
  | { readonly status: 'account-changed' }

/** Snapshots the observed identity for the active positional slot. */
export function accountBindingFor(
  settings: AccountBindingSettingsSnapshot,
): NotebookLmAccountBinding | undefined {
  const account = settings.accounts.find(
    (candidate) => candidate.authuser === settings.nblmAuthuser,
  )
  return account === undefined || account.email.trim() === ''
    ? undefined
    : { authuser: settings.nblmAuthuser, accountEmail: account.email }
}

/** Snapshots one concrete notebook under the active observed identity. */
export function notebookTargetFor(
  settings: AccountBindingSettingsSnapshot,
  notebookId: string,
): NotebookTarget | undefined {
  if (notebookId === '') return undefined
  const binding = accountBindingFor(settings)
  return binding === undefined ? undefined : { ...binding, notebookId }
}

export function sameAccountBinding(
  left: NotebookLmAccountBinding,
  right: NotebookLmAccountBinding,
): boolean {
  return left.authuser === right.authuser && left.accountEmail === right.accountEmail
}

export function sameNotebookTarget(left: NotebookTarget, right: NotebookTarget): boolean {
  return notebookTargetKey(left) === notebookTargetKey(right)
}

/** Re-authenticates an immutable stored binding without consulting current selection. */
export function authenticateBoundAccount(
  binding: NotebookLmAccountBinding,
): Effect.Effect<
  BoundAccountAuthentication,
  FetchError | HttpStatusError | NotLoggedIn,
  Http | DebugLog
> {
  return Effect.gen(function* () {
    const session = yield* fetchSession(binding.authuser)
    if (session.email === undefined || session.email !== binding.accountEmail) {
      return { status: 'account-changed' }
    }
    return {
      status: 'authenticated',
      account: {
        authuser: binding.authuser,
        email: session.email,
        session,
      },
    }
  })
}

/** Re-authenticates an immutable target and proves current notebook membership. */
export function verifyNotebookTarget(
  target: NotebookTarget,
): Effect.Effect<
  VerifiedNotebookTarget,
  FetchError | HttpStatusError | IpcError | NotLoggedIn | ProtocolDrift | RpcRefused,
  Http | DebugLog
> {
  return Effect.gen(function* () {
    const authentication = yield* authenticateBoundAccount(target)
    if (authentication.status === 'account-changed') {
      return yield* Effect.fail(new NotLoggedIn({ authuser: target.authuser }))
    }
    const notebooks = yield* listNotebooks(
      authentication.account.session,
      authentication.account.authuser,
    )
    if (!notebooks.some((notebook) => notebook.id === target.notebookId)) {
      return yield* Effect.fail(
        new IpcError({ reason: 'Choose a notebook from the current account' }),
      )
    }
    return {
      account: authentication.account,
      target: { ...target },
    }
  })
}
