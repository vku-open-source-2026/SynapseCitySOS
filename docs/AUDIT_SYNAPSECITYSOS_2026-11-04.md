# SynapseCitySOS — independent Tier-3 audit (2026-11-04)

Status: **audit complete**, 1 tracker + 11 focused GitHub issues filed.
Auditor: independent Tier-3 audit (read-only for source; this report is the only file added).
Repository: `vku-open-source-2026/SynapseCitySOS`, branch `main`, commit `5ad03b0`.
Audited against: workspace `AGENTS.md` / `FEATURE_BOUNDARY.md`,
`SynapseCitySOS/AGENTS.md`, `PRODUCT_BOUNDARY.md`, `README.md`.

## 1. Scope and method

Reviewed:

- `apps/sos-service/src/` — `server.ts`, `auth.ts`, `hazards.ts`, `dispatch.ts`,
  `vietmap.ts`, all tests and the built `dist/`;
- `apps/gateway/src/index.ts`;
- `apps/console/src/` — all API clients, stores, hooks, pages, phase boards,
  route tree and e2e specs;
- `infra/nginx/synapsecity-sos.conf`, `docker-compose.yml`, `.env.example`,
  `package.json` workspaces and lockfile;
- lower tiers: `SynapseDX` capabilities service + `@synapsedx/capabilities` SDK,
  and open/closed issues in `SynapseOne`, `SynapseDX`, `SynapseCity`,
  `SynapseCitySOS`.

The Task asks for evidence, not opinions: every finding below cites a
`file:line` or an endpoint, and the behavioural claims were reproduced against
the built service using an in-memory fake Tier-2 client (no production
credentials were available, so no live Tier-2 integration test was possible).

Limitations: `docker compose up` and a live `https://synapsedx.sbs` call were
not run; the review is therefore contract/behaviour level, not a production
penetration test. The nginx snippet was reviewed, not exercised behind TLS.

## 2. Build, test and lint results (this run)

Commands run in `/home/phamngoclananh30032009/OLP_OSS_2026/SynapseCitySOS`.

| Check | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | **PASS** — console `tsc -b && vite build` (1962 modules, 851.05 kB JS / 256.73 kB gzip; only the >500 kB chunk warning), gateway `tsc`, sos-service prebuild (`SynapseDX` SDK) + `tsc` |
| Unit/contract tests | `npm test` | **PASS** — 67 tests, exit 0: console 25 tests / 4 files, gateway 8 tests, sos-service 34 tests |
| Console lint | `npm run lint` (apps/console) | **PASS** — `eslint .`, no output, exit 0 |
| Console e2e | `npm run test:e2e` (apps/console) | **PASS** — 42 tests / 5 files, 144.84 s, Chromium headless |
| Gateway boundary tests | included in `npm test` | **PASS** — foreign/unknown/encoded `/v1` → 404 `{error:"not_found"}`, binary proxy helper byte-safe |
| Service boundary tests | included in `npm test` | **PASS** — `sos-*` dataset guard, foreign City namespaces 404, public/protected route matrix |
| Route tree | `apps/console/src/routeTree.gen.ts` | **PASS** — only owned routes (see §3) |
| Tier-1 contamination | grep `@synapseone`, `api.synapseone`, private ports | **PASS** — none in `apps/*/src` |

Caveats that matter for interpretation:

- The tests assert the current stub behaviour. E.g. there is no test for the
  `active_only` query, geo filtering, EOP submit, dispatch optimize, AAR KPI or
  role escalation, so green tests do not mean the emergency features work.
- The e2e specs short-circuit when the login view is rendered
  (`apps/console/e2e/emergency.spec.ts:36-46`, `isLoginViewVisible()` returns
  early), so they verify layout/navigation, not API contracts.
- The vite bundle is a single 851 kB chunk; not a release blocker, but it
  delays first paint on the public emergency page.

## 3. Product-boundary verdict (City vs SOS)

**Pass — no City infrastructure features remain.**

