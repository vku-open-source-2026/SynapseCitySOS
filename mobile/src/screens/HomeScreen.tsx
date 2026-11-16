// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import type { FeedStatus, Hazard, PublicEmergencyEvent } from '../api/types';
import type { AppRoute, AppRouteName } from '../lib/deepLink';
import {
  colors,
  eventStatusLabel,
  feedStatusLabel,
  hazardTypeLabel,
  normalizeSeverity,
  severityMeta,
  timeAgo,
} from '../lib/format';
import { feedHealth } from '../lib/feed';
import { formatDistance } from '../lib/geo';
import type { AppLocation } from '../hooks/useLocation';
import type { NearbyHazard } from '../hooks/useSosData';
import { Card, Chip, ErrorNotice, Screen, SectionHeader, StatusDot } from '../components/ui';
import { PageHeader } from '../components/PageHeader';
import { HazardRadar } from '../components/HazardRadar';

interface HomeScreenProps {
  location: AppLocation;
  hazards: Hazard[];
  events: PublicEmergencyEvent[];
  nearby: NearbyHazard[];
  feed?: FeedStatus;
  online: boolean;
  streamState: string;
  refreshing: boolean;
  onRefresh: () => void;
  navigate: (route: AppRoute) => void;
  onTab: (route: AppRouteName) => void;
}

