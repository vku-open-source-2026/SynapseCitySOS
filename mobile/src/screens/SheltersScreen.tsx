// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { MapConfig, NearbyShelter } from '../api/types';
import { colors } from '../lib/format';
import { formatDistance, firstPoint } from '../lib/geo';
import type { AppLocation } from '../hooks/useLocation';
import { Card, Chip, EmptyState, ErrorNotice, PrimaryButton, Screen, SectionHeader } from '../components/ui';
import { PageHeader } from '../components/PageHeader';
import { SosMap } from '../components/SosMap';

interface SheltersScreenProps {
  location: AppLocation;
  shelters: NearbyShelter[];
  loading: boolean;
  error?: string | null;
  mapConfig?: MapConfig | null;
  onRetry: () => void;
}

export function SheltersScreen({
  location,
  shelters,
  loading,
  error,
  mapConfig,
  onRetry,
}: SheltersScreenProps) {
  return (
    <Screen>
      <PageHeader
        eyebrow="NƠI TRÚ ẨN"
        title="Trú ẩn gần bạn"
        subtitle={`${shelters.length} nơi trú ẩn trong bán kính 50 km`}
      />

      <SosMap
        hazards={[]}
        events={[]}
        shelters={shelters}
        location={location}
        mapConfig={mapConfig}
        showHazards={false}
        showEvents={false}
        showShelters
        focusDataOnly={shelters.length === 0 || location.latitude < 8 || location.latitude > 24 || location.longitude < 102 || location.longitude > 110.5}
        height={300}
        onSelectHazard={() => undefined}
        onSelectEvent={() => undefined}
      />

      <SectionHeader title={`Danh sách (${shelters.length})`} icon="list" />
      {error ? <ErrorNotice message={error} onRetry={onRetry} /> : null}
      {loading ? <Text style={styles.muted}>Đang tìm nơi trú ẩn từ production…</Text> : null}
      {shelters.map((shelter) => (
        <ShelterCard key={shelter.id} shelter={shelter} />
      ))}
      {!loading && shelters.length === 0 ? (
        <EmptyState
          icon="home-outline"
          title="Không có nơi trú ẩn trong 50 km"
          body="Hệ thống chưa có bản ghi nơi trú ẩn công khai gần vị trí này. Hãy gọi 112/114 hoặc theo dõi hướng dẫn của chính quyền địa phương."
        />
      ) : null}

      <Card tone="danger">
        <Text style={styles.warnTitle}>Khi có nguy hiểm tức thời</Text>
        <Text style={styles.warnBody}>
          Gọi 112 (cứu hộ khẩn cấp), 114 (cứu hoả) hoặc 115 (cấp cứu). Di chuyển đến nơi cao ráo,
          an toàn nếu có ngập lụt; không đi qua dòng nước chảy xiết.
        </Text>
        <PrimaryButton label="Gọi 112" icon="call" tone="danger" onPress={() => Linking.openURL('tel:112')} />
      </Card>
    </Screen>
  );
}

function ShelterCard({ shelter }: { shelter: NearbyShelter }) {
  const coordinates = firstPoint(shelter.current_location);
  return (
    <Card>
      <View style={styles.row}>
        <View style={styles.icon}>
          <Ionicons name="home" size={20} color={colors.green} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.name}>{shelter.name}</Text>
          <Text style={styles.meta}>
            {[shelter.ward, shelter.district].filter(Boolean).join(', ') || 'Chưa có địa chỉ'} · {formatDistance(shelter.distance_m)}
          </Text>
          <Text style={styles.meta}>
            {shelter.capacity ? `Sức chứa ${shelter.capacity} ${shelter.capacity_unit || 'người'}` : 'Chưa có thông tin sức chứa'}
          </Text>
        </View>
        <Chip label={shelter.status || 'available'} color={colors.green} />
      </View>
      <View style={styles.actions}>
        {shelter.contact_phone ? (
          <Pressable onPress={() => Linking.openURL(`tel:${shelter.contact_phone}`)} style={styles.action}>
            <Ionicons name="call" size={15} color={colors.cyan} />
            <Text style={styles.actionText}>Gọi</Text>
          </Pressable>
        ) : null}
        {coordinates ? (
          <Pressable
            onPress={() =>
              Linking.openURL(
                `https://www.google.com/maps/dir/?api=1&destination=${coordinates.latitude},${coordinates.longitude}`,
              )
            }
            style={styles.action}
          >
            <Ionicons name="navigate" size={15} color={colors.cyan} />
            <Text style={styles.actionText}>Chỉ đường</Text>
          </Pressable>
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 13,
    backgroundColor: '#ECFDF5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { color: colors.text, fontSize: 13, fontWeight: '800' },
  meta: { color: colors.textMuted, fontSize: 9, lineHeight: 14 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: '#FFF1F2',
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  actionText: { color: colors.cyan, fontSize: 10, fontWeight: '700' },
  muted: { color: colors.textMuted, fontSize: 11 },
  warnTitle: { color: colors.text, fontSize: 13, fontWeight: '800' },
  warnBody: { color: colors.textMuted, fontSize: 10, lineHeight: 16 },
});