- `routeTree.gen.ts` contains only `/`, `/about`, `/docs`, `/map`, `/login`,
  `/register`, `/admin`, `/admin/emergency-center`,
  `/admin/emergency-center/before|during|after`,
  `/admin/emergency-center/operations/$eventId`, `/admin/settings`.
- No source import of City modules, no call to `https://synapsecity.sbs/v1`,
  no `city-*` dataset. Cross-product references are navigation links only
  (`Header.tsx:188`, `Footer.tsx:56`, `Sidebar.tsx:165`,
  `ApiDocsPage.tsx:799`).
- Dataset prefix guard at `apps/sos-service/src/server.ts:31-46`; gateway
  foreign-prefix guard at `apps/gateway/src/index.ts:20-35,209-221`.
- `GET /v1/sos` advertises owned features and `notOwned` City features
  (`server.ts:50-98`).
- No Tier-1 import or SynapseOne URL in `apps/*/src`.
- `affected_asset_ids` is stored as opaque ids and **is not exposed** by
  `/v1/emergency/public` (the projection whitelist at `server.ts:304` omits it);
  it is only returned on the authenticated `GET /v1/emergency/:id`.
- No NGSI-LD claim exists in SOS documentation, so returning custom JSON is not
  a false NGSI-LD claim; it is still the wrong Tier-2 surface (§6.2).

The real boundary problem is the opposite direction: **SOS implements Tier-1/Tier-2
concerns locally** (identity, AI, streaming, filtering, scheduling) instead of
calling capabilities that do not exist yet in Tier 2. That is captured in §6.

## 4. Feature gaps — claims vs reality

| Claimed feature | Reality | Evidence | Issue |
| --- | --- | --- | --- |
| VNDMS live ingestion | No client, parser, scheduler or ingestion code exists. `/v1/hazards/vndms-live` is an unfiltered dataset read; `/v1/hazards/ingest/status` is a hardcoded literal with `last_run_at:null`. | `server.ts:375-376`; `useVndmsHazards.ts:3-21`; `VndmsHazardLayer.tsx:44-56`; `HomePage.tsx:30,272` | #13 |
| SOSConn provider status | `reachable`/`configured` are `Boolean(SERVICE_KEY)`; no provider call, no model. | `server.ts:307`; `ApiDocsPage.tsx:196-201` | #17, #19 |
| EOP AI draft | Empty template (`objectives:[], actions:[], assignment_matrix:[]`); `force_new_version` ignored; every call creates a new `version:1` row. | `server.ts:325,398`; `EmergencyCenter.tsx:333-346`; `ApiDocsPage.tsx:277-284` | #14 |
| EOP submit generates tasks | Returns `{plan_id, task_source, orders: []}` and never writes a dispatch order. | `server.ts:329`; `DeployEopModal.tsx:44-52`; `RescueOperationPage.tsx:417-423` | #15 |
| Dispatch optimizer v2 | Returns all zeros and touches nothing; UI prints "optimized 0, auto_assigned 0". | `server.ts:332`; `EmergencyCenter.tsx:348-358` | #15 |
| AAR from event/dispatch/SITREP | Writes empty `timeline` and all-zero `kpi`; `force_regenerate` ignored; `resolve` never creates an AAR. | `server.ts:359,368`; `EmergencyCenter.tsx:361-367,738` | #16 |
| SITREP/AAR validation | Generic CRUD; `{}` creates a SITREP; published SITREPs can still receive deltas; publish has no review state. | `server.ts:356-358`; `ApiDocsPage.tsx:380-415` | #16 |
| AI assistant (`/v1/ai/chat`) | Static echo of a canned sentence; `provider` is just the product name. | `server.ts:468-469`; `ApiDocsPage.tsx:455-463` | #14 |
| Hazard geo search | `near` and `in-polygon` return every row; coordinates/polygon are unused; empty polygon accepted. | `server.ts:373-374`; `ApiDocsPage.tsx:235-245` | #12 |
| Phase boards | Three screens that render "Extension point" placeholder cards; zero API calls; landing page counts stubs as features. | `phaseBoardDefinitions.ts`; `PhaseBoardTemplate.tsx:70-92`; `SectionStubPanel.tsx:18-31`; `EmergencyBoardsLandingPage.tsx:28-33` | #18 |
| SITREP / AAR console surfaces | No SITREP compose/detail route; AAR only has a generate/publish list, no KPI/timeline detail. | `routeTree.gen.ts`; `Sidebar.tsx:55-71` | #18 |
| Emergency resource units UI | No management screen; only raw API. Dispatch picker is empty without manual API seeding. | `routeTree.gen.ts`; `RescueOperationPage.tsx:196-202` | #18 |
| Public "nearby shelter" | Button opens the generic safety modal; never queries `resource_type="shelter"`. | `DisasterMap.tsx:819-825` | #18 |

