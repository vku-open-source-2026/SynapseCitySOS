# Mock data in the SOS console

SynapseCitySOS mocks may cover emergency operations only: hazards, emergency
events, EOP, dispatch orders, resource units, SITREP, AAR and command-centre
views. They must use the SOS API shapes (`/v1/emergency*`, `/v1/hazards*`).

This repository does **not** include mock data for city assets, city incidents,
IoT, maintenance, technician work, infrastructure alerts, budgets, operational
reports, geofences, ingest, the public asset map or City users. Those features
belong to SynapseCity (`https://synapsecity.sbs`). Do not add their endpoints,
types or fixtures here.

## Enabling mocks

Set `VITE_USE_MOCK_DATA=true` for local frontend work:

```bash
VITE_USE_MOCK_DATA=true npm run dev
```

The `dev:mock` script does the same:

```bash
npm run dev:mock
```

Mocks are development-only. Production builds must call the real SOS gateway at
`/v1`; never ship a mock that hides an unavailable Tier-2 dependency.

## Adding a mock

1. Confirm the feature is on the SOS owned list in
   [`../../PRODUCT_BOUNDARY.md`](../../PRODUCT_BOUNDARY.md).
2. Put the fixture under `src/api/mocks/` and type it against the SOS domain
   types.
3. Match the real endpoint path and response shape so switching
   `VITE_USE_MOCK_DATA` off requires no component change.
4. Do not import City modules, types or fixtures.
5. Remove or disable the mock once the service endpoint is available.
