# Persisted ingest queue design

## Decision

The queue boundary is an immutable `IngestUnit` snapshot, never a captured
`SourceDoc`. A playlist's overview and every video can therefore make
independent progress, share a receipt, and resume without re-reading a later
recapture.

Each queued job contains the unit, its originating document ids, and a target
identity: notebook id, `authuser`, and the selected account email. Its stable
deduplication key is a collision-safe serialization of that full target, unit
id, and content hash. Receipts are hashes of immutable unit content scoped to
the same full target. They are not remote NotebookLM source IDs and do not
prove remote-source or notebook ownership.

The ledger uses `porter/ledger/v2`. Unscoped v1 receipts keyed only by notebook
id are not adopted: they cannot prove which positional account slot produced
them, and a false receipt would skip required work. The first v2 delivery may
therefore resend a source that v1 had recorded. This is safer than a false skip.
Watch identities and queued-version supersession also use the full target, so
two slots carrying the same email and notebook id never share state.

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