## 5. Bugs and regressions

### P0

1. **Every hazard list is empty.** The console rewrites `is_active` to
   `active_only` (`api/hazards.ts:24-30`), but the service filters by the
   literal record field name (`server.ts:259-261,318`). Stored records have
   `is_active`, not `active_only`, so `GET /v1/hazards?active_only=true`
   returns `[]`. Affected: public map (`DisasterMap.tsx:381`), SOS dashboard
   (`SosDashboard.tsx:67`), command centre (`EmergencyCenter.tsx:114,137`).
   Reproduced: see §9.1. **Issue #11.**
2. **Outage presented as all-clear.** SSE catches every Tier-2 error and writes
   `{snapshot: []}` (`server.ts:421-424`); the map turns zero data into
   "Khu vực bạn hiện an toàn ✓" (`DisasterMap.tsx:577,766-775`). A dependency
   failure is therefore displayed as public safety. **Issue #10.**

### P1

3. **Spatial endpoints are not spatial** (`server.ts:373-374`), and `nearby()`
   is dead code (`api/hazards.ts:61-68`). **Issue #12.**
4. **VNDMS schema mismatch**: `/v1/hazards/vndms-live` returns SOS `Hazard`
   rows with `geometry`; the VNDMS layer reads `h.lat`/`h.lon`/`warning_type`
   and renders no markers or calls `flyTo([undefined, undefined])`.
   **Issue #13.**
5. **`hours` is ignored** by `/v1/hazards/recent` (`server.ts:372`) and the
   endpoint returns inactive/expired hazards, contradicting "recent 24h".
   Same root cause as #11/#12 (no Tier-2 query).
6. **Public projection includes terminal events.** `/v1/emergency/public`
   (`server.ts:301-306`) has no status filter, and `DisasterMap.tsx:169`
   hardcodes "• Đang triển khai" on every card. Resolved/canceled events appear
   as ongoing operations. **Issue #19.**
7. **Hazard deploy is not idempotent** despite the API contract
   (`server.ts:394-411`; `api/hazards.ts:74-78`): two calls create two events
   and two EOPs and overwrite the hazard link. **Issue #20.**
8. **Approval without an assignee.** `normalizeDispatchAssignment` returns the
   patch before adding an assignment when no id is supplied
   (`dispatch.ts:56-70`), so `POST /dispatch/:id/approve {}` yields
   `status:"assigned"` with no `assigned_resource_unit_id`/`assignments`.
   **Issue #20.**
9. **Read-modify-write updates** (`server.ts:245-258`) ignore the Tier-2
   record version, so concurrent approvals/SITREP deltas lose writes.
   **Issue #20.**
10. **Validation errors can be persisted.** `write()` retries any Tier-2
    `400`/`409` as an update (`server.ts:249-252`), converting a rejected
    payload into an accepted update. **Issue #20.**
11. **Gateway console proxy corrupts binaries** and does not handle HEAD:
    `res.send(await response.text())` at `index.ts:233`. Probe: PNG bytes
    `[137,80,78,71,...,255,0,128]` came back as
    `[239,191,189,80,78,71,...,239,191,189]` with
    `content-type: image/png; charset=utf-8`. **Issue #20.**
12. **No upstream timeouts** in gateway proxy/health (`index.ts:144-158,193-205`),
    so a hung service blocks clients instead of returning 504. **Issue #20.**
