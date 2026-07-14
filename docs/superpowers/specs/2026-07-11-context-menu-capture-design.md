# Context-menu capture design

## Goal

Capture a page, a text selection, or a clicked link from the browser context
menu into local Porter storage. Sending it to NotebookLM remains a separate,
explicit queue action.

## Scope

This is a capture-only vertical slice. It adds `contextMenus`, `activeTab`,
and `scripting`; it does not add broad host permissions, notifications,
badges, scheduled work, or immediate remote ingest.

## Capture flow

The background entrypoint registers three menus: Capture selection, Capture
page, and Capture link. A click is translated into a small core input and
handled by `core/context-menu/`.

For a link, the handler first uses an existing background URL adapter when it
has `captureFromUrl`. Content-script-only adapters (currently X) deliberately
fall back to generic web capture: the clicked tab is not the linked page, so
it cannot truthfully run that page's content-script extraction.

For a selection, the handler uses the page URL/title and selected text. Link
click data in Chrome provides its URL but not its anchor text, so the generic
link snapshot records that canonical URL and uses the page title when present.
For a page, the `Scripting` service injects a short extractor that prefers
`article`, then `main`, then `body`, returning title and text. Text is capped
inside the page before it crosses the extension boundary.

## Domain and formatting

Generic content is a new `Capture { kind: 'web' }` rather than a synthetic
social thread. `WebCapture` carries a canonical HTTP(S) URL, title, capture
mode and normalized text. It formats to a
standalone Markdown source with explicit `source: web` and `capture_mode`
frontmatter.

Stable source ids distinguish capture modes:

- page: `web:page:<hash(url)>`
- link: `web:link:<hash(url)>`
- selection: `web:selection:<hash(url + normalized text)>`

Thus repeated page/link captures replace their own prior snapshots while
different selections remain separately capturable.

## Boundaries and failure behavior

- `core/context-menu/capture.ts` is pure normalization and validation.
- `core/context-menu/handler.ts` composes adapter capture, scripting,
  formatting, and local storage.
- `fx/Scripting` is the only boundary that touches `browser.scripting`.
- `entrypoints/background.ts` only registers browser events and invokes the
  effect program.

Invalid URLs, empty selection/page text, missing script results, and script
errors produce no stored document; they never affect existing captures or
queue state. Only local extension storage is mutated.

## Verification

Unit-test normalization, cap behavior, stable IDs, Markdown rendering,
adapter-vs-generic routing, and scripting result/error mapping. The complete
`bun run check` gate must pass, including a production manifest build that
proves the required permissions are present.
