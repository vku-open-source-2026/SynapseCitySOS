# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM rust:1-bookworm AS builder
WORKDIR /workspace
COPY SynapseCitySOS/apps/gateway/Cargo.toml SynapseCitySOS/apps/gateway/Cargo.lock ./
COPY SynapseCitySOS/apps/gateway/src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home app

COPY --from=builder /workspace/target/release/synapsecity-sos-gateway /usr/local/bin/synapsecity-sos-gateway

ENV PORT=8080 \
    NODE_ENV=production

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/synapsecity-sos-gateway", "--healthcheck"]

USER app
ENTRYPOINT ["/usr/local/bin/synapsecity-sos-gateway"]
