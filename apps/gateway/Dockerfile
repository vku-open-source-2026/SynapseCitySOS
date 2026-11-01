# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 VKU.VIC
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY SynapseCitySOS/package*.json ./
COPY SynapseCitySOS/apps/gateway/package*.json SynapseCitySOS/apps/gateway/tsconfig.json ./apps/gateway/
COPY SynapseCitySOS/apps/gateway/src ./apps/gateway/src
RUN npm ci && npm run build --workspace=@synapsecity/sos-gateway
FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/gateway/dist ./apps/gateway/dist
COPY --from=build /app/apps/gateway/package.json ./apps/gateway/
EXPOSE 8080
CMD ["node", "apps/gateway/dist/src/index.js"]
