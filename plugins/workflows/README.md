# SOS workflow artifacts (operation migration source)

Status: **create, dispatch, EOP lifecycle, SITREP publication/delta, mutual-aid
lifecycle, resource lifecycle and AAR publication flows are source-ready and
engine-tested** (2026-11-20 parity batch). The 2026-11-14 live run covered the
create/transition batch; the parity batch still needs the operator import →
publish → install step in DX before its forms are live. The public-only
redirects are deployed.

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

## Operator parity batch (17 workflows)

The operator operations the Tier-3 routes implement are now workflow sources
that read and write the same Tier-2 datasets with the same reviewed rules:

| Operation | Artifact | Guards |
| --- | --- | --- |
| `eop.approve` | `sos-eop-approve.workflow.json` | four-eyes approval, action/entity match |
| `eop.publish` | `sos-eop-publish.workflow.json` | approved plan only |
| `eop.submit` | `sos-eop-submit.workflow.json` | approved plan, deterministic dispatch seeding |
| `sitrep.publish` | `sos-sitrep-publish.workflow.json` | review-pending + content guard |
| `sitrep.delta` | `sos-sitrep-delta.workflow.json` | real changed-fields diff, amending revision |
| `dispatch.assign` | `sos-dispatch-assign.workflow.json` | four-eyes, unit reservation, release compensation |
| `dispatch.progress` | `sos-dispatch-progress.workflow.json` | start only from `assigned`, arrive only from `in_transit` |
| `mutualAid.accept` | `sos-mutual-aid-accept.workflow.json` | open request, capacity reservation + shortfall refusal |
| `mutualAid.decline` | `sos-mutual-aid-decline.workflow.json` | open/partially-filled only |
| `mutualAid.handoff` | `sos-mutual-aid-handoff.workflow.json` | open/partially-filled only (immutable after) |
| `resource.status` | `sos-resource-lifecycle.workflow.json` | full status vocabulary, retired terminal, audit history |
| `afterAction.publish` | `sos-aar-publish.workflow.json` | KPI present, not already published |

Four-eyes workflows read the Tier-2 approvals record and require
`status=approved`, a matching `entityId`/`action`, and `requester ≠` the
executing operator — the same rule the Rust route enforces
(`self_approval_forbidden`). Approval and file nodes send
`X-Workspace-App: sos`: common capability records live in the app-scoped
tenant (`<org>:common:sos`), so a workflow without the header reads the org
tenant and gets `404`.

`plugins/sos-volunteer-desk.plugin.json` has no product write form by design:
SOS volunteers are read-only on product data and their writes live in the
Common workspace capability forms (tasks, reports, files, approvals). This is
a product decision, not a migration gap.

## Remaining action gap

Still without a dedicated workflow: shelter management, hazard ingest
scheduling (owned by the crawler/ingest service, not operators) and the
reverse-geocode/geospatial helpers. The widget vocabulary declares
`create|update|delete|execute`; every status transition above is bound with
`action=update` and a `workflowRef` pin in its plugin bundle.

## Acceptance matrix

The per-form acceptance matrix for issue #55 (every archived SOS operation →
Tier-3 route → workflow source → test evidence → DX form, plus explicit
non-goals) is `docs/EOC_PARITY_MATRIX.md`. `npm run test:workflow-artifacts`
enforces that every manifest workflow stays reachable from at least one
product form, so a tested-but-unreachable operation fails CI instead of
silently regressing to API-only.

## Documented non-goals

- **QR/NFC scanning.** Public check-in / asset-tag scanning needs a dedicated
  widget contract and a native capability; it is not part of this parity wave
  and no page advertises it.

## Workflow pins

Every bundle form pins its workflow with `workflowRef.checksum` equal to the
**DX portable checksum** DX will store on the imported artifact: sha256 over the
canonical `{nodes, connections, settings}` *including the mandatory
`settings.access.mode=owner-only` policy DX injects on a managed import*. A
stale pin fails the live import with `409 workflow_artifact_not_found`, so the
sources declare the policy themselves and
`npm run plugins:pins` (or `node scripts/workflow-pins.mjs --fix`) verifies and
repairs the pins offline. The artifact test suite enforces the invariant.

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
