// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { sosApi } from '../api/sos';
import { errorMessage } from '../api/client';
import type { AppRoute } from '../lib/deepLink';
import { colors } from '../lib/format';
import { useAuth } from '../store/auth';
import {
  Card,
  Chip,
  Divider,
  ErrorNotice,
  PrimaryButton,
  Screen,
  SectionHeader,
  TextField,
} from '../components/ui';
import { PageHeader } from '../components/PageHeader';

export function AccountScreen({
  navigate,
  onBack,
}: {
  navigate: (route: AppRoute) => void;
  onBack: () => void;
}) {
  const { user, token, connectTier2Token, logout } = useAuth();
  const [tier2Token, setTier2Token] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const responderQuery = useQuery({
    queryKey: ['sos', 'responder', token],
    queryFn: () => sosApi.listResponderEvents(token as string),
    enabled: Boolean(token),
    staleTime: 60_000,
    retry: 1,
  });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await connectTier2Token(tier2Token.trim());
      setTier2Token('');
    } catch (authError) {
      setError(errorMessage(authError));
    } finally {
      setBusy(false);
    }
  };

  if (token && user) {
    return (
      <Screen>
        <PageHeader
          eyebrow="RESPONDER"
          title={user.full_name || user.email}
          subtitle={user.email}
          onBack={onBack}
          right={
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{(user.full_name || user.email || '?').slice(0, 1).toUpperCase()}</Text>
            </View>
          }
        />
        <Card tone="danger">
          <View style={styles.row}>
            <Ionicons name="shield-checkmark" size={22} color={colors.red} />
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Vai trò</Text>
              <Text style={styles.value}>{user.role}</Text>
            </View>
            <Chip label="Đã đăng nhập" color={colors.green} bg="rgba(52,211,153,0.14)" />
          </View>
          <Divider />
          <View style={styles.row}>
            <Ionicons name="key" size={20} color={colors.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Quyền</Text>
              <Text style={styles.value}>
                {user.permissions?.length ? user.permissions.slice(0, 6).join(', ') : 'Chưa có quyền vận hành'}
              </Text>
            </View>
          </View>
        </Card>

        <SectionHeader title="Tóm tắt responder (chỉ đọc)" icon="pulse" />
        <Card>
          {responderQuery.isLoading ? (
            <Text style={styles.muted}>Đang tải sự kiện khẩn cấp…</Text>
          ) : responderQuery.error ? (
            <ErrorNotice message="Không tải được dữ liệu responder. Tài khoản có thể thiếu quyền emergency:read." onRetry={() => responderQuery.refetch()} />
          ) : (
            <>
              <Text style={styles.big}>{responderQuery.data?.length ?? 0}</Text>
              <Text style={styles.muted}>sự kiện khẩn cấp mà tài khoản này được phép đọc</Text>
              {(responderQuery.data ?? []).slice(0, 3).map((event) => (
                <View key={event.id} style={styles.eventRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.eventTitle} numberOfLines={1}>{event.title}</Text>
                    <Text style={styles.eventMeta}>{event.status} · {event.severity}</Text>
                  </View>
                  <Chip label={event.severity} />
                </View>
              ))}
            </>
          )}
        </Card>

        <SectionHeader title="Công cụ" icon="construct" />
        <MenuRow icon="notifications-outline" label="Cài đặt cảnh báo" onPress={() => navigate({ name: 'settings' })} />
        <MenuRow icon="apps-outline" label="Widget màn hình chính" onPress={() => navigate({ name: 'widget-help' })} />
        <PrimaryButton label="Đăng xuất" icon="log-out" tone="danger" onPress={() => logout().catch(() => undefined)} />
        <Text style={styles.note}>Token lưu trong SecureStore; không hiển thị trong log hay giao diện.</Text>
      </Screen>
    );
  }

  return (
    <Screen>
      <PageHeader
        eyebrow="TÀI KHOẢN"
        title="Kết nối tài khoản responder"
        subtitle="Đăng nhập tại SynapseDX workspace, sau đó dán access token để mở phiên SOS ngắn hạn. Không bắt buộc để xem cảnh báo công khai."
        onBack={onBack}
      />
      <Card>
        <Text style={styles.infoTitle}>1. Mở SynapseDX workspace</Text>
        <Pressable
          onPress={() => Linking.openURL('https://synapsedx.sbs/workspace').catch(() => undefined)}
          style={styles.switch}
        >
          <Text style={styles.switchText}>Mở https://synapsedx.sbs/workspace</Text>
        </Pressable>
        <Text style={styles.infoBody}>
          SOS không còn nhận email/mật khẩu trực tiếp. Phiên được cấp bằng token Tier-2 đã xác thực qua
          /v1/auth/exchange.
        </Text>
      </Card>
      <Card>
        <Text style={styles.infoTitle}>2. Dán access token Tier-2</Text>
        <TextField
          label="Access token"
          value={tier2Token}
          onChangeText={setTier2Token}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder="eyJ..."
        />
        {error ? <ErrorNotice message={error} /> : null}
        <PrimaryButton
          label="Kết nối"
          icon="log-in"
          loading={busy}
          onPress={() => submit().catch(() => undefined)}
        />
      </Card>
      <Card>
        <Text style={styles.infoTitle}>Quyền được kiểm tra phía máy chủ</Text>
        <Text style={styles.infoBody}>
          Vai trò SOS được ánh xạ từ chính sách quản trị viên/bootstrap và mặc định responder. Các thao
          tác dispatch/EOP/SITREP yêu cầu quyền tương ứng; app này chỉ hiển thị phần đọc và hướng dẫn
          công khai.
        </Text>
      </Card>
      <MenuRow icon="settings-outline" label="Cài đặt ứng dụng" onPress={() => navigate({ name: 'settings' })} />
    </Screen>
  );
}

function MenuRow({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.menu, pressed && { opacity: 0.8 }]}>
      <View style={styles.menuIcon}>
        <Ionicons name={icon} size={18} color={colors.red} />
      </View>
      <Text style={styles.menuLabel}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#FFE4E6',
    borderWidth: 1,
    borderColor: '#FECDD3',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.red, fontSize: 20, fontWeight: '800' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  label: { color: colors.textDim, fontSize: 9, fontWeight: '700' },
  value: { color: colors.text, fontSize: 12, marginTop: 2, lineHeight: 17 },
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
  menuIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: '#FFF1F2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuLabel: { color: colors.text, fontSize: 12, fontWeight: '700', flex: 1 },
  switch: { alignItems: 'center', paddingVertical: 6 },
  switchText: { color: colors.cyan, fontSize: 11, fontWeight: '700' },
  note: { color: colors.textDim, fontSize: 9, textAlign: 'center', lineHeight: 14 },
  infoTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  infoBody: { color: colors.textMuted, fontSize: 10, lineHeight: 16 },
  muted: { color: colors.textMuted, fontSize: 10, lineHeight: 15 },
  big: { color: colors.text, fontSize: 36, fontWeight: '800', lineHeight: 40 },
  eventRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8, marginTop: 4 },
  eventTitle: { color: colors.text, fontSize: 11, fontWeight: '700' },
  eventMeta: { color: colors.textDim, fontSize: 9, marginTop: 1 },
});
