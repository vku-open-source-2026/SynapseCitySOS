# SOS EOC operational-parity matrix (issue #55)

Status: **source-complete in this repository** (2026-11-22). Every operator
workflow source below is committed, engine-tested against the real Tier-1
`runWorkflow` engine, and reachable from at least one DX workspace form
(`scripts/workflow-artifacts.test.mjs`: "every manifest workflow is reachable
from at least one product form"). The remaining step is owned by the SynapseDX
workspace: import → publish → install the changed SOS bundles after the next
DX deploy, then the member acceptance pass (EOP, SITREP, dispatch assign with
a second operator, mutual aid, resource status, AAR). This issue can be closed
after that pass.

Boundary: Tier-3 product sources only (`sos-*` datasets, Tier-2 public HTTPS
`https://synapsedx.sbs`). No SOS-local production persistence, no City
imports, no Tier-2 database access. See `PRODUCT_BOUNDARY.md`, `AGENTS.md`.

Verify locally:

```bash
npm run test:workflow-engine      # 30 engine-harness tests (real Tier-1 engine, fake fetch)
npm run test:workflow-artifacts  # 15 artifact/binding/pin tests (incl. per-workflow form reachability)
npm run test:aar-parity          # workflow KPI == SOS domain KPI on the shared fixture
npm run plugins:check && npm run plugins:test   # 30 bundle tests
npm run test:public-only         # 6 public-surface tests
(cd apps/sos-service && cargo test -- --test-threads=1)  # 127 Rust tests
(cd apps/gateway && cargo test)                          # 9 gateway tests
```

## EOP / command

| Operation | Tier-3 route (Rust) | Workflow source | Acceptance test | DX form(s) |
| --- | --- | --- | --- | --- |
| Create / update / delete draft | `POST/PUT/DELETE /v1/emergency/eop` (+ generic guard: published immutable) | `sos-workspace-actions` (generic) | `routes::route_tests::published_eop_is_immutable_through_generic_put` | `sos-eop-console`: Create / Update / Delete an EOP plan |
| Approve (four-eyes) | `POST /v1/emergency/eop/:id/approve` (self-approval refused) | `sos-eop-approve` | engine "eop approve consumes a four-eyes approval"; "refuses self-approvals, pending approvals and foreign entities"; Rust `an_approval_cannot_be_used_by_its_requester`, `eop_approve_and_submit_require_a_real_approval` | `sos-eop-console`, `sos-operator-review`: Approve an EOP plan (four-eyes) |
| Publish | `POST /v1/emergency/eop/:id/publish` (approved only) | `sos-eop-publish` | engine "eop publish refuses an unapproved plan and publishes an approved one" | `sos-phase-boards`: Publish an EOP plan |
| Submit (seeds dispatch) | `POST /v1/emergency/eop/:id/submit` (never demotes published) | `sos-eop-submit` | engine "eop submit seeds deterministic dispatch orders and never demotes a published plan"; Rust `eop_submit_never_demotes_a_published_plan` | `sos-eop-console`: Submit an approved plan to dispatch |
| AI draft policy | Tier-2 `ai/chat`; typed `503 ai_capability_unavailable` when unavailable, explicit opt-in deterministic fallback only (`apps/sos-service/src/ai.ts`) | n/a (capability call, not a workflow) | `domain::eop::tests::ai_prompt_carries_the_event_linked_hazards_and_resources`, `an_ai_payload_becomes_a_complete_draft_with_provenance`, `draft_generation_is_deterministic_and_event_specific` | `sos-eop-console` review/publish lane |
| Event-linked command context | deploy/links on hazard + `linked_event_id` / `linked_eop_plan_id` | read-your-writes via Tier-2 record GET in each lifecycle workflow | `domain::eop::tests::plan_order_seeds_map_actions_one_to_one_and_ignore_empty_plans` | `sos-event-command`: Hazard context table; `sos-rescue-operations` / `sos-responder-board`: Event context tables |

## SITREP

| Operation | Tier-3 route (Rust) | Workflow source | Acceptance test | DX form(s) |
| --- | --- | --- | --- | --- |
| Create / update / delete draft | `POST/PUT/DELETE /v1/emergency/sitrep` | `sos-workspace-actions` (generic) | `domain::sitrep::tests::create_requires_event_title_period_and_non_negative_counters`, `published_sitreps_are_immutable…` | `sos-sitrep-desk`: Create / Update / Delete a SITREP |
| Publish | `POST /v1/emergency/sitrep/:id/publish` (review-pending + content guard) | `sos-sitrep-publish` | engine "sitrep publish moves a review_pending SITREP to published"; "refuses published, contentless and unreviewed SITREPs" | `sos-sitrep-desk`, `sos-operator-review`, `sos-phase-boards`: Publish a SITREP |
| Calculated delta | `POST /v1/emergency/sitrep/:id/delta` (draft: append; published: amending revision) | `sos-sitrep-delta` (real changed-fields diff, no-op refused) | engine "sitrep delta appends a real structural delta"; "against a published SITREP creates an amending revision"; "refuses a no-op delta before any write"; `domain::sitrep::tests::a_delta_against_a_published_sitrep_creates_a_new_revision` | `sos-sitrep-desk`: Record a calculated SITREP delta |

## Dispatch / rescue

| Operation | Tier-3 route (Rust) | Workflow source | Acceptance test | DX form(s) |
| --- | --- | --- | --- | --- |
| Create order | `POST /v1/emergency/dispatch` | `sos-dispatch-create` | engine "real engine executes valid creates"; Rust `dispatch_and_hazard_validation_happens_before_tier2` | `sos-command-overview`, `sos-dispatch-board`: Create a dispatch order |
| Assign (four-eyes) | `POST /v1/emergency/dispatch/:id/assign` (reserves unit, compensates on terminal) | `sos-dispatch-assign` | engine "four-eyes dispatch assignment reserves the unit"; "refuses a self-approval and never reserves"; "a terminal order releases its stranded reservation"; Rust `dispatch_assignment_*`, `repeating_a_dispatch_assignment_is_idempotent` | `sos-dispatch-board`: Assign a resource unit (four-eyes) |
| Start transit (`assigned` → `in_transit`) | `POST /v1/emergency/dispatch/:id/start` | `sos-dispatch-progress` | engine "dispatch progression moves an assigned order to in transit"; "refuses terminal orders and invalid transitions"; Rust `dispatch_start_moves_an_assigned_order_to_in_transit`, `invalid_dispatch_progression_is_rejected` | `sos-dispatch-board`: Start transit |
| Arrive (`in_transit` → `on_scene`) | `POST /v1/emergency/dispatch/:id/arrive` | `sos-dispatch-progress` | same progression suite; Rust `dispatch_arrive_moves_an_in_transit_order_to_on_scene` | `sos-dispatch-board`: Mark on scene |
| Complete | `POST /v1/emergency/dispatch/:id/complete` (requires real assignment) | `sos-dispatch-complete` | engine "dispatch completion requires a real assignment"; "real engine merges and conditionally patches dispatch status" | `sos-dispatch-board`: Complete a dispatch order |
| Reject | `POST /v1/emergency/dispatch/:id/reject` (from `pending`/`assigned`) | `sos-dispatch-reject` | engine "refuses terminal records and surfaces CAS conflicts" (PATCH family) | `sos-dispatch-board`: Reject a dispatch order |
| Optimize (Tier-2 adoption) | `POST /v1/emergency/dispatch/optimize` (read-only proposal without approval; four-eyes apply with event scope) | proposal consumed via record reads; apply reuses the assign/approve guards | `domain::optimizer::tests::*` (7 tests: capability mapping, nearest-compatible, no reuse, stale/terminal skip, shelter district guard); Rust `optimize_without_an_approval_returns_a_read_only_proposal`, `optimize_with_a_four_eyes_event_approval_applies_assignments`, `optimize_rejects_a_self_approved_event_approval`, `optimize_cannot_apply_an_approval_without_the_event_scope` | read-only proposal surfaced through the dispatch queue tables |
| Responder progression (field) | same start/arrive routes | `sos-dispatch-progress` | same as above | `sos-rescue-operations`, `sos-responder-board`: Start a task / Mark on scene |
| Event-linked context | timeline fails closed when the dispatch scan fails | `sos-event-close` dispatch scan (truncation fails closed) | Rust `sos_timeline_fails_when_the_dispatch_scan_fails`; engine "a truncated AAR input page fails closed" | `sos-command-overview`: Dispatch queue table; `sos-responder-board`: Assignments list + Event context |

## Mutual aid

| Operation | Tier-3 route (Rust) | Workflow source | Acceptance test | DX form(s) |
| --- | --- | --- | --- | --- |
| Create / update / delete request | `POST/PUT/DELETE /v1/emergency/mutual-aid` | `sos-workspace-actions` (generic) | `domain::mutual_aid::tests::request_validation_checks_required_capacity_fields_and_dedupes_retries` | `sos-mutual-aid`: Create / Update / Delete a request |
| Accept (reserves capacity, refuses shortfall) | `POST /v1/emergency/mutual-aid/:id/accept` | `sos-mutual-aid-accept` | engine "mutual-aid acceptance reserves lending capacity"; "fails closed on capacity and request guards"; `domain::mutual_aid::tests::optimistic_versions_reject_the_second_accept_in_a_race`, `partial_fills_never_exceed_capacity`; Rust `mutual_aid_accept_rejects_a_stale_expected_version` | `sos-mutual-aid`: Accept a mutual-aid request |
| Decline | `POST /v1/emergency/mutual-aid/:id/decline` (open/partially-filled only) | `sos-mutual-aid-decline` | engine "mutual-aid decline and handoff enforce the open-status guard" | `sos-mutual-aid`: Decline a mutual-aid request |
| Handoff | `POST /v1/emergency/mutual-aid/:id/handoff` (open/partially-filled only, immutable after) | `sos-mutual-aid-handoff` | same guard suite; Rust `mutual_aid_handoff_rejects_a_request_that_is_not_open` | `sos-mutual-aid`: Hand off a mutual-aid request |

## Resources

| Operation | Tier-3 route (Rust) | Workflow source | Acceptance test | DX form(s) |
| --- | --- | --- | --- | --- |
| Register / update / remove unit | `POST/PUT/DELETE /v1/emergency/resources` | `sos-workspace-actions` (generic) | `routes::route_tests::resource_status_*` (vocabulary enforced at the status route) | `sos-resource-registry`: Register / Update / Remove a resource unit |
| Lifecycle status | `POST /v1/emergency/resources/:id/status` (full vocabulary, retired terminal, appended history) | `sos-resource-lifecycle` | engine "resource lifecycle audits a valid transition and makes retired terminal"; Rust `resource_status_enforces_the_lifecycle_vocabulary`, `resource_status_rejects_transition_table_violations`, `retiring_a_resource_unit_is_a_one_way_transition` | `sos-resource-registry`: Change resource lifecycle status |
| Shelters near (public) | `GET /v1/emergency/resources/shelters/near` (unauthenticated) | read-only | public-only suite (6 tests) | `sos-volunteer-desk`: Shelters and resources |

## Hazards / VNDMS ingest

| Operation | Tier-3 route (Rust) | Workflow source | Acceptance test | DX form(s) |
| --- | --- | --- | --- | --- |
| Record / update / delete layer | `POST/PUT/DELETE /v1/hazards` (generic PUT cannot touch lifecycle fields) | `sos-workspace-actions` (generic) | Rust `generic_put_cannot_change_lifecycle_fields`, `feed_hazards_with_a_point_keep_their_real_coordinates`, `feed_hazards_without_a_point_never_get_fabricated_coordinates` | `sos-hazard-watch`: Record / Update / Delete a hazard layer |
| Deploy (links event + plan) | `POST /v1/hazards/:id/deploy` | read-your-writes chain (event + EOP plan) | route deploy path covered by hazard suite | drill-down from `sos-hazard-watch`: Hazard layers table |
| Lifecycle transition + audit | `POST /v1/hazards/:id/status` (`monitoring` ↔ `active` → `expired`/`resolved`, `status_history` appended with actor/note) | n/a (operator transition; ingest scheduling stays with the crawler) | Rust `hazard_status_transition_is_explicit_and_versioned` | `sos-hazard-watch`: Expire or resolve a hazard |
| Expire stale | `POST /v1/hazards/expire-stale` (bounded TTL scan) | n/a (service-initiated hygiene, not an operator form) | `domain::hazards::tests::old_active_hazards_are_stale`, `ttl_is_configurable_but_bounded` | — (no operator UI by design; same class as ingest scheduling) |
| Ingest batch | `POST /v1/hazards/ingest` (authenticated feed sink; scheduling owned by Tier-2, not SOS) | n/a | `domain::vndms::tests::ingest_batch_normalises_and_rejects_invalid_records`; Rust `hazard_ingest_accepts_only_the_service_principal_or_dispatch_roles` | `sos-hazard-watch`: Queue a hazard ingest run (manual intake record) |
| Ingest status / connector | `GET /v1/hazards/ingest/status` (push run + `jobs/:id/runs` freshness) | n/a (read model) | `domain::vndms::tests::ingest_status_combines_a_push_run_with_connector_freshness`, `connector_status_is_derived_from_the_job_and_run_history`; Rust `ingest_status_*` (3 tests) | `sos-hazard-watch`: Ingest runs table |
| History / timeline | `GET /v1/emergency/sos/timeline` (fails closed on scan failure) | event-close scan | Rust `sos_timeline_fails_when_the_dispatch_scan_fails` | `sos-event-command`: Events + Hazard context tables |
| Geo | `GET /v1/hazards/geo/near`, `POST /v1/hazards/geo/in-polygon`, `/v1/geo/*`, `/v1/map/*` (public) | n/a (read model) | `domain::geo::tests::*` (10 tests) | `sos-command-overview`, `sos-event-command`, `sos-rescue-operations`: live maps |
| Live stream | `GET /v1/emergency/stream/hazards` (named `error` event, keeps last-good snapshot; never renders an outage as safe) | n/a (transport) | `domain::hazards::tests::sse_frames_use_real_newline_bytes`; gateway `forwards_sse_streams_without_buffering` | maps above |

## Events / AAR / auth / public

| Operation | Tier-3 route (Rust) | Workflow source | Acceptance test | DX form(s) |
| --- | --- | --- | --- | --- |
| Open / update / phase / delete event | `POST/PUT/DELETE /v1/emergency/events` | `sos-event-create` (open), `sos-workspace-actions` (update/phase/delete) | engine "real engine executes valid creates"; Rust `create_with_an_existing_id_returns_409_instead_of_overwriting` | `sos-command-overview`, `sos-event-command`: Open / Update / Advance phase / Delete |
| Close event (chains AAR) | `POST /v1/emergency/events/:id/close` (AAR draft first, reuse existing, resolved idempotent) | `sos-event-close` | engine "creates the AAR before patching"; "an existing AAR is reused"; "already resolved is idempotent"; terminal/CAS suite | `sos-command-overview`, `sos-event-command`: Close an event |
| AAR draft / publish | `POST /v1/emergency/after-action`, `POST /v1/emergency/after-action/:id/publish` (KPI required, single publication) | `sos-aar-publish` | engine "AAR publication stamps the report and keeps the KPI payload"; "refuses a missing KPI and a second publication"; `test:aar-parity` (workflow KPI == domain KPI); `domain::after_action::tests::*` (6 tests) | `sos-after-action`: Create / Update / Publish (+ dual publish lane) |
| Session exchange | `POST /v1/auth/exchange` (Tier-2 bearer → short-lived SOS session); every other `/v1/auth/*` → `410 workspace_moved` | n/a | Rust `tier2_exchange_issues_an_sos_session_for_a_verified_bearer`; TS `every /v1/auth request returns 410 workspace_moved` | retired console routes redirect `308` to `https://synapsedx.sbs/workspace` |
| Public projection | `GET /v1/emergency/public`, `/v1/emergency/public/status`, `/v1/sos`, `/v1/hazards/recent`, `/v1/hazards/vndms-live` (anonymous) | n/a (read model) | Rust `public_events_projection_reads_published_entities`, `public_hazards_recent_merges_the_tier2_feed`, `public_status_counts_the_merged_feed_and_reports_stale_ingest`; `test:public-only` (6) | `sos-volunteer-desk` (read-only picture); public map `/map` |

## Documented non-goals (not gaps)

- **QR/NFC scanning** — needs a dedicated widget contract + native capability; no page advertises it (`plugins/workflows/README.md`).
- **Shelter management** — fixed facilities, not rescue logistics; registry covers shelters only as locations.
- **Hazard ingest scheduling** — owned by the crawler/ingest service via Tier-2 `jobs`; SOS exposes the feed sink + status, operators do not schedule.
- **SOS volunteer writes** — volunteers are read-only on product data; writes live in Common workspace capabilities (tasks, reports, files, approvals).
- **Reverse-geocode / geospatial helpers as workflows** — Tier-3 read routes exist with domain tests; no dedicated operator workflow.
- **Dispatch auto-apply of optimizer proposals** — proposals are read-only without a four-eyes event approval; application reuses the assign guards.

## Remaining (SynapseDX side, not this repository)

1. Deploy DX, then import → publish → install the changed SOS bundles (pins are
   import-ready: `npm run plugins:pins` verifies 18 sources).
2. Member acceptance pass: EOP, SITREP, dispatch assign with a second operator,
   mutual aid, resource status, AAR.
3. Close issue #55 after that pass.
