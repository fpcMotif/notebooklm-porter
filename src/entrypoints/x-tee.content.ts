/**
 * MAIN-world passive tee for the page's own X thread GraphQL traffic. It
 * never sends a request or changes the page's response; the isolated script
 * validates and parses only the bounded CustomEvent payloads it receives.
 */
import {
  X_GRAPHQL_TEE_EVENT,
  X_GRAPHQL_TEE_MAX_BODY_CHARS,
  isXThreadGraphqlUrl,
} from '../core/adapters/x/graphql'
import { X_CONTENT_MATCHES } from '../core/adapters/x/adapter'

function emit(url: string, body: string): void {
  if (body.length > X_GRAPHQL_TEE_MAX_BODY_CHARS) return
  document.dispatchEvent(new CustomEvent(X_GRAPHQL_TEE_EVENT, { detail: { url, body } }))
}

function resolvedUrl(value: string | URL): string | undefined {
  try {
    return new URL(value, location.href).href
  } catch {
    return undefined
  }
}

export default defineContentScript({
  matches: [...X_CONTENT_MATCHES],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const originalOpen = XMLHttpRequest.prototype.open
    function patchedOpen(this: XMLHttpRequest, method: string, url: string | URL): void
    function patchedOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async: boolean,
      username?: string | null,
      password?: string | null,
    ): void
    function patchedOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ): void {
      const requestUrl = resolvedUrl(url)
      if (requestUrl !== undefined && isXThreadGraphqlUrl(requestUrl)) {
        this.addEventListener(
          'load',
          () => {
            if (this.status < 200 || this.status >= 300) return
            try {
              emit(this.responseURL || requestUrl, this.responseText)
            } catch {
              // Passive observation must never interfere with the page request.
            }
          },
          { once: true },
        )
      }
      Reflect.apply(
        originalOpen,
        this,
        async === undefined ? [method, url] : [method, url, async, username, password],
      )
    }
    XMLHttpRequest.prototype.open = patchedOpen

    const originalFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const requestUrl = resolvedUrl(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      )
      const response = originalFetch(input, init)
      if (requestUrl === undefined || !isXThreadGraphqlUrl(requestUrl)) return response
      void response.then(
        (result) =>
          result.ok
            ? result
                .clone()
                .text()
                .then((body) => emit(requestUrl, body))
                .catch(() => undefined)
            : undefined,
        () => undefined,
      )
      return response
    }
  },
})
