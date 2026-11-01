# SynapseCitySOS production deployment

Create the external network once:

```bash
docker network create synapsecity-sos-public-stack
```

Set `SYNAPSEDX_API_KEY` in `.env`, start the stack, and attach the SynapseOne
edge container to `synapsecity-sos-public-stack`. The edge routes
`sos.synapsecity.sbs` to `synapsecity-sos-gateway:8080` for `/health`,
`/ready`, and `/v1/*`, and routes the remaining paths to
`synapsecity-sos-console:80`.