export function HomeScreen({
  location,
  hazards,
  events,
  nearby,
  feed,
  online,
  streamState,
  refreshing,
  onRefresh,
  navigate,
  onTab,
}: HomeScreenProps) {
  const health = feedHealth(feed);
  const nearest = nearby[0];
  const nearestMeta = nearest ? severityMeta[normalizeSeverity(nearest.hazard.severity)] : null;
  const topEvents = [...events]
    .sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''))
    .slice(0, 3);
  const unknown = health.state !== 'ok';

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.red} />}>
      <PageHeader
        eyebrow="SYNAPSE SOS"
        title="Tình hình khẩn cấp"
        subtitle={
          location.isFallback
            ? 'Chưa có vị trí GPS · dùng trung tâm Đà Nẵng'
            : `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`
        }
        right={<StatusDot online={online && health.state !== 'unknown'} label={online ? 'TRỰC TUYẾN' : 'MẤT KẾT NỐI'} />}
      />

      <LinearGradient
        colors={unknown ? ['#FFF7ED', '#FFE8D6', '#FFFFFF'] : ['#FFF1F2', '#FFE4E6', '#FFFFFF']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <View style={styles.heroText}>
          <Text style={styles.heroKicker}>CẢNH BÁO TRONG 100 KM</Text>
          <Text style={styles.heroCount}>{nearby.length}</Text>
          <Text style={styles.heroLabel}>nguồn tin thiên tai đang hoạt động</Text>
          {nearest ? (
            <Pressable
              style={styles.nearest}
              onPress={() => navigate({ name: 'hazard', params: { id: nearest.hazard.id } })}
            >
              <View style={[styles.nearestDot, { backgroundColor: nearestMeta?.color }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.nearestName} numberOfLines={2}>{nearest.hazard.title}</Text>
                <Text style={styles.nearestMeta}>
                  {nearestMeta?.label} · {formatDistance(nearest.distance)}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
            </Pressable>
          ) : (
            <Text style={styles.heroEmpty}>
              Không có cảnh báo trong bán kính 100 km — không có nghĩa là an toàn.
            </Text>
          )}
        </View>
        <View style={styles.radarWrap}>
          <HazardRadar
            location={location}
            hazards={hazards}
            events={events}
            size={132}
            radiusMeters={100_000}
            showLabels={false}
          />
        </View>
      </LinearGradient>

      <View style={[styles.feedBanner, unknown && styles.feedBannerWarn]}>
        <Ionicons
          name={unknown ? 'warning' : 'checkmark-circle'}
          size={18}
          color={unknown ? colors.amber : colors.green}
        />
        <View style={{ flex: 1 }}>
          <Text style={[styles.feedTitle, { color: unknown ? colors.amber : colors.green }]}>
            {health.label}
          </Text>
          <Text style={styles.feedBody}>
            {health.state === 'ok'
              ? `${feedStatusLabel(feed?.hazard_feed?.status)} · cập nhật ${timeAgo(feed?.hazard_feed?.last_success_at || feed?.checked_at)}`
              : 'API SOS đang suy giảm — dữ liệu có thể chưa đầy đủ.'}
          </Text>
        </View>
        <Chip label={streamState === 'live' ? 'SSE' : streamState === 'degraded' ? 'DỰ PHÒNG' : 'POLL'} />
      </View>

      <View style={styles.quickGrid}>
        <QuickAction icon="call" label="Gọi 112" tone="danger" onPress={() => Linking.openURL('tel:112')} />
        <QuickAction icon="map" label="Bản đồ" onPress={() => onTab('map')} />
        <QuickAction icon="home" label="Nơi trú ẩn" onPress={() => onTab('shelters')} />
        <QuickAction icon="warning" label="Cảnh báo" onPress={() => onTab('alerts')} />
      </View>

      <Pressable onPress={() => navigate({ name: 'emergency' })}>
        <Card tone="danger" style={styles.sosCard}>
          <View style={styles.sosIcon}>
            <Ionicons name="call" size={22} color="#FFF1F2" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.sosTitle}>SOS · Hướng dẫn ứng phó</Text>
            <Text style={styles.sosBody}>Gọi khẩn cấp, chia sẻ vị trí và xem hướng dẫn theo loại thiên tai.</Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </Card>
      </Pressable>

      <SectionHeader
        title={`Sự kiện khẩn cấp (${events.length})`}
        action="Chi tiết"
        onAction={() => navigate({ name: 'emergency' })}
        icon="alert-circle"
      />
      {topEvents.map((event) => (
        <EventRow
          key={event.id}
          event={event}
          onPress={() => navigate({ name: 'event', params: { id: event.id } })}
        />
      ))}
      {events.length === 0 ? (
        <Card>
          <Text style={styles.muted}>
            Không có sự kiện khẩn cấp công khai đang hoạt động. Trạng thái này không thay thế cảnh báo
            chính thức từ cơ quan chức năng.
          </Text>
        </Card>
      ) : null}

      <SectionHeader
        title="Cảnh báo gần nhất"
        action="Tất cả"
        onAction={() => onTab('alerts')}
        icon="warning"
      />
      {nearby.slice(0, 4).map((entry) => (
        <HazardRow
          key={entry.hazard.id}
          hazard={entry.hazard}
          distance={entry.distance}
          onPress={() => navigate({ name: 'hazard', params: { id: entry.hazard.id } })}
        />
      ))}
      {nearby.length === 0 ? (
        <Card><Text style={styles.muted}>Chưa có cảnh báo trong 100 km từ nguồn công khai.</Text></Card>
      ) : null}

      {unknown || !online ? (
        <ErrorNotice
          message="Nguồn tin cảnh báo chưa được xác nhận. Không hiển thị trạng thái an toàn khi thiếu dữ liệu."
          onRetry={onRefresh}
        />
      ) : null}

      <View style={styles.footer}>
        <Text style={styles.footerText}>SynapseSOS · API production sos.synapsecity.sbs</Text>
        <Pressable onPress={() => Linking.openURL('https://synapsecity.sbs')} style={styles.link}>
          <Text style={styles.linkText}>Mở SynapseCity</Text>
          <Ionicons name="open-outline" size={12} color={colors.cyan} />
        </Pressable>
      </View>
    </Screen>
  );
}

function QuickAction({
  icon,
  label,
  onPress,
  tone,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  tone?: 'danger';
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.quick, tone === 'danger' && styles.quickDanger, pressed && { opacity: 0.8 }]}
    >
      <View style={[styles.quickIcon, tone === 'danger' && { backgroundColor: '#FFE4E6' }]}>
        <Ionicons name={icon} size={20} color={tone === 'danger' ? colors.red : colors.text} />
      </View>
      <Text style={styles.quickLabel} numberOfLines={2}>{label}</Text>
    </Pressable>
  );
}

