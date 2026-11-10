// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AppRouteName } from '../lib/deepLink';
import { colors } from '../lib/format';

const tabs: Array<{
  route: AppRouteName;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
}> = [
  { route: 'home', label: 'Tổng quan', icon: 'shield-outline', activeIcon: 'shield' },
  { route: 'map', label: 'Bản đồ', icon: 'map-outline', activeIcon: 'map' },
  { route: 'alerts', label: 'Cảnh báo', icon: 'warning-outline', activeIcon: 'warning' },
  { route: 'shelters', label: 'Trú ẩn', icon: 'home-outline', activeIcon: 'home' },
  { route: 'account', label: 'Tài khoản', icon: 'person-outline', activeIcon: 'person' },
];

export function TabBar({
  active,
  onNavigate,
}: {
  active: AppRouteName;
  onNavigate: (route: AppRouteName) => void;
}) {
  return (
    <View style={styles.wrapper}>
      <View style={styles.bar}>
        {tabs.map((tab) => {
          const selected = active === tab.route;
          return (
            <Pressable
              key={tab.route}
              onPress={() => onNavigate(tab.route)}
              accessibilityLabel={tab.label}
              style={styles.tab}
            >
              <Ionicons
                name={selected ? tab.activeIcon : tab.icon}
                size={21}
                color={selected ? colors.red : colors.textDim}
              />
              <Text style={[styles.label, selected && styles.labelActive]}>{tab.label}</Text>
              {selected ? <View style={styles.indicator} /> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 10, paddingBottom: 10 },
  bar: {
    height: 64,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.97)',
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    shadowColor: '#3F1D1A',
    shadowOpacity: 0.10,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, height: 56 },
  label: { color: colors.textDim, fontSize: 9, fontWeight: '600' },
  labelActive: { color: colors.red },
  indicator: {
    position: 'absolute',
    bottom: 3,
    width: 12,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.red,
  },
});
