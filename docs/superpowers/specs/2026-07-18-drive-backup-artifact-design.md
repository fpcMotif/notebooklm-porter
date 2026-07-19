# Drive backup artifact design

## Goal

Make one Drive backup artifact mean one `SourceDoc`, across equal titles, sanitized-title
collisions, title changes, and repeated backups. Preserve readable filenames and Drive revisions.

## Proven defect

The current workflow queries by `docFileName(title)` and updates the first match. Distinct docs can
share that name:

- `a/b` and `a\\b` both become `a-b.md`;
- blank and whitespace titles both become `untitled.md`;
- titles with the same first 100 characters collide.

The second backup then overwrites an arbitrary first match. This violates the product rule: one
file per captured source.

## Domain rules

- A **Drive backup artifact** is keyed by `SourceDoc.id`, never by title.
- The key is `source:v1:<base64url SHA-256 of UTF-8 SourceDoc.id>`.
- Store the key in private Drive `appProperties` under `notebookLmPorterArtifact`.
- Query by property, parent folder, and `trashed=false` before every create or update.
- A readable digest suffix distinguishes equal visible titles. Filename remains presentation.
- A title change renames and updates the same managed file in one multipart PATCH.
- One managed match updates. More than one is ambiguous and mutates nothing.
- One service-worker permit serializes backup workflows. It closes the local query/create race.
- A cross-device race can still create duplicate managed matches. The next backup detects and
  refuses them; it never chooses an arbitrary file.
- Drive list pagination is consumed before uniqueness decisions.
- Per-doc failure isolation remains. One failed artifact does not abort later docs.

Google Drive supports private, searchable `appProperties`; one property key plus value may use at
most 124 UTF-8 bytes. `files.update` supports metadata and content in one multipart request. See
[custom properties](https://developers.google.com/workspace/drive/api/guides/properties),
[file search](https://developers.google.com/workspace/drive/api/guides/search-files), and
[`files.update`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update).

## Designs considered

### Filename suffix as identity

Rejected. A stable suffix distinguishes collisions, but exact-name lookup breaks when the title
changes. Prefix search turns a presentation convention into identity again.

### Local Drive-ID map

Rejected. Reinstall, another browser, or local storage loss severs the map. Drive already owns the
artifact, so its private metadata must own identity too.

### Raw source ID in metadata

Rejected. Context-menu IDs may contain long URLs. Drive caps one property key plus value at 124
bytes. A fixed SHA-256 digest is bounded and does not expose the raw source ID.

### Private Drive property

Chosen. It survives filename changes, is directly searchable, stays private to the OAuth client,
and keeps the module interface small.

## Legacy migration

Old artifacts have only the unsuffixed title-derived name. A name does not prove ownership.

1. When no managed match exists, query the exact old filename inside the chosen folder.
2. Consider only one unique unowned candidate. Multiple candidates are ambiguous and mutate none.
3. Download that candidate.
4. Adopt it only when its bytes exactly equal the current stored Markdown.
5. Adoption uses one multipart PATCH to add the private property, rename, and preserve content.
6. A failed or uncertain adoption never falls through to create during the same attempt.
7. Missing or mismatched legacy content remains untouched. Create a new managed artifact.

This migration favors one safe duplicate over overwriting an unproven file.

## Folder policy

The backup folder also receives a private key, `backup-folder:v1`. One managed match wins; multiple
managed matches fail. A unique legacy folder visible under the existing `drive.file` grant may be
tagged before use. Multiple legacy folders are never chosen by list order; create a new managed
folder instead.

## Module design

`backup/drive.ts` owns pure identity, query, pagination, download, metadata, and multipart request
descriptors. `backup/client.ts` owns OAuth, HTTP, the module permit, legacy proof, and per-doc
outcomes.

The public interface stays:

```ts
backupDocsToDrive(docIds): Effect<BackupOutcome[], DriveAuthError | DriveApiError | StorageError, ...>
```

This is a deep module: callers name docs once; identity, migration, ambiguity, and revision policy
remain internal.

Before loading settings or touching OAuth/Drive, the workflow resolves every requested document.
An empty or stale-only selection returns ordered `Doc not found` outcomes (or `[]`) with no identity
call, HTTP request, folder creation, or Drive mutation. A mixed selection performs setup once, then
keeps the existing per-document isolation and input order.

`DriveAuthError` is only for missing client IDs and OAuth failures. Folder lookup, creation,
tagging, pagination, ambiguous matches, and malformed Drive responses remain `DriveApiError`.
Per-doc Drive failures remain isolated `BackupOutcome` values.

## Verification

Pure request tests prove:

- deterministic versioned artifact keys fit Drive's property limit;
- property and folder queries escape values and include parent/trashed scope;
- create and update multipart bodies carry metadata plus Markdown;
- display suffixes preserve total filename bounds;
- page tokens are encoded without changing the base query.

Workflow tests prove:

- equal titles create distinct managed files;
- sanitizer, truncation, and blank-title collisions stay distinct;
- one doc with a changed title updates the same Drive ID and renames it;
- same-name unrelated files are ignored by managed lookup;
- a unique byte-identical legacy artifact is adopted;
- mismatched legacy content is untouched and a managed artifact is created;
- ambiguous legacy or managed matches mutate nothing;
- failed adoption never creates a fallback;
- concurrent same-doc backups create once, then update;
- pagination cannot hide a duplicate match;
- batch failure isolation and update-in-place revisions remain.

## Scope

- No broader Drive scope.
- No local manifest.
- No deletion of legacy or duplicate files.
- No claim that a changed OAuth client can rediscover another client's private properties.
- No cross-device distributed lock.