13. **SSE reconnect is disabled.** `EmergencyCenter.tsx:258-265` closes the
    `EventSource` on the first error and starts 30 s polling, so a transient
    blip permanently degrades to polling until remount. **Issue #10.**
14. **ProtectedRoute refreshes on every mount** (`ProtectedRoute.tsx:44-53`),
    rotating tokens on each navigation; a failed refresh is swallowed and the
    stale access token remains until the next 401. Low-end bug, folds into #17.
15. **Auth 401 redirects to `/`** (`httpClient.ts:57-63`), not `/login`; an
    expired session on an admin page lands on the public landing page.
16. **`filterRows` uses exact string equality for every query key**
    (`server.ts:259-261`), so any supported-looking filter without a matching
    column returns zero rows (e.g. `q` is exposed in `EmergencyListParams` but
    has no implementation). Latent contract trap; root cause of #11.

## 6. Self-hosted lower-tier concerns

### 6.1 Identity — HMAC demo shell instead of Tier-1 IAM via Tier-2

`auth.ts` issues stateless HS256 sessions for any non-empty username/password
(`auth.ts:257-271`), takes `role` from the request body (`auth.ts:269,289-296`),
and has no revocation. Probe: anonymous `POST /v1/auth/register` with
`"role":"admin"` returns `role:"admin"` and `emergency:admin`. There is no
identity capability in Tier 2 to delegate to. **Issue #17.**
**Lower-tier issue required** in `SynapseDX` (identity/session capability) and
`SynapseOne` (IAM SDK: login, MFA, introspection, revocation, scopes).

### 6.2 AI — static chat and template EOP instead of Tier-1 inference via Tier-2

`/v1/ai/chat` echoes a canned message (`server.ts:469`); `generate-draft`
writes a fixed empty plan (`server.ts:325`). `GET /v1/capabilities` advertises
only `datasets, records, publication, events`; the SDK has no AI namespace.
**Issue #14.** **Lower-tier issue required** in `SynapseDX` (AI capability:
completion/chat, prompt templates, model routing, quota, audit) and
`SynapseOne` (inference/model-gateway SDK).

### 6.3 Streaming — SSE polls records every 30 s instead of Tier-1 queue via Tier-2

`server.ts:414-428` re-lists the hazard dataset every 30 s and rewrites the
whole snapshot; there are no deltas, no resume, no queue. SynapseDX emits
`record.created`/`dataset.updated` to `EVENTS_QUEUE` but exposes no subscribe
endpoint and the SDK exposes no event consumer. **Issue #19.**
**Lower-tier issue required** in `SynapseDX` (queue-backed event subscription
with cursor/replay + SDK) and `SynapseOne` (queue subscribe/ack SDK).

### 6.4 Public projection — records API instead of the publication/entity API

`AGENTS.md:22-25` requires public projections through the Tier-2
publication/entity API. `/v1/emergency/public`, `/v1/hazards/recent` and
`/v1/hazards/vndms-live` all call `records.list` (`server.ts:301-306,372-376`);
`datasets.entities` is never used. NGSI-LD is not claimed, so this is a
Tier-2-surface violation, not a false claim. **Issue #19.**
**Lower-tier issue required** in `SynapseDX` (public projection contract +
status filtering; document `entities` vs `records`).

### 6.5 SDK dependency — `file:` instead of a published package

`apps/sos-service/package.json:15` and `package-lock.json:107` point at
`file:../../../SynapseDX/sdks/capabilities-js`; `prebuild` installs/builds a
sibling checkout. `README.md:64-68` acknowledges the release step is pending.
**Issue #19.** **Lower-tier issue required** in `SynapseDX`: publish
`@synapsedx/capabilities` to npm with a version and integrity metadata.

### 6.6 Geospatial and aggregation — in memory instead of Tier-1 search/query

