// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Linking, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Hazard } from '../api/types';
import type { AppRoute } from '../lib/deepLink';
import {
  colors,
  formatDateTime,
  hazardTypeLabel,
  normalizeSeverity,
  severityMeta,
  timeAgo,
} from '../lib/format';
import { distanceMeters, firstPoint, formatDistance } from '../lib/geo';
import type { AppLocation } from '../hooks/useLocation';
import { Card, Chip, EmptyState, PrimaryButton, Screen, SectionHeader } from '../components/ui';
import { PageHeader } from '../components/PageHeader';

interface HazardDetailScreenProps {
  hazard?: Hazard;
  location: AppLocation;
  navigate: (route: AppRoute) => void;
  onBack: () => void;
}

const guidance: Record<string, string> = {
  flood: 'Di chuyển lên nơi cao ráo, không đi qua nước chảy xiết, ngắt điện nếu an toàn và theo dõi hướng dẫn của chính quyền.',
  storm: 'Ở trong nhà, tránh cửa sổ, gia cố vật dụng, không ra biển và chuẩn bị nước uống, đèn pin, giấy tờ.',
  landslide: 'Rời khu vực sườn dốc, không quay lại khi chưa được xác nhận an toàn, chú ý tiếng động bất thường.',
  fire: 'Gọi 114, thoát hiểm bằng lối gần nhất, cúi thấp nếu có khói và không quay lại lấy tài sản.',
  rain: 'Theo dõi lượng mưa và ngập cục bộ; tránh đường ngập, nước chảy xiết; chuẩn bị sơ tán nếu nước dâng nhanh.',
  thunderstorm: 'Ở trong nhà, tránh cây cao và vật kim loại; ngắt thiết bị điện không cần thiết; không ra biển.',
  hail: 'Ở trong nhà, tránh cửa kính; bảo vệ xe cộ và vật nuôi; không ra ngoài khi mưa đá đang diễn ra.',
  tornado: 'Vào nơi trú ẩn kiên cố, tránh cửa sổ; nếu ở ngoài, nằm xuống đất trũng và che đầu.',
  cold: 'Giữ ấm, hạn chế ra ngoài, chú ý người già và trẻ nhỏ; theo dõi cảnh báo rét hại của địa phương.',
  heat: 'Uống đủ nước, tránh nắng gắt buổi trưa, không để trẻ em hoặc vật nuôi trong xe kín.',
  earthquake: 'Chui xuống bàn chắc chắn, tránh cửa kính, sau khi rung chấn dừng hãy di chuyển ra ngoài và đề phòng dư chấn.',
  other: 'Theo dõi cảnh báo chính thức, chuẩn bị vật dụng thiết yếu và gọi 112 nếu tính mạng bị đe dọa.',
};

