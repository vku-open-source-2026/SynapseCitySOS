# SynapseCitySOS — Tier 3 emergency operations product

SynapseCitySOS owns emergency domain workflows migrated from OpenInfra:
hazards (including flood and storm alerts), emergency events, EOP plans,
dispatch orders, resource units, situation reports, live hazard streams and
after-action reports.

The dependency direction is strict:

```text
SynapseCitySOS -> @synapsedx/capabilities -> @synapseone/sdk -> SynapseOne
```

Runtime calls leave this product through the public HTTPS boundary
`https://synapsedx.sbs`. This repository has no database, queue connection,
private SynapseOne URL, localhost fallback or in-memory production store.
Persistence, publication and events stay in SynapseDX and SynapseOne.

The public product boundary is `https://sos.synapsecity.sbs` and is split into
`apps/gateway`, `apps/sos-service`, `apps/console`, and `infra` in the same way
as the other Synapse products.
