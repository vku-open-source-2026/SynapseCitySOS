# SynapseCitySOS documentation

This directory documents **emergency operations only**. The legacy OpenInfra
infrastructure-management documents were removed from this repository; they
belong to the separate SynapseCity product at
<https://synapsecity.sbs> and remain in the SynapseCity repository.

## Canonical references

- SOS API reference: `/docs` in the running console
  (`https://sos.synapsecity.sbs/docs`)
- Product boundary: [`../../../PRODUCT_BOUNDARY.md`](../../../PRODUCT_BOUNDARY.md)
- Architecture and agent rules: [`../../../AGENTS.md`](../../../AGENTS.md)
- Deployment: [`../../../infra/DEPLOYMENT.md`](../../../infra/DEPLOYMENT.md)

## Owned scope

- hazard feeds (flood, storm, landslide, VNDMS) and live hazard SSE;
- emergency events and public emergency projection;
- EOP plans;
- dispatch orders and emergency resource units;
- SITREP and after-action reports;
- emergency command centre, phase boards and rescue operations;
- public hazard/emergency map and the SOS auth shell.

## Not owned

City asset registry, city incidents, IoT, maintenance work orders, technician
portal, infrastructure alerts, budgets, operational reports, city users,
geofences, data ingest, public asset map and public incident reporting are
**SynapseCity** features. They must not be documented, imported or implemented
here.

SOS responders are emergency resource units, not City users. `affected_asset_ids`
on an emergency event is an opaque reference only; SOS never resolves or copies
City asset records.
