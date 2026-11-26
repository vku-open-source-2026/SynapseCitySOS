// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../lib/format';

export function PageHeader({
  title,
  subtitle,
  onBack,
  right,
  eyebrow,
  showBrand = true,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
  eyebrow?: string;
  showBrand?: boolean;
}) {
  return (
    <View style={styles.root}>
      {showBrand ? (
        <View style={styles.brand}>
          <View style={styles.mark}>
            <Ionicons name="shield" size={18} color="#FFFFFF" />
          </View>
          <View style={styles.brandText}>
            <Text style={styles.brandTitle} numberOfLines={1}>SynapseCity SOS</Text>
            <Text style={styles.brandSub} numberOfLines={1}>EMERGENCY COMMAND</Text>
          </View>
          <Pressable
            onPress={() => Linking.openURL('tel:112')}
            accessibilityLabel="Gọi khẩn cấp 112"
            style={({ pressed }) => [styles.hotline, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="call" size={12} color={colors.accent} />
            <Text style={styles.hotlineText}>112</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.header}>
        {onBack ? (
          <Pressable onPress={onBack} style={styles.back} accessibilityLabel="Quay lại">
            <Ionicons name="arrow-back" size={20} color={colors.text} />
          </Pressable>
        ) : null}
        <View style={styles.textWrap}>
          {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle} numberOfLines={2}>{subtitle}</Text> : null}
        </View>
        {right}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.header,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    shadowColor: '#4A1720',
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  mark: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandText: { flex: 1, gap: 1 },
  brandTitle: { color: colors.headerText, fontSize: 15, fontWeight: '800', letterSpacing: -0.2 },
  brandSub: { color: colors.headerSub, fontSize: 9, fontWeight: '700', letterSpacing: 1.4 },
  hotline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  hotlineText: { color: colors.accent, fontSize: 12, fontWeight: '800', letterSpacing: 0.3 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 50,
  },
  back: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#4A1720',
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  textWrap: { flex: 1, gap: 2 },
  eyebrow: { color: colors.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
});
