# SynapseCitySOS — Tier 3 emergency operations product

SynapseCitySOS owns emergency operations. Read
[`PRODUCT_BOUNDARY.md`](PRODUCT_BOUNDARY.md) before changing code, routes, APIs
or datasets. When working in the workspace, the workspace-level
`FEATURE_BOUNDARY.md` is authoritative.

The repository is split into product parts:

- `apps/gateway`: public HTTPS API boundary and console proxy;
- `apps/sos-service`: Tier-3 emergency operations backend;
- `apps/console`: emergency operations console;
- `infra`: edge/deployment files.

## Dependency contract

- Import the Tier-2 `@synapsedx/capabilities` client from
  `../SynapseDX/sdks/capabilities-js` during this workspace build; releases must
  resolve the same package from the npm registry (the package is not published
  yet, so the `file:` dependency and the `prebuild` SDK build stay until the
  operator publishes it).
- Default Tier-2 URL is `https://synapsedx.sbs`. Set `SYNAPSEDX_BASE_URL` only
  to another public HTTPS endpoint. Do not call SynapseOne, a private service
  port, localhost or a database from this repository.
- Use Tier-2 capabilities instead of local implementations: `ai/chat` for EOP
  drafts (a typed `503` when unavailable, an explicit opt-in deterministic
  fallback only), `events` for the hazard stream, `jobs`/`jobs/:id/runs` for the
  VNDMS connector status, and record versions/`If-Match` for conditional
  updates. Never add a local scheduler, poller, model client or event store.
- Persist SOS records through the Tier-2 records API. Read public projections
  through the Tier-2 publication/entity API. Queueing and persistence remain
  owned by Tiers 1 and 2.
- Do not call, import or proxy SynapseCity. A link to
  `https://synapsecity.sbs` is public navigation only.
- Do not add cross-product imports or API calls anywhere in the workspace.

## Feature ownership

Owned: hazard feeds including flood, storm, landslide and VNDMS ingestion;
emergency events and public emergency projection; EOP; dispatch and responder
assignment; emergency resource units; SITREP and deltas; AAR; live hazard SSE;
emergency command centre, phase boards and rescue operations; public
hazard/emergency map; map/geocode/AI for this product.

Emergency resource units are rescue logistics (teams, vehicles, medical
supplies, rescue equipment, shelters), not infrastructure assets. SOS must not
grow an asset registry, asset lifecycle, GIS asset map, maintenance work order,
IoT sensor management or infrastructure budget. A City asset may appear only as
an opaque `affected_asset_ids` reference on an emergency event.

Not owned: city assets, city incidents, IoT, maintenance, technician portal,
infrastructure alerts, budgets, operational reports, city users, geofences,
data ingest, public asset map and public incident reporting. Never add these
modules, routes, types or datasets here.

## Responders are resource units

SOS responders are `sos-resource-units` under `/v1/emergency/resources`. They
are not City users. Do not add `/v1/users`, read `city-users`, or resolve City
operator IDs. Dispatch assignment references an SOS resource unit under
`assigned_resource_unit_id`; `assigned_user_id` is a deprecated mirror.

`/v1/auth/*` is a stateless HMAC session shell for the console. It stores no
passwords and creates no user dataset. Identity is verified through the Tier-2
auth capability (`SOS_AUTH_MODE=tier2`, the default in every environment): the
`auth` namespace (login/register/refresh/logout/me/changePassword/optional
exchange) proxies Tier-1 IAM. The Tier-2 access/refresh token is kept inside the
signed SOS session and forwarded only to Tier-2; it is never returned to the
browser as a field. `AUTH_SECRET` is optional and falls back to an ephemeral
start-up secret with a warning. Tokens are accepted only from
`Authorization: Bearer`, never a query string.

Roles are always server-assigned and never read from the request body, the
token or `SOS_AUTH_DEFAULT_ROLE=admin`. A verified identity is a `responder`
unless its email is in `SOS_BOOTSTRAP_ADMIN_EMAILS` (comma-separated), which
grants `admin`; registration through Tier-2 creates a responder account (or
`admin` for a bootstrap email). Password changes call Tier-2 when the session
carries a Tier-2 token.

