// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import PublicHazardMap from '../pages/DisasterMap';

/**
 * Public SOS hazard / emergency map.
 * Citizen incident reporting and public asset lookup belong to SynapseCity.
 */
export const Route = createFileRoute('/map')({
  component: PublicHazardMap,
});
