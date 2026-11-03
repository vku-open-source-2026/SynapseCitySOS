# Changelog

All notable changes to SynapseCitySOS are documented here. Entries follow the
Keep a Changelog format and version tags use Semantic Versioning.

## [Unreleased] - 2026-11-03

### Changed

- Split SynapseCitySOS from SynapseCity. SOS now owns only emergency
  operations: hazard feeds including VNDMS, emergency events, EOP, dispatch,
  emergency resource units, SITREP, AAR, live hazard SSE, the command centre
  and the public hazard/emergency map.
- Documented the public boundary as `https://sos.synapsecity.sbs`.
- Represented responders as `sos-resource-units`; removed the City user model
  and any `/v1/users` dependency.
- Updated `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, the new
  `PRODUCT_BOUNDARY.md` and the console documentation to describe the split.

### Removed

- Foreign City console routes and pages under `/admin/assets*`,
  `/admin/incidents*`, `/admin/iot*`, `/admin/budgets*`, `/admin/reports*`,
  `/admin/alerts*`, `/admin/ingest`, `/admin/users*`, `/technician*`,
  `/asset/$id`, `/public/report*`, `/public/incidents*` and `/disaster`.
- City API handlers, service modules, client functions, types and navigation
  entries from the SOS gateway, service and console.
- City datasets and seeds from the SOS configuration.

### Added

- Gateway guards that return `404` with `{ "error": "not_found" }` for foreign
  city `/v1` namespaces before any upstream call.
- Service start-up guard and tests that reject any dataset without the `sos-`
  prefix.
- `GET /v1/sos` feature metadata that advertises owned SOS features and lists
  the City features as not owned.
- `/v1/auth/*` stateless HMAC session shell (login, register, refresh, logout,
  change-password, me, verify) with optional `AUTH_SECRET`; no password or user
  dataset is created.
- `requireSession` protection for internal emergency and hazard routes while
  keeping the public emergency projection, hazard reads, stream, map, geo and AI
  routes open.
- `POST /v1/hazards/expire-stale` with a configurable TTL (default 24 hours).

### Fixed

- Hazard SSE frames now use real LF newlines (`event: hazards\ndata: ...\n\n`),
  so `EventSource` dispatches the `hazards` event. A raw-byte regression test
  covers the stream.
- Hazard deploy returns `hazard_id`, `event_id`, `eop_plan_id` and
  `markdown_body` alongside the legacy nested `hazard`/`event`/`eop_plan`
  objects, so the EOP modal can save and submit drafts.
- Dispatch approval normalizes `assigned_resource_unit_id` (accepting legacy
  `resource_unit_id`/`assigned_user_id`) and mirrors the same resource-unit id
  into `assignments[]`; the rescue page resolves the canonical field.
- The console normalizes non-array 200 responses (`asList`) so the command
  centre and hazard map show an empty/error state instead of crashing on HTML.
- Encoded `/%76%31/...` API paths are decoded and proxied to the canonical
  `/v1` route (or rejected with JSON 404); they never return the console SPA.
- Regenerated `apps/console/package-lock.json` so `npm ci` and
  `docker compose build` succeed, and added `apps/console/.dockerignore`.
- SOS PWA manifest and service-worker cache now use SynapseCity SOS branding
  instead of `OpenInfra`.
- SOS API docs list the implemented auth endpoints, mark Bearer-protected
  routes and use `https://sos.synapsecity.sbs` only.

## [0.1.0] - 2026-11-01

- Published the emergency operations API, console and public SSE hazard stream.
- Migrated flood, storm and emergency workflows from OpenInfra.
- Added Apache-2.0 licensing and VKU.VIC attribution.
