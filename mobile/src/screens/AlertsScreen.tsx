// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { FeedStatus, Hazard, Severity } from '../api/types';
import type { AppRoute } from '../lib/deepLink';
import {
  colors,
  feedStatusLabel,
  hazardTypeLabel,
  normalizeSeverity,
  severityMeta,
  timeAgo,
} from '../lib/format';
import { feedHealth } from '../lib/feed';
import {
  Card,
  Chip,
  EmptyState,
  ErrorNotice,
  Screen,
  TextField,
} from '../components/ui';
import { PageHeader } from '../components/PageHeader';

interface AlertsScreenProps {
  hazards: Hazard[];
  feed?: FeedStatus;
  loading: boolean;
  error?: string | null;
  onRetry: () => void;
  onRefreshStatus: () => void;
  navigate: (route: AppRoute) => void;
}

type Filter = 'all' | Severity;

export function AlertsScreen({
  hazards,
  feed,
  loading,
  error,
  onRetry,
  onRefreshStatus,
  navigate,
}: AlertsScreenProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const health = feedHealth(feed);

  const types = useMemo(() => {
    const unique = new Set(hazards.map((hazard) => hazard.event_type).filter(Boolean));
    return ['all', ...Array.from(unique).slice(0, 6)];
  }, [hazards]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return hazards
      .filter((hazard) => hazard.is_active !== false && hazard.status !== 'expired')
      .filter((hazard) => (filter === 'all' ? true : hazard.severity === filter))
      .filter((hazard) => (typeFilter === 'all' ? true : hazard.event_type === typeFilter))
      .filter((hazard) =>
        needle
          ? `${hazard.title} ${hazard.description || ''} ${hazard.district || ''}`
              .toLowerCase()
              .includes(needle)
          : true,
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }, [hazards, filter, typeFilter, search]);

  return (
    <Screen>
      <PageHeader
        eyebrow="CẢNH BÁO"
        title="Thiên tai & sự cố"
        subtitle={`${filtered.length} cảnh báo đang hoạt động · nguồn VNDMS/NCHMF`}
        right={<Chip label={health.state === 'ok' ? 'LIVE' : 'KHÔNG XÁC ĐỊNH'} color={health.state === 'ok' ? colors.green : colors.amber} />}
      />
      <Card tone={health.state === 'ok' ? 'default' : 'danger'} style={styles.feedCard}>
        <View style={styles.feedRow}>
          <Ionicons
            name={health.state === 'ok' ? 'checkmark-circle' : 'warning'}
            size={20}
            color={health.state === 'ok' ? colors.green : colors.amber}
          />
          <View style={{ flex: 1 }}>
            <Text style={[styles.feedTitle, { color: health.state === 'ok' ? colors.green : colors.amber }]}>
              {health.label}
            </Text>
            <Text style={styles.feedBody}>
              {health.state === 'ok'
                ? `${feedStatusLabel(feed?.hazard_feed?.status)} · lần chạy cuối ${timeAgo(feed?.hazard_feed?.last_success_at || feed?.hazard_feed?.last_run_at)}`
                : 'API SOS đang suy giảm — cảnh báo có thể chưa đầy đủ.'}
            </Text>
          </View>
          <Pressable onPress={onRefreshStatus} hitSlop={8}>
            <Ionicons name="refresh" size={18} color={colors.cyan} />
          </Pressable>
        </View>
      </Card>

      <TextField
        label="Tìm cảnh báo"
        value={search}
        onChangeText={setSearch}
        placeholder="Tìm theo tiêu đề, khu vực hoặc mô tả"
        autoCorrect={false}
      />
      <View style={styles.chips}>
        <Chip label="Tất cả" active={filter === 'all'} onPress={() => setFilter('all')} />
        {(Object.keys(severityMeta) as Severity[]).map((severity) => (
          <Chip
            key={severity}
            label={severityMeta[severity].label}
            color={severityMeta[severity].color}
            bg={severityMeta[severity].bg}
            active={filter === severity}
            onPress={() => setFilter(severity)}
          />
        ))}
      </View>
      <View style={styles.chips}>
        {types.map((type) => (
          <Chip
            key={type}
            label={type === 'all' ? 'Mọi loại' : hazardTypeLabel(type)}
            active={typeFilter === type}
            onPress={() => setTypeFilter(type)}
          />
        ))}
      </View>

      {error ? <ErrorNotice message={error} onRetry={onRetry} /> : null}
      {loading ? <Text style={styles.muted}>Đang tải cảnh báo từ production…</Text> : null}

      {filtered.map((hazard) => {
        const meta = severityMeta[normalizeSeverity(hazard.severity)];
        return (
          <Pressable
            key={hazard.id}
            onPress={() => navigate({ name: 'hazard', params: { id: hazard.id } })}
            style={({ pressed }) => [styles.card, pressed && { opacity: 0.82 }]}
          >
            <View style={styles.cardTop}>
              <View style={[styles.icon, { backgroundColor: meta.bg }]}>
                <Ionicons name="warning" size={18} color={meta.color} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.title} numberOfLines={2}>{hazard.title}</Text>
                <Text style={styles.meta}>
                  {hazardTypeLabel(hazard.event_type)} · {hazard.source} · {timeAgo(hazard.published_at || hazard.created_at)}
                </Text>
              </View>
              <Chip label={meta.label} color={meta.color} bg={meta.bg} />
            </View>
            {hazard.description ? (
              <Text style={styles.body} numberOfLines={3}>{hazard.description}</Text>
            ) : null}
            <View style={styles.footer}>
              <Chip label={hazard.district || 'Toàn quốc'} />
              <Chip label={hazard.is_active === false ? 'Hết hiệu lực' : 'Đang hoạt động'} color={hazard.is_active === false ? colors.textDim : colors.green} />
              <View style={{ flex: 1 }} />
              <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
            </View>
          </Pressable>
        );
      })}
      {!loading && filtered.length === 0 ? (
        <EmptyState
          icon="shield-checkmark-outline"
          title="Không có cảnh báo phù hợp"
          body="Thử đổi bộ lọc hoặc từ khóa. Không có kết quả không có nghĩa là an toàn — hãy theo dõi nguồn tin chính thức."
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  feedCard: { padding: 12 },
  feedRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  feedTitle: { fontSize: 11, fontWeight: '800' },
  feedBody: { color: colors.textMuted, fontSize: 9, marginTop: 2, lineHeight: 13 },
  chips: { flexDirection: 'row', gap: 7, flexWrap: 'wrap' },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 13,
    gap: 8,
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  icon: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontSize: 13, fontWeight: '700', lineHeight: 18 },
  meta: { color: colors.textDim, fontSize: 9 },
  body: { color: colors.textMuted, fontSize: 10, lineHeight: 16 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  muted: { color: colors.textMuted, fontSize: 11 },
});
