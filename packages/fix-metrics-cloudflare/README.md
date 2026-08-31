# @pi/fix-metrics-cloudflare

**Fix Metrics — first production-shaped, synthetic-data-only slice (PoC).**

Implements the approved Fix Metrics Cloudflare design
(`docs/归档/研究/2026-08-28-fix-telemetry-cloudflare-technical-proposal.md`, ADOPTED with
implementation gate) as a standalone Worker package. **It is deliberately not wired to real /fix
telemetry**: no client telemetry is added, no existing Fix workflow behavior changes, and the
ingest path is gated by a synthetic-only guard.

## Scope (this slice)

- `POST /api/v1/events` — bounded JSON batch ingest of exactly the five public funnel events
  (`run_started`, `investigation_review_passed`, `resolution_completed`, `verification_passed`,
  `run_accepted`). Max 100 events per batch, 256 KB body cap. Idempotency by
  `eventId` + `eventBusinessKey` (server-computed) with duplicate-vs-conflict detection. Invalid or
  unsafe events are quarantined (durable, never projected, never raw business text). Every valid
  request answers `202` with per-item ACKs. Quarantine records get collision-resistant
  server-side identities (`qz_*` / `qzk_*` derived from a hash of the raw content + reason code):
  unrelated invalid events never share `[redacted]`/`[unkeyed]` sentinel values and are each
  durably stored, while an exact re-send maps to the same identity and stays a duplicate — even
  for raw bytes canonical JSON cannot represent (e.g. lone surrogates), where the identity falls
  back to a deterministic surrogate-escaping serialization, never a random value. A safe
  `runId` is retained on quarantine records for data-quality sample units.
  `verification_passed` facts are additionally bound at ingest to the actual resolution of their
  run + resolution cycle: the cycle must match an accepted `resolution_completed`, the
  verification must not precede that resolution in time, and the evidence ref /
  candidateRevision / sourceVersion must be consistent with that resolution; an empty, unrelated
  or out-of-time-order binding is a permanent error (`unbound_verification_evidence`), never a
  silently unbound verification fact. `run_accepted` facts are gated on prior Acceptance
  evidence: an accepted `verification_passed` for the SAME run must already be stored — a bare
  valid-shape `run_accepted` is a permanent error (`run_accepted_without_verification`), never
  silently accepted. ACKs never echo an unvalidated eventId: a raw eventId that fails the id
  pattern is replaced by a fixed safe placeholder (permanent items) or the server-generated safe
  quarantine identity (`qz_*`, quarantined items).
- `GET /api/v1/snapshots/latest` and `GET /api/v1/funnel?snapshotId=...` — READ-ONLY aggregate
  monthly snapshots with low-sample protection (k=5). GET never builds, rebuilds or publishes
  anything. Snapshot generation runs only on the controlled `POST /api/v1/snapshots/publish`
  path (same synthetic-only guard and bearer-token auth as ingest). No run ids, no payload text.
  Data-quality groups are judged on deduplicated safe-`runId` sample units
  (`lateEventRuns`/`invalidEventRuns`), never on raw event/row counts; records without a safe
  runId are suppressed from those units, and quarantine sample units are restricted to the
  snapshot cohort (records attributed to runs outside the snapshot's `run_started` cohort never
  create sample units, while the `invalidEvents` row diagnostic keeps all window records).
  `/snapshots/latest` follows the per-window publication pointer only. `/funnel?snapshotId=` serves
  the current pointer target of its window, and also retains earlier revisions of a published
  window readable by their `snapshotId` via the explicit published-revision history table
  (migration 0002): every revision that wins a pointer write is recorded ATOMICALLY with the
  pointer (one adapter-level transaction/batch — a partial failure rolls both back, so a pointer
  can never exist without its history row), so an old published revision stays readable after the
  pointer moves, while a same-window stored-but-never-published row (no pointer, no history) and
  future-dated rows stay invisible. Migration 0002 backfills the pre-upgrade pointer target into
  the history table, so revisions published before the upgrade remain readable. The future-as-of
  gate applies to ALL public read paths: the pointer target and `/snapshots/latest` also reject a
  snapshot whose as-of point lies ahead of the server clock (`future_snapshot`), not only
  retained revisions.
- D1-backed storage behind a narrow `SqlDatabase` adapter (real D1 binding adapted structurally;
  tests use an in-memory `node:sqlite` fake — zero Cloudflare credentials or runtime).
- A minimal static dashboard (`public/index.html`) that reads the two public endpoints.

## Synthetic-data-only guard

`src/config.ts` carries the fail-closed guard:

- `POC_SYNTHETIC_ONLY = true` is a compile-time constant. A later production slice must
  deliberately change it AND remove the ingest gate before any real telemetry can be received.
