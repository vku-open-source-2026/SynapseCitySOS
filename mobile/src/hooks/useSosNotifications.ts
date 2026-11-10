// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { Hazard, Severity } from '../api/types';
import { normalizeSeverity } from '../lib/format';
import {
  loadSeenHazards,
  saveSeenHazards,
  type AppSettings,
} from '../lib/storage';

const CHANNEL_ID = 'sos-alerts';
const rank: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

async function ensurePermissions(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Cảnh báo thiên tai',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 400, 200, 400],
      lightColor: '#B9382B',
      sound: 'default',
    });
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

export function useSosNotifications(hazards: Hazard[] | undefined, settings: AppSettings) {
  const initialized = useRef(false);
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!settings.notificationsEnabled) return;
    let active = true;
    loadSeenHazards().then((ids) => {
      if (active) seen.current = new Set(ids);
    });
    ensurePermissions().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [settings.notificationsEnabled]);

  useEffect(() => {
    if (!hazards || hazards.length === 0) return;
    const threshold = settings.severityThreshold === 'all' ? 0 : settings.severityThreshold === 'high' ? 3 : 4;
    const activeHazards = hazards.filter(
      (hazard) => hazard.is_active !== false && hazard.status !== 'expired',
    );
    const unseen = activeHazards.filter((hazard) => !seen.current.has(hazard.id));

    if (!initialized.current) {
      initialized.current = true;
      unseen.forEach((hazard) => seen.current.add(hazard.id));
      saveSeenHazards([...seen.current]).catch(() => undefined);
      return;
    }

    const candidates = unseen
      .map((hazard) => ({ hazard, severity: normalizeSeverity(hazard.severity) }))
      .filter((entry) => rank[entry.severity] >= threshold)
      .sort((a, b) => rank[b.severity] - rank[a.severity]);

    unseen.forEach((hazard) => seen.current.add(hazard.id));
    saveSeenHazards([...seen.current]).catch(() => undefined);

    if (!settings.notificationsEnabled || candidates.length === 0) return;
    const top = candidates[0];
    Notifications.scheduleNotificationAsync({
      content: {
        title:
          top.severity === 'critical'
            ? 'Cảnh báo thiên tai nghiêm trọng'
            : 'Cảnh báo thiên tai mới',
        body: `${top.hazard.title}${top.hazard.district ? ` · ${top.hazard.district}` : ''}`,
        data: { hazardId: top.hazard.id },
        sound: true,
      },
      trigger: null,
    }).catch(() => undefined);
  }, [hazards, settings.notificationsEnabled, settings.severityThreshold]);
}
