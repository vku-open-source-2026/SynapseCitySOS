// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Hazard, MapConfig, NearbyShelter, PublicEmergencyEvent } from '../api/types';
import type { AppRoute } from '../lib/deepLink';
import {
  colors,
  hazardTypeLabel,
  normalizeSeverity,
  severityMeta,
} from '../lib/format';
import { formatDistance } from '../lib/geo';
import { distanceMeters, firstPoint } from '../lib/geo';
import type { AppLocation } from '../hooks/useLocation';
import type { NearbyHazard } from '../hooks/useSosData';
import { Card, Chip, Screen, SectionHeader } from '../components/ui';
import { PageHeader } from '../components/PageHeader';
import { SosMap } from '../components/SosMap';

interface MapScreenProps {
  location: AppLocation;
  hazards: Hazard[];
  events: PublicEmergencyEvent[];
  shelters: NearbyShelter[];
  nearby: NearbyHazard[];
  mapConfig?: MapConfig | null;
  navigate: (route: AppRoute) => void;
}

export function MapScreen({
  location,
  hazards,
  events,
  shelters,
  nearby,
  mapConfig,
  navigate,
}: MapScreenProps) {
  const [showHazards, setShowHazards] = useState(true);
  const [showEvents, setShowEvents] = useState(true);
  const [showShelters, setShowShelters] = useState(false);

  const activeHazards = useMemo(
    () => hazards.filter((hazard) => hazard.is_active !== false && hazard.status !== 'expired'),
    [hazards],
  );
  const outsideCountry =
    location.latitude < 8 ||
    location.latitude > 24 ||
    location.longitude < 102 ||
    location.longitude > 110.5;
  const mapHazards = useMemo(
    () =>
      activeHazards.filter((hazard) => {
        const coordinates = firstPoint(hazard.geometry);
        if (!coordinates) return false;
        return (
          coordinates.latitude >= 8 &&
          coordinates.latitude <= 24 &&
          coordinates.longitude >= 102 &&
          coordinates.longitude <= 110.5
        );
      }),
    [activeHazards],
  );
  const mapEvents = useMemo(
    () =>
      events.filter((event) => {
        const coordinates = firstPoint(event.geometry ?? null);
        if (!coordinates) return false;
        if (outsideCountry) {
          return (
            coordinates.latitude >= 8 &&
            coordinates.latitude <= 24 &&
            coordinates.longitude >= 102 &&
            coordinates.longitude <= 110.5
          );
        }
        return (
          distanceMeters(
            { latitude: location.latitude, longitude: location.longitude },
            coordinates,
          ) <= 100_000
        );
      }),
    [events, location.latitude, location.longitude, outsideCountry],
  );

  return (
    <Screen>
      <PageHeader
        eyebrow="BẢN ĐỒ"
        title="Cảnh báo & ứng phó"
        subtitle={`${activeHazards.length} cảnh báo · ${events.length} sự kiện · ${shelters.length} nơi trú ẩn`}
      />
      <View style={styles.filters}>
        <Chip
          label="Thiên tai"
          icon="warning"
          active={showHazards}
          onPress={() => setShowHazards((value) => !value)}
        />
        <Chip
          label="Sự kiện"
          icon="alert-circle"
          active={showEvents}
          onPress={() => setShowEvents((value) => !value)}
        />
        <Chip
          label="Trú ẩn"
          icon="home"
          active={showShelters}
          onPress={() => setShowShelters((value) => !value)}
        />
      </View>

      {outsideCountry ? (
        <Card tone="cyan">
          <Text style={styles.coverageText}>
            Vị trí của bạn ngoài vùng dữ liệu Việt Nam. Bản đồ đang hiển thị cảnh báo toàn quốc;
            danh sách “gần bạn” sẽ trống cho tới khi bạn ở trong vùng dữ liệu.
          </Text>
        </Card>
      ) : null}

      <SosMap
        hazards={mapHazards}
        events={mapEvents}
        shelters={shelters}
        location={location}
        mapConfig={mapConfig}
        showHazards={showHazards}
        showEvents={showEvents}
        showShelters={showShelters}
        focusDataOnly={outsideCountry}
        height={460}
        onSelectHazard={(id) => navigate({ name: 'hazard', params: { id } })}
        onSelectEvent={(id) => navigate({ name: 'event', params: { id } })}
      />

      <View style={styles.hintRow}>
        <Ionicons name="information-circle-outline" size={14} color={colors.textDim} />
        <Text style={styles.hint}>
          Chạm vào vùng cảnh báo hoặc sự kiện để xem chi tiết. Bản đồ không thay thế cảnh báo chính thức.
        </Text>
      </View>

      <SectionHeader title={`Cảnh báo gần bạn (${nearby.length})`} icon="navigate" />
      {nearby.slice(0, 6).map((entry) => {
        const meta = severityMeta[normalizeSeverity(entry.hazard.severity)];
        return (
          <Pressable
            key={entry.hazard.id}
            onPress={() => navigate({ name: 'hazard', params: { id: entry.hazard.id } })}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.82 }]}
          >
            <View style={[styles.bar, { backgroundColor: meta.color }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={2}>{entry.hazard.title}</Text>
              <Text style={styles.rowSub}>
                {hazardTypeLabel(entry.hazard.event_type)} · {formatDistance(entry.distance)}
              </Text>
            </View>
            <Chip label={meta.label} color={meta.color} bg={meta.bg} />
          </Pressable>
        );
      })}
      {nearby.length === 0 ? (
        <Card><Text style={styles.empty}>Không có cảnh báo trong 100 km từ dữ liệu công khai.</Text></Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', gap: 7, flexWrap: 'wrap' },
  hintRow: { flexDirection: 'row', gap: 5, alignItems: 'flex-start', paddingHorizontal: 2 },
  hint: { color: colors.textDim, fontSize: 9, flex: 1, lineHeight: 13 },
  coverageText: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 11,
  },
  bar: { width: 3, height: 36, borderRadius: 2 },
  rowTitle: { color: colors.text, fontSize: 12, fontWeight: '700', lineHeight: 16 },
  rowSub: { color: colors.textDim, fontSize: 9, marginTop: 2 },
  empty: { color: colors.textMuted, fontSize: 11 },
});
