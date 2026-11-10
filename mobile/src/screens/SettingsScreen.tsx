// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import type { AppRoute } from '../lib/deepLink';
import { API_BASE } from '../api/client';
import { colors } from '../lib/format';
import type { AppSettings } from '../lib/storage';
import type { AppLocation } from '../hooks/useLocation';
import { Card, Chip, Divider, PrimaryButton, Screen, SectionHeader, StatusDot } from '../components/ui';
import { PageHeader } from '../components/PageHeader';

export function SettingsScreen({
  settings,
  onChange,
  location,
  locationState,
  locationMessage,
  onRefreshLocation,
  online,
  navigate,
  onBack,
}: {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  location: AppLocation;
  locationState: string;
  locationMessage?: string | null;
  onRefreshLocation: () => void;
  online: boolean;
  navigate: (route: AppRoute) => void;
  onBack: () => void;
}) {
  const appVersion = Constants.expoConfig?.version ?? '0.1.0';
  return (
    <Screen>
      <PageHeader eyebrow="CÀI ĐẶT" title="SynapseSOS" subtitle={`Android ${appVersion}`} onBack={onBack} />
      <SectionHeader title="Cảnh báo" icon="notifications" />
      <Card>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Thông báo thiên tai</Text>
            <Text style={styles.body}>Thông báo khi nguồn tin có cảnh báo mới vượt ngưỡng.</Text>
          </View>
          <Switch
            value={settings.notificationsEnabled}
            onValueChange={(value) => onChange({ ...settings, notificationsEnabled: value })}
            trackColor={{ false: '#F1D9CC', true: '#FECDD3' }}
            thumbColor={settings.notificationsEnabled ? colors.red : '#A0847D'}
          />
        </View>
        <Divider />
        <Text style={styles.title}>Ngưỡng</Text>
        <View style={styles.chips}>
          {[
            { value: 'all', label: 'Tất cả' },
            { value: 'high', label: 'Cao trở lên' },
            { value: 'critical', label: 'Nghiêm trọng' },
          ].map((item) => (
            <Chip
              key={item.value}
              label={item.label}
              active={settings.severityThreshold === item.value}
              onPress={() => onChange({ ...settings, severityThreshold: item.value as AppSettings['severityThreshold'] })}
            />
          ))}
        </View>
      </Card>

      <SectionHeader title="Vị trí" icon="location" />
      <Card>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Vị trí hiện tại</Text>
            <Text style={styles.body}>
              {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
              {location.accuracy ? ` · ±${Math.round(location.accuracy)} m` : ''}
            </Text>
          </View>
          <StatusDot online={locationState === 'ready'} label={locationState === 'ready' ? 'GPS' : 'MẶC ĐỊNH'} />
        </View>
        {locationMessage ? <Text style={styles.warn}>{locationMessage}</Text> : null}
        <PrimaryButton label="Làm mới vị trí" icon="locate" tone="ghost" onPress={onRefreshLocation} />
      </Card>

      <SectionHeader title="Widget" icon="apps" />
      <Pressable onPress={() => navigate({ name: 'widget-help' })} style={styles.menu}>
        <View style={styles.menuIcon}><Ionicons name="grid" size={18} color={colors.red} /></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.menuLabel}>Cách thêm widget SOS</Text>
          <Text style={styles.menuSub}>Cảnh báo mới nhất, sự kiện và bản đồ mini.</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
      </Pressable>

      <SectionHeader title="Production" icon="server" />
      <Card>
        <View style={styles.kv}><Text style={styles.k}>API</Text><Text style={styles.api} numberOfLines={1}>{API_BASE}</Text></View>
        <View style={styles.kv}><Text style={styles.k}>Kết nối</Text><StatusDot online={online} label={online ? 'ĐANG KẾT NỐI' : 'KHÔNG KẾT NỐI'} /></View>
        <Divider />
        <Text style={styles.small}>
          Dữ liệu cảnh báo lấy trực tiếp từ https://sos.synapsecity.sbs/v1, không dùng máy chủ trung gian
          và không gọi API của SynapseCity.
        </Text>
      </Card>

      <SectionHeader title="Liên kết" icon="link" />
      <LinkRow icon="globe-outline" label="Console SynapseSOS" url="https://sos.synapsecity.sbs" />
      <LinkRow icon="book-outline" label="Tài liệu API" url="https://sos.synapsecity.sbs/docs" />
      <LinkRow icon="business-outline" label="SynapseCity (sản phẩm hạ tầng)" url="https://synapsecity.sbs" />
      <Text style={styles.legal}>
        Apache-2.0 · VKU.VIC 2026. Ứng dụng hỗ trợ thông tin, không thay thế cơ quan cứu hộ. Gọi
        112/113/114/115 khi khẩn cấp.
      </Text>
    </Screen>
  );
}

function LinkRow({ icon, label, url }: { icon: keyof typeof Ionicons.glyphMap; label: string; url: string }) {
  return (
    <Pressable onPress={() => Linking.openURL(url)} style={({ pressed }) => [styles.menu, pressed && { opacity: 0.8 }]}>
      <View style={styles.menuIcon}><Ionicons name={icon} size={18} color={colors.red} /></View>
      <Text style={styles.menuLabel}>{label}</Text>
      <Ionicons name="open-outline" size={15} color={colors.textDim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  title: { color: colors.text, fontSize: 12, fontWeight: '700' },
  body: { color: colors.textMuted, fontSize: 10, lineHeight: 15, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 4 },
  warn: { color: colors.amber, fontSize: 10, lineHeight: 15 },
  menu: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  menuIcon: { width: 36, height: 36, borderRadius: 11, backgroundColor: '#FFF1F2', alignItems: 'center', justifyContent: 'center' },
  menuLabel: { color: colors.text, fontSize: 12, fontWeight: '700', flex: 1 },
  menuSub: { color: colors.textMuted, fontSize: 9, marginTop: 2 },
  kv: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 2 },
  k: { color: colors.textDim, fontSize: 10, fontWeight: '700', width: 64 },
  api: { color: colors.cyan, fontSize: 10, flex: 1, textAlign: 'right' },
  small: { color: colors.textDim, fontSize: 9, lineHeight: 14 },
  legal: { color: colors.textDim, fontSize: 9, lineHeight: 14, textAlign: 'center', paddingVertical: 8 },
});
