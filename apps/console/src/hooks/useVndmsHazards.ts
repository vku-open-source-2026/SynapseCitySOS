// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useQuery } from '@tanstack/react-query';
import { asList, httpClient } from '../lib/httpClient';
import type { HazardIngestStatus } from '../api/hazards';

export interface VndmsHazard {
  id: string;
  hazard_id?: string;
  lat: number;
  lon: number;
  label: string;
  warning_type:
    | 'water_level'
    | 'warning_rain'
    | 'warning_wind'
    | 'warning_earthquake'
    | 'warning_flood';
  warning_level: number;
  severity: 'low' | 'medium' | 'high';
  value: string;
  popupInfo: string;
  source: string;
  observed_at?: string | null;
}

export function useVndmsHazards(enabled = true) {
  return useQuery({
    queryKey: ['hazards', 'vndms-live'],
    queryFn: async () => {
      const resp = await httpClient.get<VndmsHazard[]>('/hazards/vndms-live');
      return asList<VndmsHazard>(resp.data);
    },
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function useVndmsStatus(enabled = true) {
  return useQuery<HazardIngestStatus>({
    queryKey: ['hazards', 'vndms-status'],
    queryFn: async () => {
      const resp = await httpClient.get<HazardIngestStatus>('/hazards/ingest/status');
      return resp.data;
    },
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