`server.ts:236-240` pages records then filters; `near`/`in-polygon` ignore
geometry; AAR KPIs would require scanning records. `records.list` has no
`filter`, `sort`, aggregation or spatial parameters. **Issues #12, #16.**
**Lower-tier issue required** in `SynapseDX` (server-side field predicates,
aggregates, spatial query) and in `SynapseOne` if LDS/SynapseBase cannot express
geo/aggregate predicates in the SDK.

### 6.7 Scheduling/ingestion — no Tier-2 scheduler for VNDMS

There is no ingestion job, run history or dead-letter anywhere in SOS; adding
an in-process poller would be a forbidden local scheduler. **Issue #13.**
**Lower-tier issue required** in `SynapseDX` (scheduled ingestion/connector
capability backed by Tier-1 workflow/queue) and `SynapseOne` (scheduled
workflow/queue trigger + run-history SDK if missing).

### 6.8 Files/photos — not implemented, and not needed yet

There is no field-evidence upload (damage photos, SITREP attachments). This is
a gap only if the product claims field evidence; it currently does not. When
needed, it must be a Tier-2 files capability, not SOS disk/object storage.
**Lower-tier issue required (future)** in `SynapseDX` for file/object storage
with signed upload/download; **no SOS-local upload** until then.

## 7. Security and data-risk review

| Risk | State | Evidence |
| --- | --- | --- |
| `affected_asset_ids` exposed publicly | **Not present** — projection whitelist excludes it | `server.ts:304` |
| Session token in SSE query string | **Present** — written to nginx/gateway access logs and browser history | `EmergencyCenter.tsx:62-88`; `auth.ts:223-234` |
| Tokens in localStorage | **Present** — zustand `persist` + biometric cache | `authStore.ts:19-45`; `useBiometricAuth.ts:161-176,196-247` |
| Auth bypass / privilege escalation | **Present** — any password, client-supplied `admin` role | `auth.ts:257-271,289-296` |
| Rate limiting | **Absent** on auth, SSE, geo, AI | no `limit_req` in `infra/nginx/synapsecity-sos.conf`; no middleware |
| Password/MFA/account lifecycle | **Absent** by design (demo shell); must move to IAM | `auth.ts:3-19,311-331` |
| Biometric verification | **Client-side only** — replay of cached tokens after a local assertion | `useBiometricAuth.ts:216-247` |
| Upstream error detail leakage | **Present** — error handler returns `upstream: error.body` to clients | `server.ts:480-483` |
| CORS | Fixed single origin (good); no credentials mode | `server.ts:265-273`; gateway `135-142` |
| Security headers | Only `x-content-type-options`; no HSTS/CSP at console/edge | `server.ts:269`; `apps/console/nginx.conf` |
| In-memory pagination/filter | **Present** — wrong results, full-table reads | `server.ts:236-261` |

Note: the token-in-query pattern is explicitly contemplated by
`SynapseCitySOS/AGENTS.md:56-64`, so fixing it also requires a documentation
change; the recommendation is a one-time stream ticket or fetch-based SSE.

## 8. Observability and test gaps

- No metrics, tracing, request logs or alerting in either service; `x-correlation-id`
  is generated (`server.ts:270`, `gateway/index.ts:140`) but never logged.
