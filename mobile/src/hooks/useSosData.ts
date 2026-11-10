// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { sosApi } from '../api/sos';
import type { Hazard, PublicEmergencyEvent } from '../api/types';
import { distanceMeters, firstPoint } from '../lib/geo';
import { buildSosWidgetSnapshot, syncSosWidget } from '../lib/widget';
import type { AppLocation } from './useLocation';

export const queryKeys = {
  product: ['sos', 'product'] as const,
  feed: ['sos', 'feed'] as const,
  hazards: ['sos', 'hazards'] as const,
  events: ['sos', 'events'] as const,
  shelters: (lat: number, lng: number) => ['sos', 'shelters', lat.toFixed(3), lng.toFixed(3)] as const,
  mapConfig: ['sos', 'map-config'] as const,
  responder: ['sos', 'responder'] as const,
};

export function useSosProduct() {
  return useQuery({
    queryKey: queryKeys.product,
    queryFn: sosApi.getProductInfo,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function useFeedStatus() {
  return useQuery({
    queryKey: queryKeys.feed,
    queryFn: sosApi.getFeedStatus,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}

export function useHazards() {
  return useQuery({
    queryKey: queryKeys.hazards,
    queryFn: () => sosApi.listHazards({ limit: 300 }),
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}

export function usePublicEvents() {
  return useQuery({
    queryKey: queryKeys.events,
    queryFn: () => sosApi.listPublicEvents({ limit: 100 }),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}

export function useShelters(location: AppLocation) {
  return useQuery({
    queryKey: queryKeys.shelters(location.latitude, location.longitude),
    queryFn: () =>
      sosApi.nearbyShelters({
        lat: location.latitude,
        lng: location.longitude,
        radius_m: 50_000,
        limit: 50,
      }),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export interface NearbyHazard {
  hazard: Hazard;
  distance: number;
  coordinates: { latitude: number; longitude: number };
}

export function useNearbyHazards(
  hazards: Hazard[] | undefined,
  location: AppLocation,
  radiusMeters = 100_000,
): NearbyHazard[] {
  return useMemo(() => {
    const origin = { latitude: location.latitude, longitude: location.longitude };
    return (hazards ?? [])
      .map((hazard) => {
        const coordinates = firstPoint(hazard.geometry);
        if (!coordinates) return null;
        const distance = distanceMeters(origin, coordinates);
        return distance <= radiusMeters ? { hazard, distance, coordinates } : null;
      })
      .filter((entry): entry is NearbyHazard => Boolean(entry))
      .sort((a, b) => a.distance - b.distance);
  }, [hazards, location.latitude, location.longitude, radiusMeters]);
}

export function useActiveHazards(hazards: Hazard[] | undefined): Hazard[] {
  return useMemo(
    () =>
      (hazards ?? []).filter(
        (hazard) => hazard.is_active !== false && hazard.status !== 'expired',
      ),
    [hazards],
  );
}

export function useSosWidgetSync(
  location: AppLocation,
  hazards: Hazard[] | undefined,
  events: PublicEmergencyEvent[] | undefined,
  feed: Parameters<typeof buildSosWidgetSnapshot>[3],
) {
  const signature = useRef('');
  useEffect(() => {
    if (!hazards || location.updatedAt === 0) return;
    const snapshot = buildSosWidgetSnapshot(
      {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy,
        updatedAt: location.updatedAt,
        label: location.label,
      },
      hazards,
      events ?? [],
      feed,
      { locationLabel: location.label, locationIsFallback: location.isFallback },
    );
    const next = JSON.stringify({
      lat: snapshot.latitude.toFixed(4),
      lng: snapshot.longitude.toFixed(4),
      hazards: snapshot.hazards.length,
      nearest: snapshot.nearestHazardId,
      events: snapshot.activeEvents,
      feed: snapshot.feedStatus,
    });
    if (next === signature.current) return;
    signature.current = next;
    syncSosWidget(snapshot).catch(() => undefined);
  }, [location, hazards, events, feed]);
}
