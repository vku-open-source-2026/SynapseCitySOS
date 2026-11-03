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
  resolve the same package from the npm registry.
- Default Tier-2 URL is `https://synapsedx.sbs`. Set `SYNAPSEDX_BASE_URL` only
  to another public HTTPS endpoint. Do not call SynapseOne, a private service
  port, localhost or a database from this repository.
- Persist SOS records through the Tier-2 records API. Read public projections
  through the Tier-2 publication/entity API. Queueing and persistence remain
  owned by Tiers 1 and 2.
- Do not call, import or proxy SynapseCity. A link to
  `https://synapsecity.sbs` is public navigation only.
- Do not add cross-product imports or API calls anywhere in the workspace.

## Feature ownership

Owned: hazard feeds including flood, storm, landslide and VNDMS live data;
emergency events and public emergency projection; EOP; dispatch and responder
assignment; emergency resource units; SITREP and deltas; AAR; live hazard SSE;
emergency command centre, phase boards and rescue operations; public
hazard/emergency map; map/geocode/AI for this product.

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
passwords and creates no user dataset. Production identity must be delegated to
the Tier-1 IAM/API gateway; `AUTH_SECRET` is optional and falls back to an
ephemeral start-up secret with a warning. Internal emergency routes and hazard
mutations require `Authorization: Bearer <access_token>`; keep hazard reads and
the public projection list (`/v1/emergency/public`,
`/v1/emergency/stream/hazards`, `/v1/hazards`, `/v1/hazards/recent`,
`/v1/hazards/vndms-live`, `/v1/hazards/geo/*`, `/v1/map/*`, `/v1/geo/*`,
`/v1/ai/*`, `/v1/sos`) unauthenticated.

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
sos-after-action-reports
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
