// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { PublicEmergencyEvent } from '../api/types';
import type { AppRoute } from '../lib/deepLink';
import {
  colors,
  eventStatusLabel,
  hazardTypeLabel,
  normalizeSeverity,
  severityMeta,
  timeAgo,
} from '../lib/format';
import { firstPoint } from '../lib/geo';
import { Card, Chip, EmptyState, PrimaryButton, Screen, SectionHeader } from '../components/ui';
import { PageHeader } from '../components/PageHeader';

export function EventDetailScreen({
  event,
  navigate,
  onBack,
}: {
  event?: PublicEmergencyEvent;
  navigate: (route: AppRoute) => void;
  onBack: () => void;
}) {
  if (!event) {
    return (
      <Screen>
        <PageHeader title="Không tìm thấy sự kiện" onBack={onBack} />
        <EmptyState
          icon="alert-circle-outline"
          title="Sự kiện không còn công khai"
          body="Sự kiện có thể đã kết thúc hoặc chưa tải xong. Quay lại danh sách và làm mới."
        />
        <PrimaryButton label="Về ứng phó khẩn cấp" icon="arrow-back" onPress={() => navigate({ name: 'emergency' })} />
      </Screen>
    );
  }
  const meta = severityMeta[normalizeSeverity(event.severity)];
  const coords = firstPoint(event.geometry);
  return (
    <Screen>
      <PageHeader
        eyebrow={`SỰ KIỆN · ${hazardTypeLabel(event.event_type).toUpperCase()}`}
        title={event.title}
        subtitle={`${eventStatusLabel(event.status)} · ${timeAgo(event.created_at)}`}
        onBack={onBack}
      />
      <Card tone={event.severity === 'critical' ? 'danger' : 'default'} style={styles.hero}>
        <View style={styles.row}>
          <View style={[styles.icon, { backgroundColor: meta.bg }]}>
            <Ionicons name="alert" size={26} color={meta.color} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Mức độ sự kiện</Text>
            <Text style={[styles.value, { color: meta.color }]}>{meta.label}</Text>
          </View>
          <Chip label={eventStatusLabel(event.status)} />
        </View>
        <View style={styles.divider} />
        <Text style={styles.address}>
          {[event.location?.address, event.location?.ward, event.location?.district, event.location?.city]
            .filter(Boolean)
            .join(', ') || 'Chưa có địa chỉ công khai'}
        </Text>
        <Text style={styles.meta}>
          Bắt đầu: {event.started_at ? new Date(event.started_at).toLocaleString('vi-VN') : 'Chưa rõ'}
        </Text>
      </Card>

      <SectionHeader title="Hướng dẫn chung" icon="shield" />
      <Card>
        <Text style={styles.guidance}>
          Theo dõi hướng dẫn của Ban chỉ huy phòng chống thiên tai và tìm kiếm cứu nạn địa phương.
          Không tự ý quay lại khu vực nguy hiểm khi chưa được thông báo an toàn. Gọi 112 nếu tính
          mạng bị đe dọa.
        </Text>
      </Card>

      <View style={styles.actions}>
        <View style={{ flex: 1 }}>
          <PrimaryButton label="Gọi 112" icon="call" tone="danger" onPress={() => Linking.openURL('tel:112')} />
        </View>
        <View style={{ flex: 1 }}>
          <PrimaryButton label="Bản đồ" icon="map" tone="ghost" onPress={() => navigate({ name: 'map' })} />
        </View>
      </View>
      {coords ? (
        <PrimaryButton
          label="Chỉ đường tới khu vực"
          icon="navigate"
          tone="ghost"
          onPress={() =>
            Linking.openURL(
              `https://www.google.com/maps/dir/?api=1&destination=${coords.latitude},${coords.longitude}`,
            )
          }
        />
      ) : null}
      <Text style={styles.note}>
        Dữ liệu sự kiện là bản công khai, đã loại bỏ thông tin liên hệ và chi tiết chỉ huy.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 50, height: 50, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  label: { color: colors.textDim, fontSize: 9, fontWeight: '700' },
  value: { fontSize: 18, fontWeight: '800' },
  divider: { height: 1, backgroundColor: colors.border },
  address: { color: colors.text, fontSize: 12, lineHeight: 18 },
  meta: { color: colors.textMuted, fontSize: 9 },
  guidance: { color: colors.text, fontSize: 11, lineHeight: 18 },
  actions: { flexDirection: 'row', gap: 10 },
  note: { color: colors.textDim, fontSize: 9, textAlign: 'center', lineHeight: 14 },
});
