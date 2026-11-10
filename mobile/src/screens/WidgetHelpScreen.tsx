// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { FeedStatus, Hazard, PublicEmergencyEvent } from '../api/types';
import type { AppLocation } from '../hooks/useLocation';
import type { NearbyHazard } from '../hooks/useSosData';
import { colors, normalizeSeverity, severityMeta } from '../lib/format';
import { formatDistance } from '../lib/geo';
import { requestWidgetRefresh } from '../lib/widget';
import { feedHealth } from '../lib/feed';
import { Card, Chip, PrimaryButton, Screen, SectionHeader } from '../components/ui';
import { PageHeader } from '../components/PageHeader';
import { HazardRadar } from '../components/HazardRadar';

export function WidgetHelpScreen({
  location,
  hazards,
  events,
  nearby,
  feed,
  onBack,
}: {
  location: AppLocation;
  hazards: Hazard[];
  events: PublicEmergencyEvent[];
  nearby: NearbyHazard[];
  feed?: FeedStatus;
  onBack: () => void;
}) {
  const [refreshed, setRefreshed] = useState(false);
  const nearest = nearby[0];
  const meta = nearest ? severityMeta[normalizeSeverity(nearest.hazard.severity)] : null;
  const health = feedHealth(feed);

  return (
    <Screen>
      <PageHeader
        eyebrow="WIDGET"
        title="Widget trên màn hình chính"
        subtitle="Thấy cảnh báo mới nhất và bản đồ mini mà không cần mở app."
        onBack={onBack}
      />

      <Card tone="danger" style={styles.preview}>
        <View style={styles.header}>
          <View style={styles.brand}>
            <View style={styles.mark}><Ionicons name="shield" size={13} color="#FFF1F2" /></View>
            <Text style={styles.brandText}>SYNAPSE SOS</Text>
          </View>
          <Chip
            label={health.state === 'ok' ? 'LIVE' : 'KHÔNG XÁC ĐỊNH'}
            color={health.state === 'ok' ? colors.green : colors.amber}
          />
        </View>
        <View style={styles.body}>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.kicker}>CẢNH BÁO GẦN NHẤT</Text>
            <Text style={styles.name} numberOfLines={2}>
              {nearest?.hazard.title || 'Không có cảnh báo trong 100 km'}
            </Text>
            <Text style={styles.bodyText}>
              {nearest && meta ? `${meta.label} · ${formatDistance(nearest.distance)}` : 'Mở app để xem nguồn tin'}
            </Text>
            <View style={styles.actions}>
              <View style={styles.pill}><Ionicons name="call" size={11} color={colors.red} /><Text style={styles.pillText}>SOS</Text></View>
              <View style={styles.pill}><Ionicons name="refresh" size={11} color={colors.red} /><Text style={styles.pillText}>Làm mới</Text></View>
            </View>
          </View>
          <HazardRadar location={location} hazards={hazards} events={events} size={104} radiusMeters={100_000} showLabels={false} />
        </View>
        <Text style={styles.footer}>Cập nhật 30 phút · nguồn tin công khai</Text>
      </Card>

      <SectionHeader title="Cách thêm widget" icon="add-circle" />
      <Step number="1" title="Nhấn giữ màn hình chính" body="Chọn Widgets trong menu của launcher." />
      <Step number="2" title="Tìm SynapseSOS" body="Kéo widget ra màn hình chính và cấp quyền vị trí khi được hỏi." />
      <Step number="3" title="Mở app một lần" body="App lưu vị trí gần nhất để widget hiển thị cảnh báo quanh bạn." />
      <Step number="4" title="Theo dõi trạng thái" body="Widget ghi rõ “Dữ liệu cũ” hoặc “Không xác định” thay vì báo an toàn giả." />

      <Card>
        <View style={styles.tipRow}>
          <Ionicons name="refresh-circle" size={22} color={colors.red} />
          <View style={{ flex: 1 }}>
            <Text style={styles.tipTitle}>Làm mới widget ngay</Text>
            <Text style={styles.tipBody}>Gọi API production và cập nhật cảnh báo tức thì.</Text>
          </View>
        </View>
        <PrimaryButton
          label={refreshed ? 'Đã gửi yêu cầu' : 'Làm mới widget'}
          icon="refresh"
          tone="ghost"
          onPress={() => {
            requestWidgetRefresh();
            setRefreshed(true);
          }}
        />
      </Card>

      <Card>
        <Text style={styles.tipTitle}>Không hiển thị “an toàn” khi mất dữ liệu</Text>
        <Text style={styles.tipBody}>
          Nếu nguồn tin lỗi hoặc quá cũ, widget hiển thị trạng thái không xác định kèm thời điểm cập
          nhật cuối. Luôn kiểm tra cảnh báo chính thức trước khi ra ngoài.
        </Text>
      </Card>
    </Screen>
  );
}

function Step({ number, title, body }: { number: string; title: string; body: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNumber}><Text style={styles.stepNumberText}>{number}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={styles.stepTitle}>{title}</Text>
        <Text style={styles.stepBody}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  mark: { width: 24, height: 24, borderRadius: 8, backgroundColor: colors.redDeep, alignItems: 'center', justifyContent: 'center' },
  brandText: { color: colors.text, fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  body: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  kicker: { color: colors.red, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  name: { color: colors.text, fontSize: 16, fontWeight: '800', lineHeight: 20 },
  bodyText: { color: colors.textMuted, fontSize: 10 },
  actions: { flexDirection: 'row', gap: 6, marginTop: 6 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FFE4E6', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 4 },
  pillText: { color: colors.red, fontSize: 8, fontWeight: '800' },
  footer: { color: colors.textDim, fontSize: 8 },
  step: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  stepNumber: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#FFE4E6', alignItems: 'center', justifyContent: 'center' },
  stepNumberText: { color: colors.red, fontSize: 12, fontWeight: '800' },
  stepTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  stepBody: { color: colors.textMuted, fontSize: 10, lineHeight: 15, marginTop: 2 },
  tipRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  tipTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  tipBody: { color: colors.textMuted, fontSize: 10, lineHeight: 15, marginTop: 2 },
});
