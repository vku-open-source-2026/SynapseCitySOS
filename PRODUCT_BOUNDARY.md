# SynapseCitySOS — product boundary

Status: repo-local reference for the 2026-11-03 feature split. The authoritative
workspace contract is `FEATURE_BOUNDARY.md` at the workspace root (outside this
repository).

## Identity

| Field | Value |
| --- | --- |
| Product | SynapseCitySOS |
| Tier | 3 |
| Domain | Emergency operations |
| Public URL | `https://sos.synapsecity.sbs` |
| Console | `https://sos.synapsecity.sbs` (served through the gateway) |
| API | `https://sos.synapsecity.sbs/v1` |
| Sibling product | SynapseCity at `https://synapsecity.sbs` |
| License | Apache-2.0 (`LICENSE`, `NOTICE`, `THIRD-PARTY.md`) |

## Dependency contract

```text
SynapseCitySOS -> @synapsedx/capabilities -> @synapseone/sdk -> SynapseOne
```

- Tier 2 only: `https://synapsedx.sbs`, through `@synapsedx/capabilities`.
- No `@synapseone/sdk` import, SynapseOne call, Tier-1 service access or Tier-2
  database access from this repository.
- No database, queue, cache or filesystem fallback. Domain records are written
  through the Tier-2 records API; public projections are read through the
  Tier-2 publication API.
- No call to SynapseCity. A public HTTPS link to City is navigation only.

## Owned capabilities

- Flood, storm, landslide and other hazard feeds, including VNDMS ingestion.
- Emergency events and public emergency projection.
- Emergency operations plans (EOP).
- Dispatch orders and responder assignment.
- Emergency resource units: rescue personnel, vehicles, medical supplies,
  rescue equipment and shelters (emergency logistics only).
- SITREP and deltas.
- AAR.
- Live hazard SSE stream.
- Emergency command centre, phase boards and rescue operation view.
- Public hazard/emergency map.
- Map tiles, geocoding, reverse geocoding and AI capability instance for this
  product.

## Not owned

SynapseCitySOS does **not** own:

- city assets or the asset registry/GIS lifecycle;
- city incidents or citizen incident reports;
- IoT sensors or readings;
- maintenance work orders, preventive maintenance or the technician portal;
- infrastructure alerts;
- budgets or budget transactions;
- operational reports;
- city operators or user administration;
- geofences or CSV/data ingestion;
- the public asset map, public asset lookup or public incident reporting.

These belong to SynapseCity at `https://synapsecity.sbs`. The only permitted
reference is a public HTTPS navigation link; never an API call, shared dataset
or embedded data source. An emergency event may store opaque
`affected_asset_ids`; SOS does not resolve or copy those assets.

## Responders are resource units

Emergency resource units are **rescue logistics**, not infrastructure assets.
A resource unit is a team, vehicle, medical supply, rescue equipment or shelter
that can be dispatched to an emergency. SOS does not own an asset registry,
asset lifecycle, GIS asset map, maintenance work order, IoT sensor management
or infrastructure budget. If an emergency event needs to reference a City
asset, it stores an opaque `affected_asset_ids` value only.

SOS responders are represented as records in `sos-resource-units`, exposed
through `/v1/emergency/resources`. They are **not** City user records:

- SOS does not expose `/v1/users`.
- SOS never reads or writes `city-users`.
- Dispatch assignment references an SOS resource unit, not a City operator ID.
  The canonical field is `assigned_resource_unit_id`; `assigned_user_id` is a
  deprecated wire mirror of the same opaque resource-unit id.
- Login/register/profile settings use the SOS `/v1/auth` session shell. They do
  not make a responder a City user.

## Auth shell

`/v1/auth/*` is reachable through the gateway and implemented by
`apps/sos-service`. It issues a stateless HS256 session token
(`event: access | refresh`) signed with `AUTH_SECRET`. The shell stores no
passwords and creates no SOS user dataset or City user record.

Identity (password verification, MFA, account lifecycle, revocation) is
delegated to the Tier-1 IAM/API gateway through the Tier-2 auth capability:
`SOS_AUTH_MODE=tier2` is the default and the production path, and the
`@synapsedx/capabilities` `auth` namespace supplies login/register/refresh/
logout/me/changePassword and the optional delegated exchange. The verified
Tier-2 access/refresh token is carried inside the signed SOS session and is
forwarded only to Tier-2; it is never exposed to the browser as a response
field. If `AUTH_SECRET` is unset, the service generates an ephemeral secret at
start-up and logs a warning.