- `readRuntimeConfig` defaults `FIX_METRICS_SYNTHETIC_ONLY` to `true` (env-based layer; the
  wrangler config pins it explicitly).
- `assertSyntheticOnly` runs first on the ingest path — a non-synthetic worker answers `503` and
  accepts nothing.

## Layout

```
src/
  canonical.ts    deterministic canonical JSON (RFC 8785 flavored) + SHA-256 (Web Crypto)
  config.ts       runtime config + synthetic-only guard + k/late-window/label constants
  events.ts       wire contract, per-type validation, business key / canonical hash, quarantine
  store.ts        MetricStore on the SqlDatabase interface (idempotency, snapshots, publication CAS)
  d1-adapter.ts   structural adapter for a real Cloudflare D1 binding
  projection.ts   funnel projection + monthly window snapshots (build/publish/read)
  ingest.ts       POST /api/v1/events handler
  snapshot-contract.ts  strict stored snapshot payload/metadata validation
  http.ts         tiny JSON response helpers
  worker.ts       router + default fetch export
migrations/0001_initial.sql, 0002_publication_history.sql
public/index.html
test/             node:test suites against the in-memory SQLite fake + fixed clock
wrangler.jsonc    local-only config: no routes/custom domains; D1 placeholder id + assets
```

## Run

```bash
npm test                        # inside this package
npm run typecheck               # root workspace (typechecks packages/*/src)
```

Tests use a fixed clock (`2026-08-01T12:00:00.000Z`) and synthetic run builders, so every run is
deterministic. No network, no Cloudflare login required.

## Not implemented (later slices, per the approved design)

- Signatures/trust roots, replay audit, retention audit, outbox/disposition events, client-side telemetry, cron-based snapshot publishing, and any non-synthetic deployment (routes/domains/D1 production bindings are intentionally absent).
- Per-IP/client rate limiting is a later slice and is not implemented here.
- The per-type wire contract is currently spread across several registries in `src/events.ts`
  (`KNOWN_TOP_LEVEL_FIELDS`, `typedStringFields`, `STRICT_ID_FIELDS`, `requiredFor`,
  `payloadSchemaFor`, `jointCheck`, `enumAxes`, `SANITIZABLE_ID_FIELDS`) that must stay in
  agreement. Consolidating them into one per-eventType contract table is a deliberate follow-up
  refactor, not done in this slice; `test/events.test.ts` exercises each registry against all
  five public event types.
- Snapshots are generated at the initial month boundary and subsequent fixed monthly UTC points for the same cohort, but only once a point's UTC boundary has been reached (`now >= snapshotAt`, enforced at BOTH the build and the store boundary with the server-controlled clock): windowEnd and later monthly points of an open window are never created or published as future data, and public reads return `insufficient_history` until the first boundary. Each revision is immutable and carries parent/rebuild lineage; `snapshotId` (`s_<revisionHash>`) and `revisionHash` are bound to the canonical revision content — every input that affects `responseJson` (events including their transport `receivedAt`, quarantines including safe runIds, window/as-of metadata, lineage ids) is hashed, and `dataFreshnessSeconds` is measured against the fixed as-of point, so the same canonical inputs rebuild byte-identical revisions at any build clock. `insertSnapshot` rejects forged ids/hashes, incoherent parent lineage and future as-of points, and public serving recomputes every served revision. Parent lineage is CONTINUOUS: a child revision must anchor to the immediately previous monthly fixed point of the same window (a skipped-month gap is rejected), and the WHOLE ancestor chain is validated recursively — each ancestor must content-verify, so a corrupted grandparent invalidates all of its descendants. The per-window publication pointer advances via a generation CAS that protects concurrency only: a new revision at the same fixed `snapshotAt` replaces the pointer regardless of snapshotId lexical order. A later fixed point whose previous anchor is missing or unverifiable fails closed (`missing_lineage_anchor`) instead of silently becoming a root. All direct store APIs that take the server-controlled clock (`insertSnapshot`, `publishRevision`) validate it and fail closed on invalid/NaN/non-ISO values (`invalid_server_now`); ordering inside the projection uses explicit code-point comparison, never `localeCompare`. The ingest-side verification binding is checked against already-accepted events, so a `verification_passed` arriving before its `resolution_completed` in wire order is rejected.
- Resolution-cycle branch semantics (drift, review P1.6): full terminal-cycle state — deferred or superseded cycles, disposition outcomes carried across resolution cycles — is OUT of this slice. The resolution branch of a run is the latest valid `resolution_completed` selected deterministically by `(occurredAt, resolutionCycleId)` code-point order (canonical content hash as the final tiebreak), never plain event ordering; superseded/deferred cycle semantics are a later slice.
