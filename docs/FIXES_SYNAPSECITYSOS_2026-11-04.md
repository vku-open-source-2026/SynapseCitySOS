# SynapseCitySOS — audit remediation verification (2026-11-04)

Scope: issues #10–#21 from
[tracker #9](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/9).
This file records what changed, how it was verified, and what remains blocked on
Tiers 1–2. It does not modify the historical audit reports.

## Verification commands

Run in `SynapseCitySOS` unless noted.

| Check | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | PASS — console, gateway, sos-service |
| Unit/contract | `npm test` | PASS — 129 tests (console 27, gateway 10, sos-service 92) |
| Console lint | `npm run lint --workspace=@synapsecity/sos-console` | PASS |
| Console e2e | `npm run test:e2e --workspace=@synapsecity/sos-console` | PASS — 42 tests / 5 files |
| Compose config | `docker compose config` | PASS |
| Compose build | `docker compose build` | PASS — all three images |

## Issue status

| # | Status | Fix / remaining |
| --- | --- | --- |
| #10 | Fixed | SSE emits a named `error` event and keeps the last good snapshot; the public map shows a degraded banner and never "safe" while data is unavailable; `/health`, `/ready`, `/v1/emergency/health` report per-dependency state. |
| #11 | Fixed | `active_only`/`is_active` are parsed as booleans against `is_active`; `hours` is enforced; tests cover active/inactive/all. |
| #12 | Fixed | `near` and `in-polygon` validate input, use haversine/point-in-polygon, page, sort by distance and reject invalid geometry. |
| #13 | Partially fixed / open | Flat VNDMS wire schema, validated push ingest (`POST /v1/hazards/ingest`), run history in `sos-hazard-ingest-runs`, honest status, no "live" copy. Scheduled pull remains Tier-2 (#26). |
| #14 | Partially fixed / open | Event-specific deterministic EOP draft, versioning, idempotency, provenance, no fake AI. Real AI generation remains Tier-2 (#11) / Tier-1 (#26). |
| #15 | Fixed | Submit creates idempotent pending dispatch orders; optimizer assigns compatible available units, computes ETA and flags stale orders; counts match writes. |
| #16 | Fixed | AAR KPI/timeline computed from event/dispatch/SITREP/resource; resolve creates one draft AAR; SITREP validation, lifecycle and immutable published reports; SLA threshold exposed. |
| #17 | Fixed | Demo auth disabled by default and refused in production; client roles ignored; tokens never accepted in a URL; sessionStorage replaces localStorage; biometric replay removed; rate limits and security headers added. |
| #18 | Fixed | Phase boards call real APIs; SITREP compose/publish and AAR detail/KPI/timeline live in the during/after boards; resource-unit creation in the before board; public nearby-shelter query. |
| #19 | Partially fixed / open | Public projections now read `datasets.entities` (NGSI-LD) and filter terminal statuses. Published SDK, Tier-2 event subscription and a true stream remain blocked on SynapseDX #14/#7/#12/#13. |
| #20 | Partially fixed / open | Deploy idempotent; approvals require a usable unit; 409-only create retry; paged expire-stale; local write serialisation + `if_version` 409; gateway timeouts, binary-safe console proxy, HEAD, logs and `/metrics`. Cross-process conditional writes still need Tier-2 ETags (SynapseDX #27). |
| #21 | Fixed | Permission matrix enforced on every mutation (`emergency:read/write/dispatch/eop`); 401/403/200 tests across all six roles. |

## Lower-tier dependencies still open

- `SynapseDX` #14 — publish `@synapsedx/capabilities`; SOS still uses the
  workspace `file:` dependency and prebuild.
- `SynapseDX` #7/#12/#13 — queue-backed event subscription with replay; SOS
  keeps bounded 30 s polling with explicit degraded/error state.
- `SynapseDX` #11 / `SynapseOne` #26 — AI capability; SOS labels drafts
  `deterministic-fallback` and returns `503 ai_capability_unavailable`.
- `SynapseDX` #5/#13/#17 / `SynapseOne` #29 — server-side predicates,
  spatial and aggregate queries; SOS pages then filters within a bounded scan.
- `SynapseDX` #26 — scheduled VNDMS connector; SOS only provides the validated
  sink and run history.
- `SynapseDX` #27 — record version/ETag conditional update; SOS serialises
  in-process writes and honours `if_version` on supported paths.