function EventRow({ event, onPress }: { event: PublicEmergencyEvent; onPress: () => void }) {
  const meta = severityMeta[normalizeSeverity(event.severity)];
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { opacity: 0.82 }]}>
      <View style={[styles.rowIcon, { backgroundColor: meta.bg }]}>
        <Ionicons name="alert" size={18} color={meta.color} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.rowTitle} numberOfLines={2}>{event.title}</Text>
        <Text style={styles.rowSub}>
          {hazardTypeLabel(event.event_type)} · {eventStatusLabel(event.status)} · {timeAgo(event.created_at)}
        </Text>
      </View>
      <Chip label={meta.label} color={meta.color} bg={meta.bg} />
    </Pressable>
  );
}

function HazardRow({ hazard, distance, onPress }: { hazard: Hazard; distance: number; onPress: () => void }) {
  const meta = severityMeta[normalizeSeverity(hazard.severity)];
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { opacity: 0.82 }]}>
      <View style={[styles.rowIcon, { backgroundColor: meta.bg }]}>
        <Ionicons name="warning" size={18} color={meta.color} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.rowTitle} numberOfLines={2}>{hazard.title}</Text>
        <Text style={styles.rowSub}>
          {hazardTypeLabel(hazard.event_type)} · {formatDistance(distance)} · {timeAgo(hazard.published_at || hazard.created_at)}
        </Text>
      </View>
      <Chip label={meta.label} color={meta.color} bg={meta.bg} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: {
    borderRadius: 24,
    padding: 18,
    flexDirection: 'row',
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(194,65,45,0.18)',
    overflow: 'hidden',
    shadowColor: '#3F1D1A',
    shadowOpacity: 0.06,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 7 },
    elevation: 3,
  },
  heroText: { flex: 1, gap: 2 },
  heroKicker: { color: colors.red, fontSize: 9, fontWeight: '800', letterSpacing: 1.2 },
  heroCount: { color: colors.text, fontSize: 46, fontWeight: '800', lineHeight: 52, letterSpacing: -2 },
  heroLabel: { color: colors.textMuted, fontSize: 11, marginBottom: 10 },
  heroEmpty: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  radarWrap: { alignItems: 'center', justifyContent: 'center', marginRight: -8 },
  nearest: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.88)',
    borderRadius: 12,
    padding: 9,
    borderWidth: 1,
    borderColor: '#F1D9CC',
  },
  nearestDot: { width: 8, height: 8, borderRadius: 4 },
  nearestName: { color: colors.text, fontSize: 11, fontWeight: '700', lineHeight: 15 },
  nearestMeta: { color: colors.textMuted, fontSize: 9, marginTop: 1 },
  feedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#ECFDF5',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#A7F3D0',
    padding: 11,
  },
  feedBannerWarn: { backgroundColor: '#FFFBEB', borderColor: '#FDE68A' },
  feedTitle: { fontSize: 11, fontWeight: '800' },
  feedBody: { color: colors.textMuted, fontSize: 9, marginTop: 2, lineHeight: 13 },
  quickGrid: { flexDirection: 'row', gap: 8 },
  quick: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: 6,
    alignItems: 'center',
    gap: 7,
    minHeight: 86,
  },
  quickDanger: { borderColor: '#FECDD3', backgroundColor: '#FFF1F2' },
  quickIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: '#FFF1EA',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickLabel: { color: colors.text, fontSize: 10, fontWeight: '700', textAlign: 'center' },
  sosCard: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sosIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: colors.redDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sosTitle: { color: colors.text, fontSize: 13, fontWeight: '800' },
  sosBody: { color: colors.textMuted, fontSize: 10, lineHeight: 15, marginTop: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.card,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 11,
  },
  rowIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { color: colors.text, fontSize: 12, fontWeight: '700', lineHeight: 16 },
  rowSub: { color: colors.textDim, fontSize: 9, lineHeight: 13 },
  muted: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },
  footer: { alignItems: 'center', gap: 6, paddingVertical: 8 },
  footerText: { color: colors.textDim, fontSize: 9 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  linkText: { color: colors.cyan, fontSize: 10, fontWeight: '700' },
});

