// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Linking, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Hazard, PublicEmergencyEvent } from '../api/types';
import type { AppRoute } from '../lib/deepLink';
import {
  colors,
  eventStatusLabel,
  hazardTypeLabel,
  normalizeSeverity,
  severityMeta,
  timeAgo,
} from '../lib/format';
import { emergencyNumbers } from '../lib/widget';
import { formatDistance } from '../lib/geo';
import type { AppLocation } from '../hooks/useLocation';
import type { NearbyHazard } from '../hooks/useSosData';
import { Card, Chip, EmptyState, PrimaryButton, Screen, SectionHeader } from '../components/ui';
import { PageHeader } from '../components/PageHeader';

interface EmergencyScreenProps {
  location: AppLocation;
  events: PublicEmergencyEvent[];
  nearby: NearbyHazard[];
  navigate: (route: AppRoute) => void;
  onBack: () => void;
}

const guidance = [
  {
    icon: 'water' as const,
    title: 'Ngập lụt',
    body: 'Di chuyển lên nơi cao ráo; không đi qua nước chảy xiết; ngắt điện nếu an toàn; theo dõi hướng dẫn của chính quyền.',
  },
  {
    icon: 'thunderstorm' as const,
    title: 'Bão / gió mạnh',
    body: 'Ở trong nhà, tránh xa cửa sổ; gia cố vật dụng; không ra biển; chuẩn bị nước uống, đèn pin và giấy tờ.',
  },
  {
    icon: 'trail-sign' as const,
    title: 'Sạt lở',
    body: 'Rời khu vực sườn dốc; không quay lại cho đến khi cơ quan chức năng xác nhận an toàn; chú ý tiếng động bất thường.',
  },
  {
    icon: 'flame' as const,
    title: 'Cháy / nổ',
    body: 'Gọi 114; thoát hiểm bằng lối thoát gần nhất; cúi thấp nếu có khói; không quay lại lấy tài sản.',
  },
];

export function EmergencyScreen({ location, events, nearby, navigate, onBack }: EmergencyScreenProps) {
  const shareLocation = () => {
    Share.share({
      message:
        `Vị trí của tôi: ${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}\n` +
        `https://www.google.com/maps?q=${location.latitude},${location.longitude}\n` +
        'Nhờ hỗ trợ khẩn cấp nếu cần.',
      title: 'Chia sẻ vị trí khẩn cấp',
    }).catch(() => undefined);
  };

  return (
    <Screen>
      <PageHeader
        eyebrow="SOS"
        title="Ứng phó khẩn cấp"
        subtitle="Gọi đúng số, chia sẻ vị trí và xem hướng dẫn theo loại thiên tai."
        onBack={onBack}
      />

      <Card tone="danger" style={styles.hero}>
        <Text style={styles.heroTitle}>Nếu tính mạng đang bị đe dọa</Text>
        <Text style={styles.heroBody}>
          Gọi ngay số khẩn cấp. Ứng dụng không gửi yêu cầu cứu hộ tới cơ quan chức năng.
        </Text>
        <View style={styles.callGrid}>
          {emergencyNumbers.map((item) => (
            <Pressable
              key={item.number}
              onPress={() => Linking.openURL(`tel:${item.number}`)}
              style={({ pressed }) => [styles.call, pressed && { opacity: 0.82 }]}
            >
              <Text style={styles.callNumber}>{item.number}</Text>
              <Text style={styles.callLabel}>{item.label}</Text>
              <Text style={styles.callDetail}>{item.detail}</Text>
            </Pressable>
          ))}
        </View>
        <PrimaryButton label="Chia sẻ vị trí của tôi" icon="share-social" tone="ghost" onPress={shareLocation} />
        <Text style={styles.coords}>
          {location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}
          {location.isFallback ? ' · vị trí mặc định Đà Nẵng' : ''}
        </Text>
      </Card>

      <SectionHeader title={`Sự kiện công khai (${events.length})`} icon="alert-circle" />
      {events.map((event) => {
        const meta = severityMeta[normalizeSeverity(event.severity)];
        return (
          <Pressable
            key={event.id}
            onPress={() => navigate({ name: 'event', params: { id: event.id } })}
            style={({ pressed }) => [styles.event, pressed && { opacity: 0.82 }]}
          >
            <View style={[styles.eventIcon, { backgroundColor: meta.bg }]}>
              <Ionicons name="alert" size={18} color={meta.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.eventTitle} numberOfLines={2}>{event.title}</Text>
              <Text style={styles.eventMeta}>
                {hazardTypeLabel(event.event_type)} · {eventStatusLabel(event.status)} · {timeAgo(event.created_at)}
              </Text>
            </View>
            <Chip label={meta.label} color={meta.color} bg={meta.bg} />
          </Pressable>
        );
      })}
      {events.length === 0 ? (
        <EmptyState
          icon="shield-checkmark-outline"
          title="Không có sự kiện khẩn cấp công khai"
          body="Đây không phải trạng thái 'an toàn'. Luôn theo dõi cảnh báo chính thức và gọi 112 khi cần."
        />
      ) : null}

      <SectionHeader title="Hướng dẫn theo loại thiên tai" icon="book" />
      {guidance.map((item) => (
        <Card key={item.title} style={styles.guide}>
          <View style={styles.guideIcon}>
            <Ionicons name={item.icon} size={20} color={colors.red} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.guideTitle}>{item.title}</Text>
            <Text style={styles.guideBody}>{item.body}</Text>
          </View>
        </Card>
      ))}

      <SectionHeader title="Cảnh báo gần bạn" icon="warning" />
      {nearby.slice(0, 3).map((entry) => (
        <Pressable
          key={entry.hazard.id}
          onPress={() => navigate({ name: 'hazard', params: { id: entry.hazard.id } })}
          style={styles.hazardRow}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.hazardTitle} numberOfLines={1}>{entry.hazard.title}</Text>
            <Text style={styles.hazardMeta}>
              {severityMeta[normalizeSeverity(entry.hazard.severity)].label} · {formatDistance(entry.distance)}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
        </Pressable>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { gap: 10, paddingVertical: 18 },
  heroTitle: { color: colors.text, fontSize: 18, fontWeight: '800' },
  heroBody: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },
  callGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  call: {
    width: '48%',
    backgroundColor: '#FFFFFF',
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '#FECDD3',
    padding: 10,
    gap: 1,
  },
  callNumber: { color: colors.red, fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  callLabel: { color: colors.text, fontSize: 10, fontWeight: '700' },
  callDetail: { color: colors.textDim, fontSize: 8 },
  coords: { color: colors.textDim, fontSize: 8, textAlign: 'center' },
  event: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.card,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 11,
  },
  eventIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  eventTitle: { color: colors.text, fontSize: 12, fontWeight: '700', lineHeight: 16 },
  eventMeta: { color: colors.textDim, fontSize: 9, marginTop: 2 },
  guide: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  guideIcon: {
    width: 40,
    height: 40,
    borderRadius: 13,
    backgroundColor: '#FFF1F2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  guideTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  guideBody: { color: colors.textMuted, fontSize: 10, lineHeight: 16, marginTop: 2 },
  hazardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.card,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
  },
  hazardTitle: { color: colors.text, fontSize: 11, fontWeight: '700' },
  hazardMeta: { color: colors.textDim, fontSize: 9, marginTop: 2 },
});