- `/health` and `/ready` proxy Tier-2 health, but there is no per-dataset,
  queue-lag or last-success signal, and no console indicator. A data outage is
  indistinguishable from "no data" (P0 #10).
- No test covers: hazard filters, geo, public projection contents,
  EOP generate/submit, dispatch optimize, AAR KPI, SITREP validation,
  role escalation, Tier-2 5xx behaviour, gateway timeouts, or binary console
  proxying. E2E specs skip authenticated flows.
- No load test for the public map/SSE (every client triggers a full dataset
  list every 30 s).

## 9. Reproduction appendix

### 9.1 Hazard filter (P0)

Against the built service with a fake Tier-2:

```text
POST /v1/hazards {is_active:true}  -> 201
POST /v1/hazards {is_active:false} -> 201
GET  /v1/hazards?active_only=true  -> 200 []
GET  /v1/hazards                   -> 200 [active, inactive]
GET  /v1/hazards/recent?hours=1    -> 200 [active, inactive]   # hours ignored
```

### 9.2 Spatial endpoints (P1)

```text
GET  /v1/hazards/geo/near?lat=10&lng=100&radius_m=1 -> 200 [both hazards]
POST /v1/hazards/geo/in-polygon {"polygon":[]}      -> 200 [both hazards]
```

### 9.3 EOP / dispatch / AAR (P1)

```text
POST /v1/emergency/eop/generate-draft {"emergency_event_id":"e-1"}
 -> 201 version:1 objectives:[] actions:[] markdown_body absent
POST ... again {"force_new_version":true} -> 201 version:1 (new id)

POST /v1/emergency/eop/<id>/submit -> 200 {"orders":[]}
POST /v1/emergency/dispatch/optimize -> 200 all zeros

POST /v1/emergency/e-1/resolve -> 200 status:"resolved"
GET  /v1/emergency/after-action -> []
POST /v1/emergency/after-action/generate -> 201 timeline:[] kpi all 0
```

### 9.4 Auth escalation (P1)

```text
POST /v1/auth/register {"username":"x","email":"x@y.z","password":"p",
                        "full_name":"X","role":"admin"}
 -> 201 role:"admin", permissions include "emergency:admin"
```

### 9.5 Gateway binary proxy (P2)

```text
GET /icons/icon-192x192.png through createApp({consoleUpstream})
content-type: image/png; charset=utf-8
expected [137,80,78,71,13,10,26,10,255,0,128]
received [239,191,189,80,78,71,13,10,26,10,239,191,189,0,239,191,189]
```

The probe script is not committed to the repository (audit-only), but each
issue contains a curl sequence or the exact fake-Tier-2 setup.

## 10. Issue list

Tracking: [#9 [audit] SOS feature, bug and lower-tier dependency audit — 2026-11-04](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/9)

| # | Severity | Label | Title |
| --- | --- | --- | --- |
| 10 | P0 | bug | [Dependency outages are presented as an all-clear; SSE masks Tier-2 errors with an empty snapshot](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/10) |
| 11 | P0 | bug | [Hazard lists always return [] — active_only is compared against a non-existent field instead of is_active](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/11) |
| 12 | P1 | bug | [/v1/hazards/geo/near and /in-polygon ignore geometry and return every hazard](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/12) |
| 13 | P1 | bug, enhancement | [VNDMS "live" feed is an unfiltered dataset read with an unusable schema; ingest status is hardcoded](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/13) |
| 14 | P1 | bug, enhancement | [EOP "AI draft" is an empty template, ignores force_new_version, and creates duplicate v1 plans](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/14) |
| 15 | P1 | bug, enhancement | [EOP submit never creates dispatch orders and dispatch optimize is a successful zero-result stub](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/15) |
| 16 | P1 | bug | [AAR KPI/timeline are always zero, resolve never creates an AAR, and SITREP/AAR have no validation](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/16) |
| 17 | P1 | bug | [Auth shell allows self-assigned admin and exposes session tokens via SSE URL, localStorage and biometric replay](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/17) |
| 18 | P1 | enhancement | [Phase boards, SITREP/AAR screens and the public "nearby shelter" action are placeholders](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/18) |
| 19 | P2 | bug, documentation | [Tier-2 integration: unpublished file: SDK, public projection via private records API, SSE polls lists instead of consuming events](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/19) |
| 20 | P2 | bug | [Non-idempotent deploy, unassigned approvals, lost updates, no metrics/timeouts, binary-unsafe console proxy](https://github.com/vku-open-source-2026/SynapseCitySOS/issues/20) |

No duplicate of the closed separation issues #1–#8 was filed: those covered
build, auth 404, SSE framing, deploy shape, dispatch field naming, HTML shape
guards, encoded paths and the separation acceptance audit. They are all closed
and the current code has regressed or never implemented the behaviour described
here.

## 11. Lower-tier dependency backlog

No relevant open issue exists in `SynapseDX` or `SynapseOne` (checked open and
closed lists, 2026-11-04: SynapseDX has none; SynapseOne has only the open About
page issue #3; SynapseCitySOS issues #1–#8 are closed). The following must be
created and released before the corresponding SOS gaps can be fixed without
self-hosting. Each is marked "lower-tier issue required" in the issue body.

| Repo | Required capability | Unblocks |
| --- | --- | --- |
| `SynapseDX` | Publish `@synapsedx/capabilities@<semver>` to npm; remove `file:`/sibling prebuild | #19 |
| `SynapseDX` | Identity/session capability (login, refresh, introspection, revoke, roles, tenant binding, WebAuthn) + SDK | #17 |
| `SynapseOne` | IAM SDK: password/OIDC/MFA verification, revocation, service-account scopes, introspection | #17 |
| `SynapseDX` | AI capability (chat/completion, prompt templates, model routing, quota, audit) + SDK | #14 |
| `SynapseOne` | Inference/model-gateway SDK (catalog, completion/streaming, token accounting, quota) | #14 |
| `SynapseDX` | Queue-backed event subscription (SSE/WebSocket or cursor), replay/resume, dataset filter + SDK | #10, #19 |
| `SynapseOne` | Queue subscribe/ack/cursor SDK if absent | #19 |
| `SynapseDX` | Public projection contract (`entities` vs records) + status filters; document publication | #19 |
| `SynapseDX` | Record query: field predicates, sort, stable paging (server-side) | #11, #16 |
| `SynapseDX` | Spatial query (radius/bbox/polygon) over records/LDS + SDK | #12, #18 |
| `SynapseOne` | LDS/SynapseBase geo + aggregate query support in SDK | #12, #16 |
| `SynapseDX` | Aggregate query (count/sum/min/max/group/date range) + SDK | #16 |
| `SynapseDX` | Scheduled ingestion/connectors with run history/retry/DLQ + SDK | #13 |
| `SynapseOne` | Scheduled workflow/queue trigger + run-history SDK if missing | #13 |
| `SynapseDX` | Routing/ETA capability + SDK (real optimizer ETA) | #15 |
| `SynapseOne` | Provider gateway/cache for routing if needed | #15 |
| `SynapseDX` | Record version/ETag + conditional update (409 on conflict) in SDK | #20 |
| `SynapseDX` | Health detail: dataset/queue readiness, lag, last success | #10 |
| `SynapseDX` | Files/object storage with signed upload/download (only when field evidence is in scope) | future |

Suggested lower-tier release order: SDK publish → query/aggregation/spatial →
event subscription → health detail → identity → AI → scheduling/ingestion →
routing/ETA → files. SOS must not ship local substitutes in the meantime; it
should return `501 not_implemented` or an explicit "capability unavailable"
state instead of zeros, empty templates or fake `ready` statuses.

## 12. Priority and release recommendation

Do **not** present the current build as a working emergency-operations release.

1. **Block release on #10 and #11.** They are small, independent Tier-3 fixes
   and they currently make the public map either empty or falsely reassuring.
2. **Then fix the operational loop (#15, #16, #14).** Without dispatch task
   generation and real AAR/KPI, the command centre cannot run an incident
   end-to-end; EOP drafts should be labelled template/fallback until AI exists.
3. **Then #17.** The demo shell is acceptable only as an explicitly gated,
   non-production, non-admin mode; token exposure and role self-assignment are
   not acceptable on the public emergency host.
4. **#18** can proceed in parallel (UI slices) but must not add new fake screens;
   each board/screen should show "metric unavailable" until its data endpoint
   is real.
5. **#19 and #20** are the sustainability work: publish the SDK, use the
   publication/event APIs, add timeouts/metrics/tests and conditional writes.
   They should land with the P1 pipeline work rather than after it.

The repository's boundary discipline (no City features, no Tier-1 calls,
`sos-*` datasets, 404 guards, owned route tree) is sound. The risk is that the
product currently substitutes local stubs for the Tier-1/Tier-2 capabilities it
is supposed to consume, and the green build/test suite gives that substitution
a false sense of completeness.
