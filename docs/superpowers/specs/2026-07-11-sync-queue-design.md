# Persisted ingest queue design

## Decision

The queue boundary is an immutable `IngestUnit` snapshot, never a captured
`SourceDoc`. A playlist's overview and every video can therefore make
independent progress, share a receipt, and resume without re-reading a later
recapture.

Each queued job contains the unit, its originating document ids, and a target
identity: notebook id, `authuser`, and the selected account email. Its stable
deduplication key is account email + notebook id + unit id + content hash.

## Safety contract

The worker persists `inFlight` before dispatching a remote mutation. A job
left in that state after worker restart becomes `uncertain`, never an
automatic retry: NotebookLM may have accepted the mutation just before the
worker died. The popup exposes an explicit retry-anyway path for that state.

On known success, the worker writes the ledger receipt before deleting the
job. A job still present after a receipt write is removed without another
NotebookLM request on the next drain.

Only failures before a source mutation, such as session setup, use bounded
backoff. Any transport failure after an add-source request is ambiguous and
becomes `uncertain`; the user must explicitly retry it. Authentication identity
changes block a job. Protocol drift and refused requests become terminal
failures.

## Boundaries

- `core/queue/queue.ts`: pure state transitions, fairness, backoff, and
  projections.
- `core/queue/drain.ts`: storage, account validation, one-unit delivery, and
  scheduling decisions.
- `Alarms`: the only durable scheduler. Each wake drains one unit and arms the
  next due wake; no detached fibers or in-memory timers are used for progress.
- `ingest/notebooklm.ts`: exports the typed single-unit delivery primitive;
  direct ingest remains a compatibility wrapper during migration.

No queue state contains a live `SourceDoc`, browser tab, or popup state.

## Verification

Pure tests cover deduplication, stable order, backoff, terminal state, and
interrupted work becoming uncertain. Drain tests cover the persisted order of
`inFlight`, remote send, receipt, and removal. Router and popup tests cover
typed enqueue/status/retry contracts. A packaged Chrome test later proves
alarms, popup closure, and worker termination behavior.
