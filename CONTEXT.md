# CONTEXT.md — Domain glossary

Ubiquitous language for NotebookLM Porter. Use these terms exactly in code, specs,
and reviews; sharpen definitions here as they crystallize.

## Capture

- **Capture** — the tagged union `{ kind: 'thread' | 'playlist' | 'video' | 'web' }`
  produced by a per-site adapter from raw network/DOM data, before formatting into a
  SourceDoc. The adapter→formatter boundary.
- **SourceAdapter** — one platform's capture strategy: `id`, `hostMatch`, `detect(url)`,
  and a **capture strategy** (`mode: 'url'` — background fetch, or
  `mode: 'content-script'` — the site's content script owns extraction). The registry
  entry is the single source of truth for a platform; nothing outside `adapters/`
  switches on platform id.
- **Capturable** — synchronous, URL-only verdict of what a page offers (kind + button
  label + declared capabilities such as `canEnrichTranscripts`), decided without
  touching the page so the popup can label its button.
- **CaptureOptions** — adapter-interpreted options for one capture
  (`enrichTranscripts`). Named after the capability, never after a platform.
- **Transcript enrichment** — best-effort, bounded per-video transcript snapshots
  (captions + chapters → Markdown) attached to a playlist capture as `videoDocs`.
- **Structure-preserving capture** — the product differentiator: reply-depth as
  blockquote nesting, quoted posts, alt text — never flattened paste-text.
- **MAIN-world tee** — x-tee.content.ts runs in the page's JS context to passively
  observe X's own GraphQL responses via prototype patching; relays bounded payloads to
  the isolated content script by CustomEvent, making no network request of its own.

## Documents & units

- **SourceDoc** — the stored, NotebookLM-ready capture unit (id `<site>:<nativeId>`),
  carrying rendered Markdown/JSONL, word count, truncation flag, optional `videoDocs`.
  The dedup/replace key for re-captures.
- **IngestUnit** — an immutable, independently-receiptable NotebookLM mutation derived
  from a SourceDoc by `planIngestUnits`. The idempotency and queue boundary.
- **Frontmatter** — the `---`-delimited YAML header every renderer emits. Rendering
  (escaping) and splitting (boundary scan) are owned by one module; the dedup hash is
  computed over frontmatter-minus-`captured_at` + body, so render and hash must agree
  by construction.

## Sync pipeline

- **Ledger** — per-notebook record of already-synced IngestUnit ids + content hashes;
  owns the "already synced, don't re-send" invariant.
- **QueueJob / drainQueue** — persisted per-unit delivery job; drain processes due jobs
  in one alarm-tick burst with markInFlight → deliver → receipt → remove durability, so
  an MV3 service-worker death mid-send becomes explicit `uncertain` state, never silent
  loss or double-send.
- **Watch** — an immutable, account-bound binding (source URL + source doc id +
  notebook target + capture options) that periodically recaptures and enqueues in the
  background. Watches bind **mutable sources only** (threads, playlists — kinds that
  grow); a static video is not watchable.
- **Storage lane** — a promise-chain mutex over one storage domain
  (docs / watches / queue / settings), acquired in fixed order so multi-domain work stays
  deadlock-free. One lane holds the whole message handler, including every settings
  read-modify-write.

## NotebookLM ingest

- **Tier A / B / C** — the layered ingest fallback: A = `batchexecute` RPC from the SW
  (primary), B = DOM automation on an open NotebookLM tab (stubbed until a live-verified
  selector profile exists), C = local file export (built; currently unwired from UI and
  fallback — see spec-drift notes).
- **authuser probe** — fetching NBLM's `?authuser=N` homepage and scraping login/CSRF
  state; positional slots can be reassigned by Google, so account-sensitive state is
  additionally keyed on the observed account email.
- **ProtocolDrift** — a 200 response whose envelope no longer parses: Google changed
  the wire format. Distinct from NotLoggedIn/RpcRefused so queue and UI react correctly.
- **notebooks-cache** — browse-only `authuser → {email, notebooks}` cache; every
  mutation still performs a fresh authenticated listing.
- **Debug ring** — capped append-only log in `storage.local`, readable from the popup
  (the SW console isn't). Content-free by policy: counts and kinds, never captured text.

## NotebookLM identity

- **NotebookLM account** — a Google identity recognized by its observed email.
  `authuser` is only its current positional slot and may later name another identity.
  _Avoid_: authuser account, account slot.
- **NotebookLM account binding** — an immutable `authuser` + observed-email snapshot carried by
  asynchronous NotebookLM commands. Background work authenticates this binding instead of reading
  mutable selection to choose an account.
  _Avoid_: selected account, account ID.
- **Authenticated account** — a transient NotebookLM session whose observed email
  matches the expected NotebookLM account for that `authuser` slot.
  _Avoid_: session.
- **Notebook target** — a notebook ID bound to one NotebookLM account by both
  `authuser` and email. Queue jobs and watches retain this binding even when the
  user's later selection changes.
  _Avoid_: notebook ID, queue target.

## NotebookLM source management

- **Source Console** — a management view of the sources in one NotebookLM notebook.
  It identifies duplicate sources and failed loads, then supports safe removal or
  retry.
  _Avoid_: manage sources, resource console.
- **Proven duplicate** — two NotebookLM sources with the same validated YouTube video identity.
  Titles and generic URLs are display evidence, not authority for automatic deletion.
  _Avoid_: same-title source, normalized-URL duplicate.
- **Notebook catalog** — the browsable notebooks for the active NotebookLM account
  slot, plus the workflow that creates and reconciles a new notebook. Its cache speeds
  browsing but never proves a delivery target.
  _Avoid_: notebook list, notebook picker cache.

## Drive backup

- **Drive backup artifact** — one managed Markdown file for one stable `SourceDoc` identity.
  Private Drive metadata owns identity; the readable filename is presentation only.
  _Avoid_: title-keyed file, backup filename identity.
- **Notebook workspace** — the popup's local account, catalog, selection, notebook draft,
  Drive setting, and Source Console projection, plus the stale-result rules for those UI
  workflows. It contains no NotebookLM protocol policy.
  _Avoid_: notebook picker state, popup account state.

## X capture

- **X thread evidence** — bounded, document-local GraphQL observations reconciled with
  the DOM floor for one X conversation. It may enrich a DOM tweet but never remove or
  weaken DOM evidence.
  _Avoid_: GraphQL cache, captured tweets.
