// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Hazard } from '../api/types';
import { firstPoint, pointInDirection } from '../lib/geo';
import { colors, normalizeSeverity, severityMeta } from '../lib/format';
import type { AppLocation } from '../hooks/useLocation';

export function HazardRadar({
  location,
  hazards,
  events = [],
  size = 220,
  radiusMeters = 100_000,
  showLabels = true,
}: {
  location: AppLocation;
  hazards: Hazard[];
  events?: Array<{ id: string; geometry?: { type: string; coordinates: unknown } | null }>;
  size?: number;
  radiusMeters?: number;
  showLabels?: boolean;
}) {
  const center = size / 2;
  const innerRadius = center - 16;
  const visible = hazards
    .map((hazard) => {
      const coordinates = firstPoint(hazard.geometry);
      if (!coordinates) return null;
      const position = pointInDirection(
        { latitude: location.latitude, longitude: location.longitude },
        coordinates,
        radiusMeters,
      );
      return { hazard, ...position };
    })
    .filter(
      (entry): entry is { hazard: Hazard; x: number; y: number; distance: number } =>
        Boolean(entry),
    )
    .slice(0, 30);
  const eventDots = events
    .map((event) => {
      const coordinates = firstPoint(event.geometry ?? null);
      if (!coordinates) return null;
      return pointInDirection(
        { latitude: location.latitude, longitude: location.longitude },
        coordinates,
        radiusMeters,
      );
    })
    .filter((entry): entry is { x: number; y: number; distance: number } => Boolean(entry))
    .slice(0, 10);

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <View style={[styles.ring, { width: size - 12, height: size - 12, borderRadius: size / 2 }]} />
      <View style={[styles.ring, { width: size * 0.66, height: size * 0.66, borderRadius: size * 0.33, opacity: 0.65 }]} />
      <View style={[styles.ring, { width: size * 0.33, height: size * 0.33, borderRadius: size * 0.17, opacity: 0.45 }]} />
      <View style={[styles.axisH, { width: innerRadius * 2 }]} />
      <View style={[styles.axisV, { height: innerRadius * 2 }]} />
      {eventDots.map((entry, index) => (
        <View
          key={`event-${index}`}
          style={[
            styles.eventDot,
            { left: center + entry.x * innerRadius - 5, top: center + entry.y * innerRadius - 5 },
          ]}
        />
      ))}
      {visible.map((entry) => {
        const meta = severityMeta[normalizeSeverity(entry.hazard.severity)];
        return (
          <View
            key={`${entry.hazard.id}-${entry.distance}`}
            style={[
              styles.dot,
              {
                left: center + entry.x * innerRadius - 7,
                top: center + entry.y * innerRadius - 7,
                backgroundColor: meta.color,
              },
            ]}
          />
        );
      })}
      <View style={[styles.userHalo, { left: center - 14, top: center - 14 }]} />
      <View style={[styles.userDot, { left: center - 6, top: center - 6 }]} />
      {showLabels ? (
        <>
          <Text style={styles.north}>B</Text>
          <Text style={styles.radiusLabel}>{Math.round(radiusMeters / 1000)} km</Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: '#FFF1EA',
    borderWidth: 1,
    borderColor: '#F1D9CC',
  },
  ring: { position: 'absolute', borderWidth: 1, borderColor: 'rgba(194, 65, 45, 0.16)' },
  axisH: { position: 'absolute', height: 1, backgroundColor: '#F1E1D8' },
  axisV: { position: 'absolute', width: 1, backgroundColor: '#F1E1D8' },
  dot: { position: 'absolute', width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: '#FFFFFF' },
  eventDot: {
    position: 'absolute',
    width: 10,
    height: 10,
    transform: [{ rotate: '45deg' }],
    backgroundColor: colors.orange,
    borderWidth: 1,
    borderColor: '#FFFFFF',
  },
  userHalo: { position: 'absolute', width: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(14,116,144,0.14)' },
  userDot: { position: 'absolute', width: 12, height: 12, borderRadius: 6, backgroundColor: '#0E7490', borderWidth: 2, borderColor: '#FFFFFF' },
  north: { position: 'absolute', top: 4, color: colors.textDim, fontSize: 10, fontWeight: '700' },
  radiusLabel: { position: 'absolute', bottom: 6, right: 12, color: colors.textDim, fontSize: 9, fontWeight: '600' },
});
