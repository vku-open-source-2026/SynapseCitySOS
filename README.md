# SynapseCitySOS — Tier 3 emergency operations

SynapseCitySOS is the VKU.VIC emergency domain product for floods, storms,
hazards, emergency events, EOP, dispatch, resources, SITREP, live streams and
after-action reports. It is deployed at <https://sos.synapsecity.sbs>.

## Build from source

```bash
npm ci
npm run build
npm test --workspace=@synapsecity/sos-service
npm run build --workspace=@synapsecity/sos-console
```

The production stack is reproducible with `docker compose up -d --build`.
Runtime persistence and queues are provided through the public SynapseDX API;
this repository does not contain a private database or queue dependency.

Map tiles, autocomplete, forward geocoding and reverse geocoding are proxied
through the SOS backend. Set `VIETMAP_API_KEY` and optionally
`VIETMAP_TILE_STYLE=tm|lm|dm|hm|st` in the server `.env`; the key is never sent
to the browser.

## Issue tracker and changes

Use the public GitHub Issues tab for bugs and feature requests. See
`CHANGELOG.md` for version history. The repository is Apache-2.0 licensed.

## PoF project checklist

- License: Apache-2.0 (`LICENSE`) with per-source SPDX headers and attribution in `NOTICE`.
- Build from source: `npm ci && npm run build` using Node.js 20+; Docker builds are reproducible with `docker compose build`.
- Issue tracker: [GitHub Issues](https://github.com/vku-open-source-2026/SynapseCitySOS/issues).
- Change history: [`CHANGELOG.md`](CHANGELOG.md). Versioned release tags are published on GitHub.
- Dependency inventory: [`THIRD-PARTY.md`](THIRD-PARTY.md); dependencies are not modified or bundled into the repository.
