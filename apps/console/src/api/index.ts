// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * SynapseCity SOS API surface.
 *
 * Only emergency-operations namespaces are exported here:
 * /v1/emergency*, /v1/hazards*, /v1/geo, /v1/map, /v1/ai and the auth shell.
 * City-infrastructure APIs (assets, incidents, IoT, maintenance, budgets,
 * reports, alerts, users, ingest) belong to the SynapseCity product.
 */
export * from './auth';
export * from './emergency';
export * from './eop';
export * from './dispatch';
export * from './resources';
export * from './sitrep';
export * from './hazards';
export * from './after-action-reports';
export * from './geo';
