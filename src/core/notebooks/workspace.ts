import { Effect, Result } from 'effect'
import {
  accountBindingFor,
  notebookTargetFor,
  sameNotebookTarget,
  type NotebookLmAccountBinding,
  type NotebookTarget,
} from '../accounts/ownership'
import type { IpcError } from '../fx/errors'
import type { ConsoleScan } from '../ingest/sources/console'
import { PorterClient, type PorterClientShape } from '../messaging'
import type { SiteId } from '../model/types'
import { preferredRouteForDocs } from '../routing/sticky'
import { DEFAULT_SETTINGS, resolveNotebookTarget, type PorterSettings } from '../settings'
import type { NotebookMeta } from './model'

export interface NotebookWorkspacePending {
  readonly bootstrap: boolean
  readonly refresh: boolean
  readonly discover: boolean
  readonly switchAccount: boolean
  readonly create: boolean
  readonly driveUpdate: boolean
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T

export type SourceConsoleOperation = 'scan' | 'dedupe' | 'retry'

export interface SourceConsoleSnapshot {
  readonly scan: DeepReadonly<ConsoleScan> | undefined
  readonly status: string | undefined
  readonly pending: SourceConsoleOperation | undefined
}

export interface NotebookWorkspaceSnapshot {
  readonly settings: DeepReadonly<PorterSettings>
  readonly notebooks: readonly DeepReadonly<NotebookMeta>[]
  readonly selectedNotebookId: string
  readonly newNotebookTitle: string
  readonly error: string | undefined
  readonly driveError: string | undefined
  readonly pending: NotebookWorkspacePending
  readonly sourceConsole: SourceConsoleSnapshot
  /** True while the current selection is a sticky route the user hasn't overridden — drives the "remembered" hint. */
  readonly stickyPreselected: boolean
  /** A still-known account the staged docs' sticky route lives on, when it differs from the active one; the popup switches to it. */
  readonly pendingAccountSwitch: number | undefined
}

export interface NotebookWorkspace {
  readonly snapshot: () => NotebookWorkspaceSnapshot
  readonly subscribe: (listener: (snapshot: NotebookWorkspaceSnapshot) => void) => () => void
  readonly updateDocs: (docs: readonly { site: SiteId; canonicalUrl?: string }[]) => void
  /** Rejects a popup-open bootstrap without disturbing user-dispatched operations. */
  readonly supersedeBootstrap: () => void
  /** Marks that the user has taken manual control of the target, halting sticky preselection and auto account-switching for the session. */
  readonly markManualTarget: () => void
  readonly selectNotebook: (notebookId: string) => void
  readonly editNewNotebookTitle: (title: string) => void
  readonly bootstrap: () => Effect.Effect<void, never, PorterClient>
  readonly refreshNotebooks: () => Effect.Effect<void, never, PorterClient>
  readonly discoverAccounts: () => Effect.Effect<void, never, PorterClient>
  readonly switchAccount: (authuser: number) => Effect.Effect<void, never, PorterClient>
  readonly createNotebook: () => Effect.Effect<void, never, PorterClient>
  readonly updateDriveClientId: (driveClientId: string) => Effect.Effect<void, never, PorterClient>
  readonly updateAutoExportVault: (
    autoExportVault: boolean,
  ) => Effect.Effect<void, never, PorterClient>
  readonly updateConvexUrl: (convexUrl: string) => Effect.Effect<void, never, PorterClient>
  readonly scanSourceConsole: () => Effect.Effect<void, never, PorterClient>
  readonly removeSourceDuplicates: () => Effect.Effect<void, never, PorterClient>
  readonly retrySource: (sourceId: string) => Effect.Effect<void, never, PorterClient>
}

type AccountOperation = 'bootstrap' | 'discover' | 'switchAccount'
type NotebookOperation = 'refresh' | 'create'

interface AccountGeneration {
  readonly account: number
  readonly bootstrap: number | undefined
}

interface NotebookGeneration extends AccountGeneration {
  readonly notebook: number
  readonly binding: NotebookLmAccountBinding
}

interface SourceConsoleGeneration {
  readonly sourceConsole: number
  readonly target: NotebookTarget
}

function copySettings(settings: PorterSettings): DeepReadonly<PorterSettings> {
  return {
    ...settings,
    accounts: settings.accounts.map((account) => ({ ...account })),
    notebookTargets: { ...settings.notebookTargets },
    stickyRoutes: { ...settings.stickyRoutes },
  }
}

function initialSettings(): DeepReadonly<PorterSettings> {
  return copySettings({
    ...DEFAULT_SETTINGS,
    accounts: [],
    notebookTargets: {},
    stickyRoutes: {},
  })
}

function initialPending(): NotebookWorkspacePending {
  return {
    bootstrap: false,
    refresh: false,
    discover: false,
    switchAccount: false,
    create: false,
    driveUpdate: false,
  }
}

function initialSourceConsole(): SourceConsoleSnapshot {
  return { scan: undefined, status: undefined, pending: undefined }
}

function activeEmail(settings: DeepReadonly<PorterSettings>): string | undefined {
  return settings.accounts.find((account) => account.authuser === settings.nblmAuthuser)?.email
}

function copyConsoleScan(scan: ConsoleScan): DeepReadonly<ConsoleScan> {
  return {
    sources: scan.sources.map((source) => ({ ...source })),
    duplicateGroups: scan.duplicateGroups.map((group) => ({
      key: group.key,
      keep: { ...group.keep },
      remove: group.remove.map((source) => ({ ...source })),
    })),
    failed: scan.failed.map((diagnosis) => ({
      source: { ...diagnosis.source },
      reason: diagnosis.reason,
      retry: diagnosis.retry,
    })),
    duplicateCount: scan.duplicateCount,
  }
}

function sourceConsoleTarget(snapshot: NotebookWorkspaceSnapshot): NotebookTarget | undefined {
  return notebookTargetFor(snapshot.settings, snapshot.selectedNotebookId)
}

function sameOptionalNotebookTarget(
  left: NotebookTarget | undefined,
  right: NotebookTarget | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return sameNotebookTarget(left, right)
}

/**
 * Owns the popup's account, catalog, and notebook-selection workflow.
 * Preact only subscribes and renders; request ordering and stale-result policy stay here.
 */
export function makeNotebookWorkspace(): NotebookWorkspace {
  let state: NotebookWorkspaceSnapshot = {
    settings: initialSettings(),
    notebooks: [],
    selectedNotebookId: '',
    newNotebookTitle: '',
    error: undefined,
    driveError: undefined,
    pending: initialPending(),
    sourceConsole: initialSourceConsole(),
    stickyPreselected: false,
    pendingAccountSwitch: undefined,
  }
  let docs: readonly { site: SiteId; canonicalUrl: string }[] = []
  // Sticky routing: once the user touches the notebook picker themselves, the
  // remembered route stops preselecting for the rest of this popup session.
  let manualNotebookPick = false
  let accountGeneration = 0
  let bootstrapGeneration = 0
  let activeBootstrap: number | undefined
  let notebookGeneration = 0
  let driveGeneration = 0
  let draftGeneration = 0
  let sourceConsoleGeneration = 0
  let activeSourceConsole:
    | { readonly generation: number; readonly operation: SourceConsoleOperation }
    | undefined
  let hasLocalDriveClientId = false
  const listeners = new Set<(snapshot: NotebookWorkspaceSnapshot) => void>()

  /** Whether the current selection is the sticky route the user hasn't overridden — the "remembered" hint. */
  function stickyPreselectedFor(next: NotebookWorkspaceSnapshot): boolean {
    if (manualNotebookPick || next.selectedNotebookId === '') return false
    const preferred = preferredRouteForDocs(next.settings.stickyRoutes, docs)
    return preferred !== undefined && preferred.notebookId === next.selectedNotebookId
  }

  /** A still-known account the staged docs' sticky route lives on, when it differs from the active one. */
  function pendingAccountSwitchFor(next: NotebookWorkspaceSnapshot): number | undefined {
    if (
      manualNotebookPick ||
      next.pending.bootstrap ||
      next.pending.discover ||
      next.pending.switchAccount
    ) {
      return undefined
    }
    const preferred = preferredRouteForDocs(next.settings.stickyRoutes, docs)
    if (preferred === undefined || preferred.authuser === next.settings.nblmAuthuser) {
      return undefined
    }
    return next.settings.accounts.some((account) => account.authuser === preferred.authuser)
      ? preferred.authuser
      : undefined
  }

  function withStickyRouting(next: NotebookWorkspaceSnapshot): NotebookWorkspaceSnapshot {
    const stickyPreselected = stickyPreselectedFor(next)
    const pendingAccountSwitch = pendingAccountSwitchFor(next)
    if (
      next.stickyPreselected === stickyPreselected &&
      next.pendingAccountSwitch === pendingAccountSwitch
    ) {
      return next
    }
    return { ...next, stickyPreselected, pendingAccountSwitch }
  }

  function publish(raw: NotebookWorkspaceSnapshot): void {
    const next = withStickyRouting(raw)
    if (!sameOptionalNotebookTarget(sourceConsoleTarget(state), sourceConsoleTarget(next))) {
      sourceConsoleGeneration += 1
      state = {
        ...next,
        sourceConsole: {
          ...initialSourceConsole(),
          pending: activeSourceConsole?.operation,
        },
      }
    } else {
      state = next
    }
    for (const listener of listeners) listener(state)
  }

  function patch(next: Partial<NotebookWorkspaceSnapshot>): void {
    publish({ ...state, ...next })
  }

  function setPending(next: Partial<NotebookWorkspacePending>): void {
    patch({ pending: { ...state.pending, ...next } })
  }

  function accountOperationPending(): boolean {
    return state.pending.bootstrap || state.pending.discover || state.pending.switchAccount
  }

  function beginAccount(operation: AccountOperation): AccountGeneration | undefined {
    if (state.pending.create || activeSourceConsole !== undefined) return undefined
    accountGeneration += 1
    if (operation === 'bootstrap') {
      bootstrapGeneration += 1
      activeBootstrap = bootstrapGeneration
    } else {
      activeBootstrap = undefined
    }
    notebookGeneration += 1
    sourceConsoleGeneration += 1
    patch({
      error: undefined,
      sourceConsole: initialSourceConsole(),
      pending: {
        ...initialPending(),
        driveUpdate: state.pending.driveUpdate,
        [operation]: true,
      },
    })
    return {
      account: accountGeneration,
      bootstrap: operation === 'bootstrap' ? activeBootstrap : undefined,
    }
  }

  function isCurrentAccount(operation: AccountOperation, generation: AccountGeneration): boolean {
    return (
      generation.account === accountGeneration &&
      (operation !== 'bootstrap' || generation.bootstrap === activeBootstrap)
    )
  }

  function finishAccount(operation: AccountOperation, generation: AccountGeneration): void {
    if (!isCurrentAccount(operation, generation)) return
    if (operation === 'bootstrap') activeBootstrap = undefined
    setPending({ [operation]: false })
  }

  function beginNotebook(operation: NotebookOperation): NotebookGeneration | undefined {
    const binding = accountBindingFor(state.settings)
    if (
      binding === undefined ||
      accountOperationPending() ||
      activeSourceConsole !== undefined ||
      state.pending.create ||
      (operation === 'create' && state.pending.refresh)
    ) {
      return undefined
    }
    notebookGeneration += 1
    patch({
      error: undefined,
      pending: {
        ...state.pending,
        refresh: false,
        create: false,
        [operation]: true,
      },
    })
    return {
      account: accountGeneration,
      bootstrap: undefined,
      notebook: notebookGeneration,
      binding,
    }
  }

  function isCurrentNotebook(generation: NotebookGeneration): boolean {
    return generation.account === accountGeneration && generation.notebook === notebookGeneration
  }

  function finishNotebook(operation: NotebookOperation, generation: NotebookGeneration): void {
    if (isCurrentNotebook(generation)) setPending({ [operation]: false })
  }

  function preserveLocalDriveClientId(settings: PorterSettings): DeepReadonly<PorterSettings> {
    if (!hasLocalDriveClientId) return copySettings(settings)
    const { driveClientId: _driveClientId, ...rest } = settings
    const current = state.settings.driveClientId
    return copySettings({
      ...rest,
      ...(current !== undefined ? { driveClientId: current } : {}),
    })
  }

  function applyAccountSettings(incoming: PorterSettings): void {
    const settings = preserveLocalDriveClientId(incoming)
    const accountChanged =
      state.settings.nblmAuthuser !== settings.nblmAuthuser ||
      activeEmail(state.settings) !== activeEmail(settings)
    const hasAccounts = settings.accounts.length > 0
    patch({
      settings,
      ...(!hasAccounts || accountChanged ? { notebooks: [], selectedNotebookId: '' } : {}),
    })
  }

  /**
   * Selection for a freshly listed catalog. An explicit choice (a valid
   * current selection or a just-created notebook) always wins; otherwise the
   * staged docs' sticky route (§routing/sticky) preselects, as long as the
   * user hasn't overridden it and it lives on the active account; only then
   * does the account-blind `notebookTargets` fallback apply.
   */
  function resolveListSelection(notebooks: readonly { id: string }[], preferredId: string): string {
    if (notebooks.some((notebook) => notebook.id === preferredId)) return preferredId
    if (!manualNotebookPick) {
      const preferred = preferredRouteForDocs(state.settings.stickyRoutes, docs)
      if (
        preferred !== undefined &&
        preferred.authuser === state.settings.nblmAuthuser &&
        notebooks.some((notebook) => notebook.id === preferred.notebookId)
      ) {
        return preferred.notebookId
      }
    }
    return resolveNotebookTarget(notebooks, docs, state.settings.notebookTargets, preferredId)
  }

  function applyNotebookList(
    notebooks: readonly NotebookMeta[],
    preferredId = state.selectedNotebookId,
  ) {
    patch({
      notebooks: notebooks.map((notebook) => ({ ...notebook })),
      selectedNotebookId: resolveListSelection(notebooks, preferredId),
      error: undefined,
    })
  }

  function applyError(reason: string): void {
    patch({ error: reason })
  }

  function beginSourceConsole(
    operation: SourceConsoleOperation,
  ): SourceConsoleGeneration | undefined {
    if (
      accountOperationPending() ||
      state.pending.refresh ||
      state.pending.create ||
      activeSourceConsole !== undefined
    ) {
      return undefined
    }
    const target = sourceConsoleTarget(state)
    if (target === undefined) return undefined
    if (operation === 'dedupe' && (state.sourceConsole.scan?.duplicateCount ?? 0) === 0) {
      return undefined
    }
    sourceConsoleGeneration += 1
    activeSourceConsole = { generation: sourceConsoleGeneration, operation }
    patch({
      sourceConsole: {
        ...state.sourceConsole,
        status: undefined,
        pending: operation,
      },
    })
    return {
      sourceConsole: sourceConsoleGeneration,
      target,
    }
  }

  function isCurrentSourceConsole(generation: SourceConsoleGeneration): boolean {
    return (
      generation.sourceConsole === sourceConsoleGeneration &&
      sameOptionalNotebookTarget(generation.target, sourceConsoleTarget(state))
    )
  }

  function finishSourceConsole(generation: SourceConsoleGeneration): void {
    if (activeSourceConsole?.generation !== generation.sourceConsole) return
    activeSourceConsole = undefined
    patch({ sourceConsole: { ...state.sourceConsole, pending: undefined } })
  }

  function applySourceConsoleFailure(
    generation: SourceConsoleGeneration,
    operation: SourceConsoleOperation,
    reason: string,
  ): void {
    if (!isCurrentSourceConsole(generation)) return
    patch({
      sourceConsole: {
        scan: operation === 'scan' ? state.sourceConsole.scan : undefined,
        status: reason,
        pending: state.sourceConsole.pending,
      },
    })
  }

  function applySourceConsoleSuccess(
    generation: SourceConsoleGeneration,
    scan: ConsoleScan,
    status?: string,
  ): void {
    if (!isCurrentSourceConsole(generation)) return
    patch({
      sourceConsole: {
        scan: copyConsoleScan(scan),
        ...(status !== undefined ? { status } : { status: undefined }),
        pending: state.sourceConsole.pending,
      },
    })
  }

  function runSourceConsole<Success>(
    operation: SourceConsoleOperation,
    request: (
      client: PorterClientShape,
      generation: SourceConsoleGeneration,
    ) => Effect.Effect<Success, IpcError>,
    onSuccess: (generation: SourceConsoleGeneration, result: Success) => void,
  ): Effect.Effect<void, never, PorterClient> {
    return Effect.suspend(() => {
      const generation = beginSourceConsole(operation)
      if (generation === undefined) return Effect.void
      return Effect.gen(function* () {
        const client = yield* PorterClient
        const result = yield* Effect.result(request(client, generation))
        if (!isCurrentSourceConsole(generation)) return
        if (Result.isFailure(result)) {
          applySourceConsoleFailure(generation, operation, result.failure.reason)
          return
        }
        onSuccess(generation, result.success)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finishSourceConsole(generation)
          }),
        ),
      )
    })
  }

  function listForAccount(
    operation: AccountOperation,
    generation: AccountGeneration,
    binding: NotebookLmAccountBinding,
    forceRefresh: boolean,
  ): Effect.Effect<void, never, PorterClient> {
    return Effect.gen(function* () {
      if (!isCurrentAccount(operation, generation)) return
      notebookGeneration += 1
      const notebook = notebookGeneration
      setPending({ refresh: false, create: false })
      const client = yield* PorterClient
      const result = yield* Effect.result(
        client.request({
          type: 'porter/list-notebooks',
          account: binding,
          ...(forceRefresh ? { forceRefresh: true as const } : {}),
        }),
      )
      if (!isCurrentAccount(operation, generation) || notebook !== notebookGeneration) return
      if (Result.isFailure(result)) {
        applyError(result.failure.reason)
        return
      }
      applyNotebookList(result.success.notebooks)
    })
  }

  function loadSettingsAndCatalog(
    operation: AccountOperation,
    forceRefresh: boolean,
    beforeSettings?: (client: PorterClientShape) => Effect.Effect<void, IpcError>,
  ): Effect.Effect<void, never, PorterClient> {
    return Effect.suspend(() => {
      const generation = beginAccount(operation)
      if (generation === undefined) return Effect.void
      return Effect.gen(function* () {
        const client = yield* PorterClient
        if (beforeSettings !== undefined) {
          const beforeResult = yield* Effect.result(beforeSettings(client))
          if (!isCurrentAccount(operation, generation)) return
          if (Result.isFailure(beforeResult)) {
            applyError(beforeResult.failure.reason)
            return
          }
        }
        if (!isCurrentAccount(operation, generation)) return
        const settingsResult = yield* Effect.result(client.request({ type: 'porter/get-settings' }))
        if (!isCurrentAccount(operation, generation)) return
        if (Result.isFailure(settingsResult)) {
          applyError(settingsResult.failure.reason)
          return
        }
        applyAccountSettings(settingsResult.success.settings)
        const binding = accountBindingFor(state.settings)
        if (binding === undefined) return
        yield* listForAccount(operation, generation, binding, forceRefresh)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finishAccount(operation, generation)
          }),
        ),
      )
    })
  }

  return {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    updateDocs: (nextDocs) => {
      docs = nextDocs.map((doc) => ({ site: doc.site, canonicalUrl: doc.canonicalUrl ?? '' }))
    },
    supersedeBootstrap: () => {
      if (activeBootstrap === undefined || state.pending.bootstrap !== true) return
      activeBootstrap = undefined
      setPending({ bootstrap: false })
    },
    markManualTarget: () => {
      if (manualNotebookPick) return
      manualNotebookPick = true
      // Republish so the derived sticky fields drop (hint hides, auto-switch stops).
      patch({})
    },
    selectNotebook: (notebookId) => {
      if (state.pending.create || activeSourceConsole !== undefined) return
      if (notebookId === '' || state.notebooks.some((notebook) => notebook.id === notebookId)) {
        // A deliberate pick overrides sticky preselection for the rest of the session.
        manualNotebookPick = true
        patch({ selectedNotebookId: notebookId })
      }
    },
    editNewNotebookTitle: (title) => {
      draftGeneration += 1
      patch({ newNotebookTitle: title })
    },
    bootstrap: () => loadSettingsAndCatalog('bootstrap', false),
    refreshNotebooks: () =>
      Effect.suspend(() => {
        const generation = beginNotebook('refresh')
        if (generation === undefined) return Effect.void
        return Effect.gen(function* () {
          const client = yield* PorterClient
          const result = yield* Effect.result(
            client.request({
              type: 'porter/list-notebooks',
              account: generation.binding,
              forceRefresh: true,
            }),
          )
          if (!isCurrentNotebook(generation)) return
          if (Result.isFailure(result)) {
            applyError(result.failure.reason)
            return
          }
          applyNotebookList(result.success.notebooks)
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finishNotebook('refresh', generation)
            }),
          ),
        )
      }),
    discoverAccounts: () =>
      loadSettingsAndCatalog('discover', true, (client) =>
        Effect.asVoid(client.request({ type: 'porter/accounts-refresh' })),
      ),
    switchAccount: (authuser) =>
      Effect.suspend(() => {
        const generation = beginAccount('switchAccount')
        if (generation === undefined) return Effect.void
        patch({ notebooks: [], selectedNotebookId: '', error: undefined })
        return Effect.gen(function* () {
          const client = yield* PorterClient
          const settingsResult = yield* Effect.result(
            client.request({
              type: 'porter/update-settings',
              patch: { nblmAuthuser: authuser },
            }),
          )
          if (!isCurrentAccount('switchAccount', generation)) return
          if (Result.isFailure(settingsResult)) {
            applyError(settingsResult.failure.reason)
            return
          }
          applyAccountSettings(settingsResult.success.settings)
          const binding = accountBindingFor(state.settings)
          if (binding === undefined) return
          yield* listForAccount('switchAccount', generation, binding, false)
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finishAccount('switchAccount', generation)
            }),
          ),
        )
      }),
    createNotebook: () =>
      Effect.suspend(() => {
        const draft = state.newNotebookTitle
        const title = draft.trim()
        if (title === '') return Effect.void
        const submittedDraftGeneration = draftGeneration
        const generation = beginNotebook('create')
        if (generation === undefined) return Effect.void
        return Effect.gen(function* () {
          const client = yield* PorterClient
          const result = yield* Effect.result(
            client.request({
              type: 'porter/create-notebook',
              account: generation.binding,
              title,
            }),
          )
          if (!isCurrentNotebook(generation)) return
          if (Result.isFailure(result)) {
            applyError(result.failure.reason)
            return
          }
          applyNotebookList(result.success.notebooks, result.success.created.id)
          if (draftGeneration === submittedDraftGeneration) {
            draftGeneration += 1
            patch({ newNotebookTitle: '' })
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finishNotebook('create', generation)
            }),
          ),
        )
      }),
    updateDriveClientId: (driveClientId) =>
      Effect.suspend(() => {
        driveGeneration += 1
        const drive = driveGeneration
        hasLocalDriveClientId = true
        patch({
          settings: { ...state.settings, driveClientId },
          driveError: undefined,
          pending: { ...state.pending, driveUpdate: true },
        })
        return Effect.gen(function* () {
          const client = yield* PorterClient
          const result = yield* Effect.result(
            client.request({ type: 'porter/update-settings', patch: { driveClientId } }),
          )
          if (drive !== driveGeneration) return
          if (Result.isFailure(result)) {
            patch({ driveError: result.failure.reason })
            return
          }
          const { driveClientId: _driveClientId, ...rest } = state.settings
          patch({
            settings: { ...rest, driveClientId },
            driveError: undefined,
          })
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (drive === driveGeneration) setPending({ driveUpdate: false })
            }),
          ),
        )
      }),
    updateAutoExportVault: (autoExportVault) =>
      Effect.gen(function* () {
        // Optimistic: reflect the toggle immediately, then let the persisted
        // settings round-trip be the source of truth. Reuses the drive-client-id
        // preservation so a locally-typed, not-yet-saved Drive id survives.
        patch({ settings: { ...state.settings, autoExportVault } })
        const client = yield* PorterClient
        const result = yield* Effect.result(
          client.request({ type: 'porter/update-settings', patch: { autoExportVault } }),
        )
        if (Result.isSuccess(result)) {
          patch({ settings: preserveLocalDriveClientId(result.success.settings) })
        }
      }),
    updateConvexUrl: (convexUrl) =>
      Effect.gen(function* () {
        // Optimistic like the vault toggle: show the typed value, then let the
        // persisted (validated + normalized) settings round-trip win — an
        // empty or non-https URL clears the field on the server.
        patch({ settings: { ...state.settings, convexUrl } })
        const client = yield* PorterClient
        const result = yield* Effect.result(
          client.request({ type: 'porter/update-settings', patch: { convexUrl } }),
        )
        if (Result.isSuccess(result)) {
          patch({ settings: preserveLocalDriveClientId(result.success.settings) })
        }
      }),
    scanSourceConsole: () =>
      runSourceConsole(
        'scan',
        (client, generation) =>
          client.request({ type: 'porter/nblm-scan-console', target: generation.target }),
        (generation, result) => applySourceConsoleSuccess(generation, result.scan),
      ),
    removeSourceDuplicates: () =>
      runSourceConsole(
        'dedupe',
        (client, generation) =>
          client.request({ type: 'porter/nblm-dedupe', target: generation.target }),
        (generation, result) => {
          const removed = result.removedIds.length
          applySourceConsoleSuccess(
            generation,
            result.scan,
            `Removed ${removed} duplicate source${removed === 1 ? '' : 's'}`,
          )
        },
      ),
    retrySource: (sourceId) =>
      Effect.suspend(() => {
        const canRetry = state.sourceConsole.scan?.failed.some(
          (diagnosis) => diagnosis.source.id === sourceId && diagnosis.retry === 'refresh',
        )
        if (canRetry !== true) return Effect.void
        return runSourceConsole(
          'retry',
          (client, generation) =>
            client.request({
              type: 'porter/nblm-retry-source',
              target: generation.target,
              sourceId,
            }),
          (generation, result) =>
            applySourceConsoleSuccess(
              generation,
              result.scan,
              'Retry requested — re-scan in a moment to see the new status',
            ),
        )
      }),
  }
}
