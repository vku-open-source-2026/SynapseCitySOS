# SynapseCitySOS — emergency operations (Tier 3)

## OLP 2026 demo

A reproducible 15-minute emergency-operations story lives in [`docs/DEMO_PACK.md`](docs/DEMO_PACK.md). Seed/reset with `npm run demo:seed` and `npm run demo:reset` (requires `SOS_DEMO_TOKEN`).


![CI](https://github.com/vku-open-source-2026/SynapseCitySOS/actions/workflows/ci.yml/badge.svg)
![Release](https://github.com/vku-open-source-2026/SynapseCitySOS/actions/workflows/release.yml/badge.svg)

SynapseCitySOS is the emergency operations product of the Synapse platform. It
owns emergency preparedness, response and recovery: hazard feeds including
VNDMS ingestion, emergency events, emergency operations plans (EOP), dispatch
and responder assignment, emergency resource units, SITREP, AAR, the live
hazard SSE stream, the emergency command centre and the public
hazard/emergency map.

The public product boundary is `https://sos.synapsecity.sbs`. The API is served
at `https://sos.synapsecity.sbs/v1`.

SynapseCitySOS is a **sibling** of SynapseCity (`https://synapsecity.sbs`), the
city infrastructure product. SynapseCitySOS does **not** own city assets, city
incidents, IoT, maintenance or the technician portal, infrastructure alerts,
budgets, operational reports, city users, geofences, data ingestion, the public
asset map or public incident reporting. A link to City is a public HTTPS
navigation link only; there is no SOS-to-City API call.

Emergency resource units are rescue logistics (teams, vehicles, medical
supplies, rescue equipment, shelters), not infrastructure assets. SOS has no
asset registry, asset lifecycle, GIS asset map, maintenance work order, IoT
sensor management or infrastructure budget. SOS responders are represented as
SOS resource units in `sos-resource-units`, never as City user records. This
repository does not expose `/v1/users` and never reads or writes `city-users`.

The authoritative matrix is the workspace `FEATURE_BOUNDARY.md` at the workspace
root. The repo-local summary is [`PRODUCT_BOUNDARY.md`](PRODUCT_BOUNDARY.md).

## Architecture

```text
apps/gateway        public HTTPS API boundary and console proxy (port 8080)
apps/sos-service    emergency operations domain backend (port 8084)
apps/console        emergency operations console
infra/              public-edge snippets and deployment material
```

Dependency direction:

```text
SynapseCitySOS -> @synapsedx/capabilities -> @synapseone/sdk -> SynapseOne
```

The service is configured with `https://synapsedx.sbs` and calls the Tier-2
capabilities API. It has no database, queue connection or direct SynapseOne
client. Domain records are created through the Tier-2 records API; public
projections are read through Tier-2 SynapseLDS publication. `/v1/geo`,
`/v1/map` and `/v1/ai` are SOS-owned instances and do not proxy City.

## Features

- flood, storm, landslide and other hazard feeds, including VNDMS ingestion;
- emergency events and public emergency projection;
- emergency operations plans (EOP);
- dispatch orders and responder assignment;
- emergency resource units (personnel, vehicles, medical supplies, equipment,
  shelters);
- SITREP and deltas;
- AAR;
- live hazard SSE stream;
- emergency command centre, phase boards and rescue operation view;
- public hazard/emergency map;
- map tiles, geocoding, reverse geocoding and AI capability instance for SOS.

Not owned by this repository: city assets, city incidents, IoT, maintenance or
the technician portal, infrastructure alerts, budgets, operational reports,
city users, geofences, data ingestion, the public asset map and public incident
reporting. Those are SynapseCity features.

## Run

Build the Tier-2 SDK first; the workspace-local dependency is intentional until
the workspace `@synapsedx/capabilities` package is published to the npm registry:

```bash
cd ../SynapseDX/sdks/capabilities-js && npm install && npm run build
cd ../../SynapseCitySOS && npm ci && npm run build
SYNAPSEDX_BASE_URL=https://synapsedx.sbs AUTH_SECRET=<strong-secret> \
  npm run start --workspace=@synapsecity/sos-service
```

`AUTH_SECRET` is optional for local development. If it is empty the service
generates an ephemeral HMAC secret at start-up and logs a warning; set a strong
value in production so sessions survive a restart.

Identity is verified by the Tier-2 auth capability by default
(`SOS_AUTH_MODE=tier2`, Tier-1 IAM backed). Operators log in with the email and
password of their Tier-2 account; the Tier-2 access/refresh token is kept inside
the signed SOS session and is never returned to the browser. A verified identity
is a `responder`, unless its email is listed in `SOS_BOOTSTRAP_ADMIN_EMAILS`
(comma-separated, lower-cased), which grants `admin`. A client-supplied `role`
is always ignored.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SOS_AUTH_MODE` | `tier2` | `tier2` = Tier-2 auth capability; `demo` = development-only shell |
| `SOS_BOOTSTRAP_ADMIN_EMAILS` | empty | Comma-separated emails that receive `admin` after a verified login/registration |
| `SOS_AUTH_DEFAULT_ROLE` | `responder` | Fallback role; never `admin` |
| `SOS_AUTH_EXCHANGE` | `false` | Opt-in delegated token exchange with the `synapsecity-sos` audience |
| `ALLOW_DEMO_AUTH` | `false` | Enables the demo shell only with `SOS_AUTH_MODE=demo` and `NODE_ENV != production` |
| `AUTH_SECRET` | empty | HMAC secret for the SOS session; an ephemeral secret is used when empty |

The demo login/register shell is **disabled by default** and needs
`SOS_AUTH_MODE=demo` **and** `ALLOW_DEMO_AUTH=true` outside production;
`NODE_ENV=production` refuses to start with either demo switch enabled. Demo
login is always a `responder` session, registration is read-only (`volunteer`),
and demo sessions never grant `admin`. In `tier2` mode a login with a
non-email identifier is rejected with `400 email_required`.

Console development:

```bash
npm run dev --workspace=@synapsecity/sos-console
```

The production stack is reproducible with `docker compose up -d --build`. The
release step still requires publishing the workspace `@synapsedx/capabilities`
package and replacing the `file:` dependency with the published semver range;
the build is reproducible today because `prebuild` builds the local SDK from the
`../SynapseDX` checkout.

## API

The gateway owns these namespaces:

```text
GET  /health, /ready
GET  /v1/sos
*    /v1/auth
*    /v1/emergency
*    /v1/emergency/eop
*    /v1/emergency/dispatch
*    /v1/emergency/resources
*    /v1/emergency/sitrep
*    /v1/emergency/after-action
*    /v1/emergency/stream/hazards
*    /v1/hazards
*    /v1/geo
*    /v1/map
*    /v1/ai
```

`/v1/auth/*` is a stateless HMAC-SHA256 session shell for the console:
login/register/refresh/logout/change-password/me/verify. Credentials are
verified by the Tier-2 auth capability (`auth.login`, `auth.register`,
`auth.refresh`, `auth.logout`, `auth.me`, `auth.changePassword`, optional
`auth.exchange`); SOS stores no password and creates no SOS user dataset or City
user record. The Tier-1/Tier-2 token stays inside the signed SOS session and is
forwarded only to Tier-2 — it is never returned as a response field. Tokens are
accepted only from the `Authorization` header, never a query string. Demo mode
is an explicit development shell (see Run).

Roles are always server-assigned: `SOS_BOOTSTRAP_ADMIN_EMAILS` grants `admin`,
everything else gets `SOS_AUTH_DEFAULT_ROLE` (`responder`). Registration through
Tier-2 creates a responder account (or `admin` for a bootstrap email). Password
changes are delegated to Tier-2 when the session carries a Tier-2 token and
return `503 identity_not_configured` otherwise.

Internal emergency routes require `Authorization: Bearer <access_token>` and an
explicit permission: reads need `emergency:read`, event/SITREP writes need
`emergency:write`, dispatch/resource/hazard mutations need
`emergency:dispatch`, and EOP approval/publication needs `emergency:eop`.
A valid but low-privilege session receives `403` with a stable `error` code.
The role→permission matrix is:

| Role | Permissions |
| --- | --- |
| citizen, volunteer | `emergency:read` |
| responder | `emergency:read`, `emergency:write` |
| operator | `emergency:read`, `emergency:write`, `emergency:dispatch` |
| manager | operator permissions + `emergency:eop` |
| admin | manager permissions + `emergency:admin` (wildcard) |

In `tier2` mode a normal account is a `responder`; only
`SOS_BOOTSTRAP_ADMIN_EMAILS` grants `admin`. `manager`/`operator` are reachable
only through an explicit `SOS_AUTH_DEFAULT_ROLE` configuration or the bootstrap
allow-list — never through the login/register payload.

Hazard reads (`/v1/hazards`, `/v1/hazards/recent`, `/v1/hazards/vndms-live`,
`/v1/hazards/geo/*`, `/v1/hazards/ingest/status`), the public projection
(`/v1/emergency/public`, `/v1/emergency/public/status`,
`/v1/emergency/stream/hazards`), nearby shelters
(`/v1/emergency/resources/shelters/near`) and `/v1/map/*`, `/v1/geo/*`,
`/v1/ai/*`, `/v1/sos` remain open. Dispatch approval uses
`assigned_resource_unit_id`, mirrored to the legacy `assigned_user_id` field for
older clients.

`GET /v1/sos` advertises the owned feature list and the not-owned city feature
list. Foreign namespaces under `/v1/assets`, `/v1/incidents`, `/v1/maintenance`,
`/v1/iot`, `/v1/alerts`, `/v1/budgets`, `/v1/reports`, `/v1/geofences`,
`/v1/ingest`, `/v1/notifications`, `/v1/public/assets` and
`/v1/public/incidents` return `404` with `{ "error": "not_found" }` before any
handler or Tier-2 call.

Map tiles, autocomplete, forward geocoding and reverse geocoding are proxied
through the SOS backend. Set `VIETMAP_API_KEY` and optionally
`VIETMAP_TILE_STYLE=tm|lm|dm|hm|st` in the server `.env`; the key is never sent
to the browser.

## Operational logic

- **Hazard filters** interpret `active_only`/`is_active` as booleans against
  `is_active` (not a generic string match). `hours` on `/v1/hazards/recent`
  filters by the most recent hazard timestamp and excludes expired records.
- **Spatial queries** validate `lat`/`lng`/`radius_m` and GeoJSON
  Polygon/MultiPolygon input, then evaluate haversine distance or
  point-in-polygon. Invalid geometry is `400`; a far-away origin returns `[]`.
- **VNDMS** ingestion is push-based: a Tier-2 scheduled connector posts batches
  to `POST /v1/hazards/ingest`; SOS normalises, validates and upserts by stable
  `hazard_id`, then records the run in `sos-hazard-ingest-runs`.
  `GET /v1/hazards/ingest/status` combines that push history with the Tier-2
  scheduled job (`GET /v1/capabilities/jobs` and
  `/v1/capabilities/jobs/:id/runs`) and reports
  `unconfigured | ready | degraded | stale | error` plus a `connector` block
  (job id, schedule, last run, last success, rejected count). An unavailable
  jobs API is reported as `connector.available: false` with a precise error,
  never as `ready`. SOS never runs a local cron/poller.
- **EOP drafts** are generated by the Tier-2 AI capability
  (`POST /v1/capabilities/ai/chat`) from the event, its linked hazards, the
  resource inventory and the operator's additional context. `metadata` records
  `generated_by: "tier2-ai"`, `model`, `prompt_version`, `usage`, `generated_at`
  and `source_refs`. If the AI capability is unavailable the endpoint returns a
  typed `503 ai_capability_unavailable` and persists nothing; passing
  `{"fallback":"deterministic"}` explicitly opts into the event-specific
  doctrine draft, labelled `generated_by: "deterministic-fallback"` with the
  `ai_error`. `force_new_version=false` is idempotent per event; `true`
  increments the version, and version selection is serialised per event so two
  concurrent requests can never create two v1 plans. `POST /eop/:id/submit`
  creates one pending dispatch order per plan action with deterministic ids, so
  re-submit returns the same orders.
- **Dispatch optimizer** only auto-assigns `available` units with a compatible
  `resource_type`, never `offline`/`maintenance`, computes a straight-line ETA,
  and persists the assignment. Its counts equal the records it changed.
- **AAR KPI** is computed from event, dispatch, SITREP and resource records:
  `response_time_minutes` (first assignment − event start), severity SLA band,
  `dispatch_completion_rate`, `sitrep_coverage_rate` (published / expected
  6-hour windows), `resource_efficiency_score`, and
  `overall_score = 0.3·response + 0.3·dispatch + 0.2·sitrep + 0.2·resource`.
  `POST /v1/emergency/:id/resolve` creates exactly one draft AAR (idempotent).
- **SITREP** requires a real event, title, reporting period, author/source and
  non-negative integer counters. Published SITREPs are immutable; a delta
  creates a new revision with `amends_sitrep_id`.
- **Concurrency** uses the Tier-2 record version: single-record reads return
  `ETag: "<version>"` and `x-record-version`, and updates send `If-Match`
  (body `if_version` is also accepted) so a stale writer receives
  `409 record_version_conflict` instead of silently losing an update. Deploy,
  approval and submit are idempotent, and only a `409` create conflict is
  retried as an update — a `400` validation failure is never persisted.
- **SSE** consumes the Tier-2 event feed (`GET /v1/capabilities/events`,
  filtered to `sos-hazard-layers`) and resumes from the client's
  `Last-Event-ID` cursor. A hazard `record.*` event refreshes the public
  snapshot within the 2-second poll window; only when the feed itself is
  unavailable does it degrade to a 30-second snapshot poll (counted in
  `/metrics`). It never converts a Tier-2 failure into an empty snapshot: it
  emits a named `error` event, keeps the last good snapshot, heartbeats every
  15 s. The public map shows a degraded banner and never claims an area is safe
  while data is unavailable.
- **Health** (`/health`, `/ready`, `/v1/emergency/health`) reports Tier-2
  reachability and per-dataset state; `/ready` returns `503` when Tier-2 is
  unreachable or a dataset is missing. `/v1/ai/status` and
  `/v1/emergency/sosconn/status` report the real Tier-2 AI provider/model
  readiness.
- **Metrics** at `/metrics` expose request rate/errors/latency, Tier-2 call
  results and latency, record-version conflicts, EOP draft source and hazard
  stream transport; request logs are structured JSON with the correlation id.

## Known lower-tier dependencies

Tier 2 now provides everything this product needs at runtime: the AI capability
(`/v1/capabilities/ai/*`), the event feed (`/v1/capabilities/events`), record
versions with `If-Match` (`/v1/capabilities/datasets/:id/records/:recordId`),
and scheduled jobs with run history (`/v1/capabilities/jobs`). SOS uses them
directly and returns explicit degraded/unavailable states when a call fails.

Remaining blockers are release/operator steps, not SOS work:

1. **SDK publication.** The workspace `@synapsedx/capabilities` package
   (currently 0.3.0 locally) is not in the npm registry yet
   (`npm view @synapsedx/capabilities` → 404), so `apps/sos-service/package.json`
   keeps the workspace `file:` dependency and the `prebuild` step builds
   `../SynapseDX/sdks/capabilities-js`. Publishing the package and replacing
   `file:` with the published semver range is a SynapseDX/operator release step
   (issue #19 tracks only this step).
2. **Spatial query.** Tier 2 has no spatial predicate yet, so SOS pages records
   and filters geo predicates in memory with a bounded scan
   (`x-sos-scan-truncated` is returned when the bound is hit).
3. **VNDMS connector provisioning.** The Tier-2 scheduled job that posts to
   `POST /v1/hazards/ingest` is configured by the operator/Tier-2, and SOS needs
   a Tier-2 service credential (`SYNAPSEDX_API_KEY`/`SYNAPSEDX_TOKEN`) to read
   the job/run status and the event feed. Until it exists, ingest status is
   `unconfigured` (never a fake `ready`).

## Console

The SOS console serves these owned routes:

```text
/                              SOS landing
/about /docs                   product and API docs
/map                           public hazard/emergency map
/login /register               auth shell
/admin                         emergency operations dashboard
/admin/emergency-center        command centre
/admin/emergency-center/before during after
/admin/emergency-center/operations/$eventId
/admin/settings                self-service profile
```

There is no `/admin/assets`, `/admin/incidents`, `/admin/iot`, `/admin/budgets`,
`/admin/reports`, `/admin/alerts`, `/admin/ingest`, `/admin/users` or
`/technician` route. There is no `/asset/$id`, `/public/report` or
`/public/incidents` route. `/disaster` is removed; the public hazard map is
`/map`.

## Public edge

The public edge routes `sos.synapsecity.sbs` to the gateway. The gateway proxies
`/v1` to `sos-service` and serves the console for browser routes. SSE responses
from `/v1/emergency/stream/hazards` are streamed without buffering. See
`infra/nginx/`.

## Issue tracker and changes

Use the public GitHub Issues tab for bugs and feature requests. See
[`CHANGELOG.md`](CHANGELOG.md) for version history. The repository is
Apache-2.0 licensed.

## DX-OS 2026

SOS is a Tier-3 domain application in the OLP 2026 DX-OS model: it owns
emergency events, hazards, dispatch, resources, EOP and AAR rules, and consumes
reusable H-P-D-I capabilities from SynapseDX over the public API. It never
imports the Tier-1 SDK, calls a Tier-1 service, or calls SynapseCity. The tier
matrix, HITL contract and OLP evidence checklist are in
[`SynapseDX/docs/DX_OS_TIER_MODEL_2026-11-04.md`](https://github.com/vku-open-source-2026/SynapseDX/blob/main/docs/DX_OS_TIER_MODEL_2026-11-04.md).

## PoF project checklist

- License: Apache-2.0 (`LICENSE`) with per-source SPDX headers and attribution in `NOTICE`.
- Build from source: `npm ci && npm run build` using Node.js 20+; Docker builds are reproducible with `docker compose build`.
- Issue tracker: [GitHub Issues](https://github.com/vku-open-source-2026/SynapseCitySOS/issues).
- Change history: [`CHANGELOG.md`](CHANGELOG.md). Versioned release tags are published on GitHub.
- Dependency inventory: [`THIRD-PARTY.md`](THIRD-PARTY.md); dependencies are not modified or bundled into the repository.
