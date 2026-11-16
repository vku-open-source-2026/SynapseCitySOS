// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import EventSource from 'react-native-sse';
import type { Hazard } from '../api/types';
import { API_BASE } from '../api/client';
import { queryKeys } from './useSosData';

type StreamState = 'connecting' | 'live' | 'degraded' | 'offline';

export function useHazardStream(enabled = true) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<StreamState>('connecting');
  const [lastGoodAt, setLastGoodAt] = useState<string | null>(null);
  const sourceRef = useRef<EventSource<'hazards'> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;

    const connect = () => {
      sourceRef.current?.close();
      const source = new EventSource<'hazards'>(
        `${API_BASE}/emergency/stream/hazards`,
        { pollingInterval: 0, timeout: 0, debug: false },
      );
      sourceRef.current = source;
      source.addEventListener('open', () => {
        if (active) setState('live');
      });
      source.addEventListener('hazards', (event) => {
        if (!active || !event.data) return;
        try {
          const payload = JSON.parse(event.data) as {
            snapshot?: Hazard[];
            degraded?: boolean;
            last_good_at?: string;
          };
          const snapshot = payload.snapshot;
          if (Array.isArray(snapshot) && snapshot.length > 0) {
            // The SSE projection can momentarily contain only the stored
            // dataset while `/v1/hazards` also merges the Tier-2 feed. Merge
            // instead of replacing so an empty/lagging SSE snapshot never
            // wipes the REST list and makes the UI look like there are no
            // warnings.
            queryClient.setQueryData<Hazard[]>(queryKeys.hazards, (current) => {
              const merged = new Map<string, Hazard>();
              for (const hazard of current ?? []) merged.set(hazard.id, hazard);
              for (const hazard of snapshot) merged.set(hazard.id, hazard);
              return Array.from(merged.values());
            });
          }
          if (payload.last_good_at) setLastGoodAt(payload.last_good_at);
          setState(payload.degraded ? 'degraded' : 'live');
        } catch {
          // Ignore a malformed frame; polling remains active.
        }
      });
      source.addEventListener('error', () => {
        if (active) setState('degraded');
      });
    };

    connect();
    const subscription = AppState.addEventListener('change', (appState) => {
      if (appState === 'active') connect();
      if (appState === 'background') {
        sourceRef.current?.close();
        sourceRef.current = null;
      }
    });

    return () => {
      active = false;
      subscription.remove();
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [enabled, queryClient]);

  return { state, lastGoodAt };
}
