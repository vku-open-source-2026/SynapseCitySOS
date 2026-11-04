# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:20-bookworm-slim AS build
WORKDIR /workspace
COPY SynapseCitySOS/package*.json ./SynapseCitySOS/
COPY SynapseCitySOS/vendor ./SynapseCitySOS/vendor
COPY SynapseCitySOS/apps/sos-service/package*.json SynapseCitySOS/apps/sos-service/tsconfig.json ./SynapseCitySOS/apps/sos-service/
COPY SynapseCitySOS/apps/sos-service/src ./SynapseCitySOS/apps/sos-service/src
RUN cd SynapseCitySOS && npm ci && npm run build --workspace=@synapsecity/sos-service

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/SynapseCitySOS/package*.json ./
COPY --from=build /workspace/SynapseCitySOS/node_modules ./node_modules
COPY --from=build /workspace/SynapseCitySOS/apps/sos-service/dist ./apps/sos-service/dist
COPY --from=build /workspace/SynapseCitySOS/apps/sos-service/package.json ./apps/sos-service/
EXPOSE 8084
CMD ["node", "apps/sos-service/dist/src/server.js"]