Demo mode exists only with `SOS_AUTH_MODE=demo` **and** `ALLOW_DEMO_AUTH=true`
outside production; `NODE_ENV=production` refuses to start with either demo
switch enabled. Demo login is `responder`, registration is read-only
`volunteer`, and demo sessions never grant `admin`/`manager`. `SOS_AUTH_MODE=demo`
in production is a start-up error.

Internal emergency routes require a session **and** a permission:
`emergency:read` for reads, `emergency:write` for event/SITREP writes,
`emergency:dispatch` for dispatch/resource/hazard mutations, and
`emergency:eop` for EOP approve/publish. Missing or insufficient permission is
`403` with a stable `error` code. Keep hazard reads and the public projection
list (`/v1/emergency/public`, `/v1/emergency/public/status`,
`/v1/emergency/stream/hazards`, `/v1/emergency/resources/shelters/near`,
`/v1/hazards`, `/v1/hazards/recent`, `/v1/hazards/vndms-live`,
`/v1/hazards/ingest/status`, `/v1/hazards/geo/*`, `/v1/map/*`, `/v1/geo/*`,
`/v1/ai/*`, `/v1/sos`) unauthenticated. `POST /v1/hazards/ingest` is an
authenticated feed sink; scheduling belongs to Tier-2, not SOS.

## API namespace ownership

Owned:

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

The gateway must return `404` with `{ "error": "not_found" }` for every foreign
City namespace before proxying: `/v1/assets*`, `/v1/incidents*`,
`/v1/maintenance*`, `/v1/iot*`, `/v1/alerts*`, `/v1/budgets*`, `/v1/reports*`,
`/v1/geofences*`, `/v1/ingest*`, `/v1/notifications*`, `/v1/public/assets*`,
`/v1/public/incidents*`. There is no `/v1/users` namespace.

## Dataset ownership

Use only `sos-*` datasets:

```text
sos-emergency-events        sos-eop-plans
sos-dispatch-orders         sos-resource-units
sos-sitreps                 sos-hazard-layers
sos-after-action-reports    sos-hazard-ingest-runs
```

Never read or write a `city-*` dataset. Keep the start-up prefix guard and its
test when adding datasets.

## Console route ownership

Keep: `/`, `/about`, `/docs`, `/map`, `/login`, `/register`, `/admin`,
`/admin/emergency-center`, `/admin/emergency-center/before|during|after`,
`/admin/emergency-center/operations/$eventId`, `/admin/settings`.

Never add `/admin/assets*`, `/admin/incidents*`, `/admin/iot*`,
`/admin/budgets*`, `/admin/reports*`, `/admin/alerts*`, `/admin/ingest`,
`/admin/users*`, `/technician*`, `/asset/$id`, `/public/report*`,
`/public/incidents*` or `/disaster`. The public hazard map is `/map`.
`routeTree.gen.ts` must contain only owned routes.

## Commands

```bash
npm ci
npm run build
npm test
npm run start --workspace=@synapsecity/sos-service   # SOS service
npm run dev --workspace=@synapsecity/sos-console     # console dev server
docker compose up -d --build                         # production stack
```

The public map and command centre must never render an outage as "safe" or an
empty snapshot. SSE emits a named `error` event and keeps the last good
snapshot; `/health` and `/ready` report per-dependency state.

Before release, verify:

```bash
grep -rniE "assets|incidents|iot|maintenance|budgets|reports|alerts|geofences|ingest|technician" \
  README.md AGENTS.md PRODUCT_BOUNDARY.md apps/console/README.md
```

Every city-feature match must be an explicit not-owned statement or a public
navigation link. Also check that no source file imports City modules or calls
City APIs.

## Release order

1. SynapseOne and its SDK at `https://api.synapseone.space`.
2. SynapseDX capabilities SDK/API at `https://synapsedx.sbs`.
3. SynapseCitySOS at `https://sos.synapsecity.sbs`, configured with the public
   Tier-2 URL.

SynapseCitySOS does not wait for SynapseCity and must not depend on it.

## Project identity

- Team: VKU.VIC.
- Members: Ho Sy Bao Nhan; Tran Thi Thuy Duong; Vo Thanh Nam.
- Repository license: Apache-2.0. Preserve `LICENSE` and `NOTICE` in all distributions.