export function HazardDetailScreen({ hazard, location, navigate, onBack }: HazardDetailScreenProps) {
  if (!hazard) {
    return (
      <Screen>
        <PageHeader title="Không tìm thấy cảnh báo" onBack={onBack} />
        <EmptyState
          icon="warning-outline"
          title="Cảnh báo không còn trong danh sách"
          body="Cảnh báo có thể đã hết hiệu lực hoặc dữ liệu chưa tải xong. Quay lại danh sách và làm mới."
        />
        <PrimaryButton label="Về danh sách cảnh báo" icon="arrow-back" onPress={() => navigate({ name: 'alerts' })} />
      </Screen>
    );
  }

  const meta = severityMeta[normalizeSeverity(hazard.severity)];
  const coordinates = firstPoint(hazard.geometry);
  const distance = coordinates
    ? distanceMeters({ latitude: location.latitude, longitude: location.longitude }, coordinates)
    : null;
  const sourceUrl = hazard.url || (typeof hazard.metadata?.url === 'string' ? hazard.metadata.url : null);
  const instruction = guidance[hazard.event_type] || guidance.other;

  return (
    <Screen>
      <PageHeader
        eyebrow={`${hazard.source.toUpperCase()} · ${hazardTypeLabel(hazard.event_type)}`}
        title={hazard.title}
        subtitle={`${timeAgo(hazard.published_at || hazard.created_at)} · ${hazard.is_active === false ? 'Hết hiệu lực' : 'Đang hoạt động'}`}
        onBack={onBack}
      />

      <Card tone={hazard.severity === 'critical' ? 'danger' : 'default'} style={styles.hero}>
        <View style={styles.heroTop}>
          <View style={[styles.icon, { backgroundColor: meta.bg }]}>
            <Ionicons name="warning" size={26} color={meta.color} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Mức độ</Text>
            <Text style={[styles.value, { color: meta.color }]}>{meta.label}</Text>
          </View>
          <Chip label={hazardTypeLabel(hazard.event_type)} />
        </View>
        <View style={styles.metaGrid}>
          <Meta label="Khu vực" value={hazard.district || (hazard.provinces?.slice(0, 2).join(', ') || 'Toàn quốc')} />
          <Meta label="Khoảng cách" value={distance !== null ? formatDistance(distance) : 'Không xác định'} />
          <Meta label="Phát hành" value={formatDateTime(hazard.published_at || hazard.issued_at || hazard.created_at)} />
          <Meta label="Hết hiệu lực" value={formatDateTime(hazard.expires_at)} />
        </View>
      </Card>

      <SectionHeader title="Nội dung cảnh báo" icon="document-text" />
      <Card>
        <Text style={styles.description}>{hazard.description || 'Nguồn tin không kèm mô tả chi tiết.'}</Text>
        {sourceUrl ? (
          <PrimaryButton
            label="Mở bản tin gốc"
            icon="open-outline"
            tone="ghost"
            onPress={() => Linking.openURL(sourceUrl)}
          />
        ) : null}
      </Card>

      <SectionHeader title="Khuyến cáo ứng phó" icon="shield" />
      <Card tone="danger">
        <Text style={styles.guidance}>{instruction}</Text>
        <Text style={styles.disclaimer}>
          Đây là hướng dẫn chung, không thay thế chỉ đạo của cơ quan chức năng tại địa phương.
        </Text>
      </Card>

      <View style={styles.actions}>
        <View style={{ flex: 1 }}>
          <PrimaryButton label="Gọi 112" icon="call" tone="danger" onPress={() => Linking.openURL('tel:112')} />
        </View>
        <View style={{ flex: 1 }}>
          <PrimaryButton
            label="Chia sẻ"
            icon="share-social"
            tone="ghost"
            onPress={() =>
              Share.share({
                title: hazard.title,
                message: `${hazard.title}\n${hazard.description || ''}\n${sourceUrl || ''}`.trim(),
              }).catch(() => undefined)
            }
          />
        </View>
      </View>
      {coordinates ? (
        <PrimaryButton
          label="Chỉ đường tới khu vực"
          icon="navigate"
          tone="ghost"
          onPress={() =>
            Linking.openURL(
              `https://www.google.com/maps/dir/?api=1&destination=${coordinates.latitude},${coordinates.longitude}`,
            )
          }
        />
      ) : null}
      <Pressable onPress={() => navigate({ name: 'map' })} style={styles.mapLink}>
        <Ionicons name="map" size={15} color={colors.cyan} />
        <Text style={styles.mapLinkText}>Xem trên bản đồ cảnh báo</Text>
      </Pressable>
    </Screen>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaItem}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.metaValue} numberOfLines={2}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { gap: 12 },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 50, height: 50, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  label: { color: colors.textDim, fontSize: 9, fontWeight: '700' },
  value: { fontSize: 18, fontWeight: '800' },
  metaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metaItem: { width: '45%', gap: 2 },
  metaValue: { color: colors.text, fontSize: 10, fontWeight: '600', lineHeight: 14 },
  description: { color: colors.text, fontSize: 12, lineHeight: 20 },
  guidance: { color: colors.text, fontSize: 12, lineHeight: 19 },
  disclaimer: { color: colors.textMuted, fontSize: 9, lineHeight: 14 },
  actions: { flexDirection: 'row', gap: 10 },
  mapLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 6 },
  mapLinkText: { color: colors.cyan, fontSize: 10, fontWeight: '700' },
});
