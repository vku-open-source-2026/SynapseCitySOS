# SynapseCitySOS — emergency operations (Tier 3)

SynapseCitySOS is the emergency operations product of the Synapse platform. It
owns emergency preparedness, response and recovery: hazard feeds including
VNDMS live data, emergency events, emergency operations plans (EOP), dispatch
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

- flood, storm, landslide and other hazard feeds, including VNDMS live data;
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

Build the Tier-2 SDK first; the workspace-local dependency is intentional for
development:

```bash
cd ../SynapseDX/sdks/capabilities-js && npm install && npm run build
cd ../../SynapseCitySOS && npm ci && npm run build
SYNAPSEDX_BASE_URL=https://synapsedx.sbs AUTH_SECRET=<strong-secret> \
  npm run start --workspace=@synapsecity/sos-service
```

`AUTH_SECRET` is optional for local development. If it is empty the service
generates an ephemeral HMAC secret at start-up and logs a warning; set a strong
value in production so sessions survive a restart.

Console development:

```bash
npm run dev --workspace=@synapsecity/sos-console
```

The production stack is reproducible with `docker compose up -d --build`. For a
registry release, replace the `file:` dependency with the published
`@synapsedx/capabilities` version after the package has been released.

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
login/register/refresh/logout/change-password/me/verify. It stores no password
and creates no SOS user dataset or City user record; production identity must be
delegated to the Tier-1 IAM gateway. Internal emergency routes require
`Authorization: Bearer <access_token>`, as do hazard mutations; hazard reads
(`/v1/hazards`, `/v1/hazards/recent`, `/v1/hazards/vndms-live`,
`/v1/hazards/geo/*`) and the public projections (`/v1/emergency/public`,
`/v1/emergency/stream/hazards`, `/v1/map/*`, `/v1/geo/*`, `/v1/ai/*`,
`/v1/sos`) remain open. Dispatch approval uses `assigned_resource_unit_id`,
mirrored to the legacy `assigned_user_id` field for older clients.

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

## PoF project checklist

- License: Apache-2.0 (`LICENSE`) with per-source SPDX headers and attribution in `NOTICE`.
- Build from source: `npm ci && npm run build` using Node.js 20+; Docker builds are reproducible with `docker compose build`.
- Issue tracker: [GitHub Issues](https://github.com/vku-open-source-2026/SynapseCitySOS/issues).
- Change history: [`CHANGELOG.md`](CHANGELOG.md). Versioned release tags are published on GitHub.
- Dependency inventory: [`THIRD-PARTY.md`](THIRD-PARTY.md); dependencies are not modified or bundled into the repository.
