// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useQuery } from '@tanstack/react-query';
import { emergencyApi } from '../api/emergency';
import { isOngoingEmergencyStatus } from '../lib/emergencyStatus';
import type { PublicEmergencyEvent } from '../types/emergency';

export function usePublicEmergencyEvents(enabled = true, limit = 50) {
  return useQuery<PublicEmergencyEvent[]>({
    queryKey: ['emergency', 'public', limit],
    // The server already excludes terminal statuses; keep the rule client-side
    // so a cached/stale payload can never show a resolved event as ongoing.
    queryFn: async () => (await emergencyApi.listPublic({ limit })).filter((event) => isOngoingEmergencyStatus(event.status)),
    enabled,
    staleTime: 60_000,
    refetchInterval: 2 * 60_000,
  });
}
