# SOS workflow artifacts (operation migration source)

Status: **create and status-transition flows (including event close/AAR) are
source-ready and engine-tested against the real Tier-2 record envelope and the
real Tier-1 engine; credential binding and deployment are not done.** No
production redirect or page retirement is deployed.

| Operation | Artifact | Tier-2 dataset | Status |
| --- | --- | --- | --- |
| `emergency.events.create` | `sos-event-create.workflow.json` | `sos-emergency-events` | source-ready |
| `emergency.dispatch.create` | `sos-dispatch-create.workflow.json` | `sos-dispatch-orders` | source-ready |
| `dispatch.complete` | `sos-dispatch-complete.workflow.json` | `sos-dispatch-orders` | source-ready |
| `dispatch.reject` | `sos-dispatch-reject.workflow.json` | `sos-dispatch-orders` | source-ready |
| `emergency.close` | `sos-event-close.workflow.json` | `sos-emergency-events` + `sos-after-action-reports` | source-ready |

## Functional create flow

`manualTrigger` → sandboxed `code` validation → `httpRequest`:
`POST https://synapsedx.sbs/v1/capabilities/datasets/<dataset>/records`.

- Input is the real DX helper envelope
  `{pluginId,widgetId,product,resource,submittedBy,submittedAt,fields}`; unknown
  envelope/field keys and wrong product/resource are rejected.
- Domain validation mirrors SOS (`event_type`/`severity`/priority enums,
  title/task length, event reference). The dataset and `publish` flag are
  derived server-side (`events → sos-emergency-events`, publish `true`;
  `dispatch → sos-dispatch-orders`, publish `false`). A submitted
  datasource/dataset/id is never accepted.
- Body is `{ data: <domain record>, publish: <boolean> }` (Tier-2 records
  create contract). No Base SDK, no LDS projection, no Tier-3 API.
- Auth is `parameters.auth = {credentialRef: "synapsedx-organization", header:
  "X-API-Key", allowedOrigins: ["https://synapsedx.sbs"]}`. The source stores
  only the **credentialRef**; DX must resolve it to a same-org API-key credential
  (workflow worker owns binding) and pin the artifact before activation. The
  exact origin allowlist is required by credential-backed `httpRequest`; DX
  must not widen it.

## CredentialRef convention (proposed to the workflow worker)

- Source value: `synapsedx-organization` (portable placeholder only; no
  deployment credential id or secret exists in this repository). Every
  credential-backed node also carries `allowedOrigins:["https://synapsedx.sbs"]`;
  the engine refuses a credential request without an exact origin allowlist.
- DX import binds it to the organization's technical **owner-only encrypted**
  api-key credential; the binding is stored server-side per organization.
- DX export rewrites the bound deployment credential into the portable source
  reference (export rebinding), so a repository bundle never contains a
  deployment id or secret.
- DX verifies the artifact graph checksum/revision pins at execution (runtime
  checksum) and rejects drift.
- Tier-2 gateway user-key identity is the authorization boundary; the workflow
  does not carry a user token and does not call Tier-3.

## Engine test (local only)

```bash
npm run test:workflow-engine
```

This runs the real Tier-1 `runWorkflow` engine with a fake `fetch` transport
(no network, no real credential) and fake records shaped like the Tier-2 API
(`{id,data,version}`). It asserts the exact POST URL, `X-API-Key` from an
in-memory api-key resolver, `{data,publish}` body, validated domain fields, the
audit object, transition GET(`includeInput`)→merge→PATCH with `ifVersion`,
terminal refusal, `409` CAS propagation, AAR-before-event-close, the legacy AAR
KPI values, AAR reuse, resolved-event idempotency, the dispatch assignment
invariant, and that a malformed form fails before any HTTP call.

The machine-readable transition design is `actions.design.json` in this
directory (operations, required fields, allowed states, patch, invariants and
the engine blocker). `manifest.json` carries the machine-readable
`transitionRules` and `aarInvariants`.

## Status transitions and event close

Dispatch transitions use `manualTrigger` → validation → **GET with
`includeInput:true`** → state/merge `code` → **PATCH with `{data, ifVersion}`**.

- `dispatch.complete`: allowed from `pending|assigned|in_transit|on_scene`; a
  terminal order is refused, and completion requires an actual
  `assigned_resource_unit_id` (or a legacy assignment carrying the same id).
  The patch is `{status:"completed", completed_at}`.
- `dispatch.reject`: allowed from `pending|assigned`; the patch is
  `{status:"canceled"}` and the full-record merge keeps assignment history.
- Both preserve unrelated record fields, including `metadata`, and send the
  version returned by GET as `ifVersion`.

Event close chains the primitive across collections:

1. GET event with `includeInput:true`; normalize `id` from the record envelope;
   refuse `canceled`/`archived` and statuses outside
   `monitoring|active|contained|resolved`.
2. Query dispatch orders, SITREPs, resource units and existing AARs for the
   event. Query rows are unwrapped from the Tier-2 `{id,data,version}` envelope
   before the KPI engine reads domain fields. Queries request the Tier-2 max
   page size (500); if `total` exceeds the returned page the run fails with
   `query_truncated_<collection>` instead of scoring partial data (the legacy
   service scans up to 5000 rows; a future loop node can lift this cap). AAR
   rows are ordered by `version:desc` so the latest version is always on the
   first page.
3. Decide the close path:
   - `resolved` event → **idempotent**: return the latest AAR id, no writes;
   - existing AAR → **reuse** it (legacy `generateAar` without force), no
     duplicate AAR;
   - otherwise → **create** the next versioned AAR (`aar-<event>-v<N>`,
     `report_code AAR-<event_code>-v<N>`, `status:draft`, `publish:false`).
4. Create the AAR draft first (create path only), then merge the event to
   `status=resolved` + `ended_at` + `resolution_note` +
   `after_action_report_id` + `resolved_by` and PATCH with `ifVersion`.

The KPI formula, timeline entries, summary sentences and metadata mirror
`apps/sos-service/src/after-action.ts`. `event_end` in the AAR metadata and the
event `ended_at` are the same captured close timestamp. `resolution_note`
falls back to the existing event note when the form omits it.

- `includeInput:true` returns `{statusCode, body, input}` (cloned incoming
  value), preserving action fields across reads; the 500KB combined output limit
  still applies.
- **Concurrency contract:** Tier-2 PATCH supports optimistic CAS via
  `If-Match`/`ifVersion`; a concurrent write returns `409 version_conflict`
  and fails the run. AAR-create + event-PATCH are two records, not one
  transaction: AAR-first means a conflict leaves a draft AAR to reconcile,
  never a resolved event without an AAR. A retry reuses that draft.

## Remaining action gap

Migrated: event/dispatch create, dispatch complete/reject, event close. Still
unmigrated: dispatch assignment/approval, dispatch start/in-transit/on-scene,
EOP create/approve/publish, SITREP publish/delta, resource updates, mutual aid,
shelters, hazard ingest, after-action publish. The widget vocabulary declares
`create`/`update`; other actions need a DX action design.

## Validation

```bash
npm run test:workflow-artifacts
npm run test:workflow-engine
npm run test:aar-parity
npm run workflows:validate
```

## Provenance

Repository `https://github.com/vku-open-source-2026/SynapseCitySOS`, revision
`2026-11-14`. Tier-3 API paths (`POST /v1/emergency/events`,
`POST /v1/emergency/dispatch`) are provenance only and are not called by the
workflow or DX.
