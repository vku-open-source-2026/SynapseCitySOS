// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { NativeModules, Platform } from 'react-native';
import type { FeedStatus, Hazard, PublicEmergencyEvent, Severity } from '../api/types';
import { distanceMeters, firstPoint } from './geo';
import { normalizeSeverity } from './format';
import { feedHealth } from './feed';
import { saveWidgetSnapshot, type StoredLocation } from './storage';

export interface WidgetHazard {
  id: string;
  title: string;
  severity: Severity;
  latitude: number;
  longitude: number;
  distanceM: number;
}

export interface WidgetEvent {
  id: string;
  title: string;
  severity: Severity;
  latitude: number;
  longitude: number;
}

export interface SosWidgetSnapshot {
  generatedAt: number;
  source: 'app' | 'background';
  latitude: number;
  longitude: number;
  locationLabel: string;
  locationIsFallback: boolean;
  feedStatus: 'ok' | 'degraded' | 'unknown';
  feedLabel: string;
  activeEvents: number;
  maxEventSeverity: Severity | null;
  nearestHazardId: string | null;
  nearestHazardTitle: string | null;
  nearestHazardSeverity: Severity | null;
  nearestHazardDistanceM: number | null;
  hazards: WidgetHazard[];
  events: WidgetEvent[];
  online: boolean;
}

type WidgetBridgeModule = {
  sync(snapshotJson: string): void;
  refresh(): void;
};

const WidgetBridge = NativeModules.WidgetBridge as WidgetBridgeModule | undefined;

export function buildSosWidgetSnapshot(
  location: StoredLocation,
  hazards: Hazard[],
  events: PublicEmergencyEvent[],
  status: FeedStatus | undefined,
  options: { locationLabel?: string; locationIsFallback?: boolean } = {},
): SosWidgetSnapshot {
  const origin = { latitude: location.latitude, longitude: location.longitude };
  const nearby = hazards
    .map((hazard) => {
      const coordinates = firstPoint(hazard.geometry);
      if (!coordinates) return null;
      return {
        hazard,
        coordinates,
        distance: distanceMeters(origin, coordinates),
      };
    })
    .filter((entry): entry is { hazard: Hazard; coordinates: { latitude: number; longitude: number }; distance: number } => Boolean(entry))
    .filter((entry) => entry.distance <= 100_000)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 30);

  const nearest = nearby[0];
  const health = feedHealth(status);
  const eventRows = events
    .map((event) => {
      const coordinates = firstPoint(event.geometry);
      return {
        id: event.id,
        title: event.title,
        severity: normalizeSeverity(event.severity),
        latitude: coordinates?.latitude ?? 0,
        longitude: coordinates?.longitude ?? 0,
        hasPoint: Boolean(coordinates),
      };
    })
    .filter((event) => event.hasPoint)
    .slice(0, 20);

  const maxEventSeverity = events.reduce<Severity | null>((max, event) => {
    const severity = normalizeSeverity(event.severity);
    if (!max) return severity;
    const rank: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
    return rank[severity] > rank[max] ? severity : max;
  }, null);

  return {
    generatedAt: Date.now(),
    source: 'app',
    latitude: location.latitude,
    longitude: location.longitude,
    locationLabel: options.locationLabel || 'Vị trí hiện tại',
    locationIsFallback: Boolean(options.locationIsFallback),
    feedStatus: health.state,
    feedLabel: health.label,
    activeEvents: events.length,
    maxEventSeverity,
    nearestHazardId: nearest?.hazard.id ?? null,
    nearestHazardTitle: nearest?.hazard.title ?? null,
    nearestHazardSeverity: nearest ? normalizeSeverity(nearest.hazard.severity) : null,
    nearestHazardDistanceM: nearest?.distance ?? null,
    hazards: nearby.slice(0, 20).map((entry) => ({
      id: entry.hazard.id,
      title: entry.hazard.title,
      severity: normalizeSeverity(entry.hazard.severity),
      latitude: entry.coordinates.latitude,
      longitude: entry.coordinates.longitude,
      distanceM: Math.round(entry.distance),
    })),
    events: eventRows,
    online: true,
  };
}

export async function syncSosWidget(snapshot: SosWidgetSnapshot): Promise<void> {
  await saveWidgetSnapshot(snapshot);
  if (Platform.OS !== 'android' || !WidgetBridge) return;
  try {
    WidgetBridge.sync(JSON.stringify(snapshot));
  } catch {
    // Widget bridge is an enhancement.
  }
}

export function requestWidgetRefresh(): void {
  if (Platform.OS !== 'android' || !WidgetBridge) return;
  try {
    WidgetBridge.refresh();
  } catch {
    // Ignore.
  }
}

export const emergencyNumbers = [
  { number: '112', label: 'Cứu hộ khẩn cấp', detail: 'Đường dây khẩn cấp quốc gia' },
  { number: '113', label: 'Công an', detail: 'An ninh, trật tự' },
  { number: '114', label: 'Cứu hoả', detail: 'Cháy, nổ, cứu nạn' },
  { number: '115', label: 'Cấp cứu', detail: 'Y tế khẩn cấp' },
];
