/**
 * The `DomTabs` service — the NotebookLM visible-tab fallback (Tier B). Its
 * interface lives here, beside its consumers (PoEAA Separated Interface),
 * rather than in the generic fx substrate: `makeDomTabs` speaks NotebookLM
 * tab/URL/relay protocol, unlike the site-agnostic wrappers in fx/services.ts.
 * Live wiring stays in fx/layers.ts; the test double stays in fx/testing.ts.
 */
import { Context, Effect, Result } from 'effect'
import { IpcError } from '../../fx/errors'
import {
  isTargetNotebookUrl,
  normalizeDomDeliveryResult,
  type DomDeliveryRequest,
  type DomDeliveryResult,
} from './contracts'
import { hasVerifiedDomDriver } from './selectors'

/** Browser-tab boundary used only by the NotebookLM visible-tab fallback. */
export interface DomTabsShape {
  /**
   * Whether a live-verified DOM driver exists to attempt Tier B at all. The
   * queue reads this BEFORE degrading Tier A or marking a job in-flight, so a
   * read-only protocol drift never routes into a fallback that cannot succeed.
   */
  readonly available: boolean
  readonly deliver: (request: DomDeliveryRequest) => Effect.Effect<DomDeliveryResult>
}

export class DomTabs extends Context.Service<DomTabs, DomTabsShape>()('porter/DomTabs') {}

interface DomTab {
  id?: number | undefined
  url?: string | undefined
}

interface DomTabsApi {
  query: (queryInfo: { url: string }) => Promise<DomTab[]>
  create: (createProperties: { active: boolean; url: string }) => Promise<DomTab>
  sendMessage: (tabId: number, message: unknown) => Promise<unknown>
}

const DOM_RELAY_ATTEMPTS = 4
const DOM_RELAY_RETRY_DELAY = '250 millis'

function notebookTabBaseUrl(notebookId: string): string {
  return `https://notebooklm.google.com/notebook/${encodeURIComponent(notebookId)}`
}

export function notebookTabUrl(notebookId: string, authuser: number): string {
  return `${notebookTabBaseUrl(notebookId)}?authuser=${authuser}`
}

function unavailable(reason: string): DomDeliveryResult {
  return { status: 'unavailable', reason }
}

function isMissingReceiver(reason: string): boolean {
  return reason.toLowerCase().includes('receiving end does not exist')
}

/**
 * Finds an already-open target or opens it visibly, then relays one immutable
 * unit. Only a proven absent receiver is safe-unavailable; transport breaks
 * after dispatch are treated as uncertain because the page may have acted.
 */
export function makeDomTabs(tabs: DomTabsApi): DomTabsShape {
  return {
    // Read per access (not captured at layer build) so a remote selector
    // profile applied after SW startup is honored by queue routing.
    get available() {
      return hasVerifiedDomDriver()
    },
    deliver: (request) =>
      Effect.gen(function* () {
        const existing = yield* Effect.result(
          Effect.tryPromise({
            try: () => tabs.query({ url: `${notebookTabBaseUrl(request.notebookId)}*` }),
            catch: (cause) => new IpcError({ reason: String(cause) }),
          }),
        )
        if (Result.isFailure(existing)) {
          return unavailable(`Could not find the target NotebookLM tab: ${existing.failure.reason}`)
        }

        let tab = existing.success.find(
          (candidate) =>
            candidate.id !== undefined &&
            candidate.url !== undefined &&
            isTargetNotebookUrl(candidate.url, request.notebookId),
        )
        if (tab === undefined) {
          const created = yield* Effect.result(
            Effect.tryPromise({
              try: () =>
                tabs.create({
                  active: true,
                  url: notebookTabUrl(request.notebookId, request.authuser),
                }),
              catch: (cause) => new IpcError({ reason: String(cause) }),
            }),
          )
          if (Result.isFailure(created)) {
            return unavailable(
              `Could not open the target NotebookLM tab: ${created.failure.reason}`,
            )
          }
          tab = created.success
        }
        const tabId = tab.id
        if (tabId === undefined) return unavailable('NotebookLM tab did not expose a tab id')

        for (let attempt = 0; attempt < DOM_RELAY_ATTEMPTS; attempt += 1) {
          const response = yield* Effect.result(
            Effect.tryPromise({
              try: () =>
                tabs.sendMessage(tabId, {
                  type: 'porter/dom-deliver',
                  request,
                }),
              catch: (cause) => new IpcError({ reason: String(cause) }),
            }),
          )
          if (!Result.isFailure(response)) return normalizeDomDeliveryResult(response.success)
          if (!isMissingReceiver(response.failure.reason)) {
            return {
              status: 'uncertain',
              reason: `NotebookLM DOM relay stopped after dispatch: ${response.failure.reason}`,
            }
          }
          if (attempt + 1 < DOM_RELAY_ATTEMPTS) yield* Effect.sleep(DOM_RELAY_RETRY_DELAY)
        }
        return unavailable('NotebookLM DOM assist is not loaded in the target tab')
      }),
  }
}