Roles are assigned by the server after verification: `responder` by default,
`admin` only when the verified email is listed in `SOS_BOOTSTRAP_ADMIN_EMAILS`.
(`SOS_AUTH_DEFAULT_ROLE` can adjust the fallback but can never grant `admin`.)
A client-supplied `role` is ignored. Registration through Tier-2 creates a
responder account (or `admin` for a bootstrap email); password change is
delegated to Tier-2 and returns `503 identity_not_configured` without a Tier-2
token.

The development-only demo shell requires both `SOS_AUTH_MODE=demo` and
`ALLOW_DEMO_AUTH=true` outside production; `NODE_ENV=production` refuses to
start with either demo switch enabled. A demo login is always `responder`,
registration is read-only, and demo sessions never grant `admin`/`manager`.
Tokens are accepted only from the `Authorization` header, never a URL query.

Internal emergency routes require `Authorization: Bearer <access_token>` and an
explicit permission: `emergency:read`, `emergency:write`,
`emergency:dispatch`, or `emergency:eop`. The unauthenticated public surface is
limited to `/v1/emergency/public`, `/v1/emergency/public/status`,
`/v1/emergency/stream/hazards`, `/v1/emergency/resources/shelters/near`,
`/v1/hazards` reads (`/v1/hazards`, `/v1/hazards/recent`,
`/v1/hazards/vndms-live`, `/v1/hazards/ingest/status`,
`/v1/hazards/geo/*`), `/v1/map/*`, `/v1/geo/*`, `/v1/ai/*`, `/v1/sos`,
`/health` and `/ready`. `POST /v1/hazards/ingest` is an authenticated feed sink;
the scheduled pull belongs to Tier 2.

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

Foreign namespaces must return HTTP `404` with `{ "error": "not_found" }`
before any handler or Tier-2 call:

```text
/v1/assets*        /v1/incidents*
/v1/maintenance*   /v1/iot*
/v1/alerts*        /v1/budgets*
/v1/reports*       /v1/geofences*
/v1/ingest*        /v1/notifications*
/v1/public/assets* /v1/public/incidents*
```

`GET /v1/sos` advertises the owned features above and explicitly lists the
not-owned city features.

## Dataset ownership

Every dataset uses the `sos-` prefix. A `city-` dataset is foreign and must
never be read or written. The service fails at start-up if a configured dataset
does not use the SOS prefix.

```text
sos-emergency-events        sos-eop-plans
sos-dispatch-orders         sos-resource-units
sos-sitreps                 sos-hazard-layers
sos-after-action-reports    sos-hazard-ingest-runs
```

## Console route ownership

Tier 3 is public presentation only (2026-11-14 workspace contract). Work,
login and emergency-command surfaces live in the Tier-2 SynapseDX workspace at
`https://synapsedx.sbs/workspace`.

Served by this console:

```text
/                              SOS landing
/about                         SOS product
/docs                          SOS API docs
/map                           public hazard/emergency map
```

Redirected to `https://synapsedx.sbs/workspace`:

```text
/login /register
/admin/**  (dashboard, emergency command centre and phase boards, settings)
/technician/**
/workspace/**
```

`/v1/auth/*` returns `410 workspace_moved` before credential handling. The
portable SOS plugin bundles that replace the retired pages live in `plugins/`.

Never add:

```text
/admin/assets* /admin/incidents* /admin/iot* /admin/budgets*
/admin/reports* /admin/alerts* /admin/ingest /admin/users*
/technician* /asset/$id /public/report* /public/incidents*
/disaster (use /map for the public hazard map)
```

## Cross-product rules

- Allowed: a public HTTPS link to `https://synapsecity.sbs` in navigation or
  documentation.
- Forbidden: calling a City endpoint, importing City modules or types, reading
  a `city-*` dataset, sharing a queue/cache/database, or proxying City traffic
  through the SOS gateway.
- Map, geocoding and AI are per-product instances. They may use the same
  external provider, but they never share a database, cache or server-side
  proxy with City.
- Auth, login, register and profile settings are shared **shell code** only.
  They are copied per product and never share a user table or session store.

## Change checklist

1. The feature belongs to the owned list above.
2. The API path is in the SOS namespace list and uses `sos-*` datasets.
3. The console route is in the owned route list.
4. Responders are resource units, never `/v1/users` entries.
5. No import, URL or type comes from SynapseCity.
6. `npm run build`, `npm test` and the gateway 404 tests pass.
7. `README.md`, `AGENTS.md` and this file stay consistent.
