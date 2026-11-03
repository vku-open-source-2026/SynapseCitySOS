# Contributing to SynapseCitySOS

SynapseCitySOS is Apache-2.0 software maintained by VKU.VIC.

Before changing code, read:

1. [`PRODUCT_BOUNDARY.md`](PRODUCT_BOUNDARY.md) for this repository's owned and
   not-owned features.
2. [`AGENTS.md`](AGENTS.md) for the Tier-2 dependency contract, API namespaces,
   datasets and console routes.
3. The workspace `FEATURE_BOUNDARY.md` for the authoritative split with
   SynapseCity (when working in the monorepo).

Rules for a pull request:

- Keep emergency persistence and queueing in SynapseDX; do not add a database,
  queue or in-memory production store.
- Use only `sos-*` datasets and the SOS `/v1` namespaces.
- Represent responders as SOS resource units, never as `/v1/users` records.
- Do not import SynapseCity modules or types and do not call its API. A public
  HTTPS navigation link is allowed; a data dependency is not.
- Do not add asset, city incident, IoT, maintenance, technician, infrastructure
  alert, budget, operational report, geofence, ingest or public asset pages to
  this console.
- Build with `npm ci && npm run build`, run `npm test`, and keep the gateway
  foreign-namespace 404 tests passing.
- Retain SPDX headers, `NOTICE` and a changelog entry for user-visible changes.

Use GitHub Issues for bugs and proposals. The issue tracker is
<https://github.com/vku-open-source-2026/SynapseCitySOS/issues>.
