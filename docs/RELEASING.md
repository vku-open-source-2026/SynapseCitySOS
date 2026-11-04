# Releasing SynapseCitySOS

## CI

`.github/workflows/ci.yml` runs on every push/PR to `main`:

1. `npm ci`
2. verify the pinned Tier-2 SDK tarball checksum
3. `npm run build`
4. `npm test`
5. console lint
6. Playwright browser E2E
7. `docker compose config` + `docker compose build`

## Release

Push a semantic tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` builds and tests, then publishes:

```text
ghcr.io/vku-open-source-2026/synapsecitysos-sos-service:v0.2.0
ghcr.io/vku-open-source-2026/synapsecitysos-gateway:v0.2.0
ghcr.io/vku-open-source-2026/synapsecitysos-console:v0.2.0
```

Each image also gets `latest` and `sha-<commit>` tags. The GitHub release
contains `docker-compose.yml`, the nginx edge snippet and the pinned Tier-2 SDK
tarball/checksum.

## Deploy

```bash
docker compose pull
docker compose up -d
curl -fsS https://sos.synapsecity.sbs/health
```

Production identity is Tier-2/Tier-1 IAM: keep `SOS_AUTH_MODE=tier2`,
`ALLOW_DEMO_AUTH=false`, and set `SOS_BOOTSTRAP_ADMIN_EMAILS` to the operator
emails that should receive the `admin` role. Do not enable demo auth publicly.

## Rollback

Deploy the previous `v*` image tags or check out the previous tag and run
`docker compose up -d`. No private database or queue lives in this repository.
