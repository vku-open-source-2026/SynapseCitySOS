# SynapseCitySOS production deployment

The stack has three containers on the private
`synapsecity-sos-public-stack` network:

| Service | Container port | Host port | Public route |
| --- | --- | --- | --- |
| `gateway` | `8080` | `${GATEWAY_HOST_PORT:-8086}` | `https://sos.synapsecity.sbs/health`, `/ready`, `/v1/*` |
| `sos-service` | `8084` | not published | internal only |
| `console` | `80` | not published | `https://sos.synapsecity.sbs/` |

The gateway always listens on container port `8080`; the TLS edge and the
compose console proxy target that port. The default host port is `8086` so it
can never be confused with the private `sos-service` port `8084`. Override
`GATEWAY_HOST_PORT` when another local stack already uses `8086`.

Create the external network once:

```bash
docker network create synapsecity-sos-public-stack
```

Set `SYNAPSEDX_API_KEY` in `.env`, start the stack, and attach the SynapseOne
edge container to `synapsecity-sos-public-stack`:

```bash
docker network connect synapsecity-sos-public-stack synapseone-nginx-1
```

Include `nginx/synapsecity-sos.conf` in the public TLS edge. It routes
`https://sos.synapsecity.sbs/health`, `/ready`, and `/v1/*` (including the
unbuffered `/v1/emergency/stream/hazards` SSE stream) to
`synapsecity-sos-gateway:8080`, and the remaining paths to
`synapsecity-sos-console:80`. Issue a certificate containing
`sos.synapsecity.sbs` and point its DNS A/AAAA record at this host before
enabling the TLS server block.

Production configuration must not use `localhost` or a private service address
for `SYNAPSEDX_BASE_URL`; the compose file forces `https://synapsedx.sbs` and
`ALLOW_LOCAL_DEPENDENCIES=false`. The console is served through the gateway's
console proxy for local single-port access, and directly by the edge at the
domain root in production; its relative `/v1` calls always stay on the
gateway.
