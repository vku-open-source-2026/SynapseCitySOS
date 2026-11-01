# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:20-bookworm-slim AS build
WORKDIR /workspace
COPY SynapseDX/sdks/capabilities-js/package*.json ./SynapseDX/sdks/capabilities-js/
COPY SynapseDX/sdks/capabilities-js/tsconfig.json ./SynapseDX/sdks/capabilities-js/
COPY SynapseDX/sdks/capabilities-js/src ./SynapseDX/sdks/capabilities-js/src
RUN cd SynapseDX/sdks/capabilities-js && npm ci && npm run build
COPY SynapseCitySOS/package*.json ./SynapseCitySOS/
COPY SynapseCitySOS/apps/sos-service/package*.json SynapseCitySOS/apps/sos-service/tsconfig.json ./SynapseCitySOS/apps/sos-service/
COPY SynapseCitySOS/apps/sos-service/src ./SynapseCitySOS/apps/sos-service/src
RUN cd SynapseCitySOS && npm ci && npm run build --workspace=@synapsecity/sos-service

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/SynapseCitySOS/package*.json ./
COPY --from=build /workspace/SynapseCitySOS/node_modules ./node_modules
RUN rm -f /app/node_modules/@synapsedx/capabilities
COPY --from=build /workspace/SynapseDX/sdks/capabilities-js ./node_modules/@synapsedx/capabilities
COPY --from=build /workspace/SynapseCitySOS/apps/sos-service/dist ./apps/sos-service/dist
COPY --from=build /workspace/SynapseCitySOS/apps/sos-service/package.json ./apps/sos-service/
EXPOSE 8084
CMD ["node", "apps/sos-service/dist/src/server.js"]
