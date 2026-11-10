// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { AuthResponse } from '../api/types';

const KEYS = {
  session: 'synapsecitysos.session.v1',
  lastLocation: 'synapsecitysos.lastLocation.v1',
  settings: 'synapsecitysos.settings.v1',
  seenHazards: 'synapsecitysos.seenHazards.v1',
  widgetSnapshot: 'synapsecitysos.widgetSnapshot.v1',
};

export interface StoredLocation {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  updatedAt: number;
  label?: string;
}

export interface AppSettings {
  notificationsEnabled: boolean;
  severityThreshold: 'all' | 'high' | 'critical';
}

export const defaultSettings: AppSettings = {
  notificationsEnabled: true,
  severityThreshold: 'high',
};

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: AuthResponse['user'];
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Best effort only.
  }
}

export async function loadLocation(): Promise<StoredLocation | null> {
  return readJson<StoredLocation>(KEYS.lastLocation);
}

export async function saveLocation(location: StoredLocation): Promise<void> {
  await writeJson(KEYS.lastLocation, location);
}

export async function loadSettings(): Promise<AppSettings> {
  return { ...defaultSettings, ...(await readJson<Partial<AppSettings>>(KEYS.settings)) };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await writeJson(KEYS.settings, settings);
}

export async function loadWidgetSnapshot<T>(): Promise<T | null> {
  return readJson<T>(KEYS.widgetSnapshot);
}

export async function saveWidgetSnapshot(snapshot: unknown): Promise<void> {
  await writeJson(KEYS.widgetSnapshot, snapshot);
}

export async function loadSeenHazards(): Promise<string[]> {
  return (await readJson<string[]>(KEYS.seenHazards)) ?? [];
}

export async function saveSeenHazards(ids: string[]): Promise<void> {
  await writeJson(KEYS.seenHazards, ids.slice(0, 150));
}

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEYS.session);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export async function saveSession(session: Session): Promise<void> {
  await SecureStore.setItemAsync(KEYS.session, JSON.stringify(session), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEYS.session);
  } catch {
    // Ignore.
  }
}
