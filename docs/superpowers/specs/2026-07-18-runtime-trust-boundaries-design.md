# Runtime trust boundaries design

## Goal

Turn unknown browser messages and durable settings into canonical domain values before business
modules see them. Malformed input must be rejected or normalized, never cast.

## Proven defects

- `isPorterMessage` accepts every object whose string tag starts with `porter/`. An unknown tag
  reaches an undefined router handler. A known tag with missing fields reaches business code.
- `isExtractResponse` accepts any non-null `capture`. A malformed capture can reach formatters and
  storage.
- Settings load casts unknown storage and spreads it over defaults. `{ accounts: null }` survives;
  account ownership then calls `.find` and defects.
- A malformed runtime settings patch can persist the same invalid state.
- The durable ingest queue casts unknown storage to `QueueState`. Corrupt targets or units can
  reach remote mutation code.
- The watch store casts unknown storage before mapping it. A malformed root can throw during load;
  malformed targets can reach resync and enqueue.

Chrome runtime messages are extension-internal, but MV3 updates can leave an old content script
talking to a new service worker. The runtime value is still unknown. Static TypeScript does not
prove version-skewed wire data or durable storage.

## Domain rules

- Decode unknown wire values. Do not use an unchecked type predicate.
- A decoder rebuilds a canonical value and drops harmless extra top-level message fields for
  additive compatibility.
- Unknown tags, missing fields, wrong field types, unknown settings-patch keys, and explicit
  `undefined` reject the message.
- Full captures are decoded recursively before formatting or storage.
- `Capture` decoding checks structural types, finite numbers, enums, and non-negative integer
  depths. URL and timestamp semantics remain adapter policy.
- Settings patches are strict. Invalid input is rejected as a whole; no false successful no-op.
- Persisted settings are tolerant. Each valid known field survives; invalid fields default or are
  omitted; unknown legacy fields disappear.
- Account arrays contain only non-negative integer slots with nonblank observed emails.
- Notebook targets contain only known site keys with nonblank string values.
- `driveClientId: ''` remains a valid explicit clear.
- Decode and rebuild. Never return the foreign object by reference.
- Durable remote-work records require valid targets, units, statuses, counters, and timestamps.
- A malformed queue rejects atomically. Partial recovery cannot prove whether a lost row was
  in-flight, uncertain, or a duplicate delivery.
- Watch rows are independent schedules. Reject bad rows, retain valid siblings, rekey from the
  decoded full target, and keep the first row after canonical-ID deduplication.

## Designs considered

### Known-tag whitelist only

Rejected. It stops undefined-handler defects but still lies about payloads and captures.

### One tolerant decoder everywhere

Rejected. Dropping malformed patch fields while returning success hides caller defects and can
persist a partial intent.

### Runtime schema dependency

Rejected. Twenty-four closed messages need simple structural decoding. A new schema framework
would add a second type vocabulary and a wider interface than this module needs.

### Small composable decoders

Chosen. Shared leaf decoders rebuild bindings, targets, captures, accounts, and settings fields.
The message switch remains exhaustive and returns one canonical `PorterMessage`.

## Interfaces

```ts
decodeCapture(value): Capture | undefined
decodePorterMessage(value): PorterMessage | undefined
decodeExtractResponse(value): ExtractResponse | undefined
decodeStoredSettings(value): PorterSettings
decodeSettingsPatch(value): Partial<PorterSettings> | undefined
decodeStoredQueue(value): QueueState | undefined
decodeStoredWatchState(value): WatchState | undefined
```

`background.ts` decodes once, then passes only the canonical message to lane selection and the
router. Popup/content-script reply handling uses `decodeExtractResponse` and the same Capture
decoder.

## Message validation

- IDs, URLs, titles, and source IDs are strings.
- ID collections are arrays of strings.
- `tabId` and `authuser` are non-negative safe integers.
- `format` is `markdown | jsonl`.
- `forceRefresh`, when present, is literal `true`.
- Bindings require `authuser` and nonblank `accountEmail`.
- Targets add a nonblank `notebookId`.
- Capture options accept only optional literal `enrichTranscripts: true`.
- No-payload messages require only their exact known tag.

Full Capture validation covers thread authors/posts/stats/media, playlist videos/transcripts,
standalone videos, and web captures. Optional numeric values must be finite; post depth and video
indices/counts are non-negative integers where the domain requires it.

## Settings normalization

Stored settings rebuild from:

- `nblmAuthuser`: non-negative safe integer, else `0`;
- `accounts`: valid account rows, else `[]`;
- `notebookTargets`: valid known-site/nonblank-ID pairs, else `{}`;
- `driveClientId`: string when present, otherwise omitted.

The codec creates fresh arrays and objects. `updateSettings` decodes current storage, merges a
strict typed patch, canonicalizes the result, then saves it.

## Verification

Message tests prove:

- one valid message for every tag;
- unknown and non-string tags reject;
- each field family rejects one malformed example;
- all four Capture variants accept canonical examples and reject malformed nested values;
- successful extraction replies require a fully decoded Capture;
- strict settings patches accept each field and `{}`, but reject unknown, undefined, or malformed
  fields;
- returned values share no mutable foreign objects.

Settings tests prove:

- corrupt persisted values become safe defaults;
- one bad field does not erase valid siblings;
- unknown keys disappear;
- valid partial patches preserve unrelated fields;
- malformed accounts and targets never reach ownership;
- default arrays and maps are fresh.

Background integration proves an unknown or malformed message never reaches lanes or the router,
while a decoded valid message preserves existing dispatch.

Queue tests prove:

- accepted state is rebuilt without shared records or arrays;
- malformed roots, jobs, targets, units, dates, and optional fields reject atomically;
- duplicate job IDs or immutable deliveries reject;
- `docIds` contains `unit.docId`;
- malformed durable state causes no remote mutation.

Watch tests prove:

- malformed roots become empty state;
- malformed rows do not erase valid siblings;
- inherited required fields and explicit `undefined` optionals reject;
- IDs are recomputed from source plus full target and duplicate canonical IDs keep the first row;
- the legacy literal `enrichYoutube: true` migrates to transcript capture;
- accepted targets, options, and rows are fresh values.

## Scope

- No URL or ISO-date validation in the wire module.
- No external messaging permission change.
- No new storage key or schema version.
- No silent wire coercion.
- No attempt to repair or partially execute a corrupt remote-mutation queue.
