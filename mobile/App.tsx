// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { colors } from './src/lib/format';
import { defaultSettings, loadSettings, saveSettings, type AppSettings } from './src/lib/storage';
import { parseDeepLink, type AppRoute, type AppRouteName } from './src/lib/deepLink';
import { AuthProvider, useAuth } from './src/store/auth';
import { useLocation } from './src/hooks/useLocation';
import {
  useActiveHazards,
  useFeedStatus,
  useHazards,
  useNearbyHazards,
  usePublicEvents,
  useShelters,
  useSosProduct,
  useSosWidgetSync,
} from './src/hooks/useSosData';
import { useSosNotifications } from './src/hooks/useSosNotifications';
import { useHazardStream } from './src/hooks/useHazardStream';
import { sosApi } from './src/api/sos';
import { HomeScreen } from './src/screens/HomeScreen';
import { MapScreen } from './src/screens/MapScreen';
import { AlertsScreen } from './src/screens/AlertsScreen';
import { SheltersScreen } from './src/screens/SheltersScreen';
import { EmergencyScreen } from './src/screens/EmergencyScreen';
import { AccountScreen } from './src/screens/AccountScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { HazardDetailScreen } from './src/screens/HazardDetailScreen';
import { EventDetailScreen } from './src/screens/EventDetailScreen';
import { WidgetHelpScreen } from './src/screens/WidgetHelpScreen';
import { TabBar } from './src/components/TabBar';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

const tabRoutes: AppRouteName[] = ['home', 'map', 'alerts', 'shelters', 'account'];

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <StatusBar style="dark" />
        <AppShell />
      </AuthProvider>
    </QueryClientProvider>
  );
}

function AppShell() {
  const { loading: authLoading } = useAuth();
  const queryClientInstance = useQueryClient();
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [tab, setTab] = useState<AppRouteName>('home');
  const [stack, setStack] = useState<AppRoute[]>([{ name: 'home' }]);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const locationState = useLocation();

  const productQuery = useSosProduct();
  const feedQuery = useFeedStatus();
  const hazardsQuery = useHazards();
  const eventsQuery = usePublicEvents();
  const sheltersQuery = useShelters(locationState.location);
  const mapConfigQuery = useQuery({
    queryKey: ['sos', 'map-config'],
    queryFn: sosApi.getMapConfig,
    staleTime: 10 * 60_000,
    retry: 1,
  });
  const activeHazards = useActiveHazards(hazardsQuery.data);
  const nearby = useNearbyHazards(activeHazards, locationState.location, 100_000);
  const stream = useHazardStream();

  useEffect(() => {
    loadSettings().then(setSettings).finally(() => setSettingsLoading(false));
  }, []);

  const online = productQuery.isSuccess;
  useSosWidgetSync(locationState.location, activeHazards, eventsQuery.data, feedQuery.data);
  useSosNotifications(hazardsQuery.data, settings);

  const updateSettings = useCallback((next: AppSettings) => {
    setSettings(next);
    saveSettings(next).catch(() => undefined);
  }, []);

  const refreshAll = useCallback(() => {
    productQuery.refetch().catch(() => undefined);
    feedQuery.refetch().catch(() => undefined);
    hazardsQuery.refetch().catch(() => undefined);
    eventsQuery.refetch().catch(() => undefined);
    sheltersQuery.refetch().catch(() => undefined);
    locationState.refresh(false).catch(() => undefined);
    setLastSync(Date.now());
  }, [productQuery, feedQuery, hazardsQuery, eventsQuery, sheltersQuery, locationState]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshAll();
    });
    return () => subscription.remove();
  }, [refreshAll]);

  const navigate = useCallback((route: AppRoute) => {
    setStack((current) => [...current, route]);
  }, []);
  const goTab = useCallback((route: AppRouteName) => {
    setTab(route);
    setStack([{ name: route }]);
  }, []);
  const goBack = useCallback(() => {
    setStack((current) => {
      if (current.length > 1) return current.slice(0, -1);
      if (tab !== 'home') {
        setTab('home');
        return [{ name: 'home' }];
      }
      return current;
    });
  }, [tab]);

  useEffect(() => {
    const handleUrl = (url: string | null) => {
      const route = parseDeepLink(url);
      if (!route) return;
      if (tabRoutes.includes(route.name)) goTab(route.name);
      else setStack((current) => [...current, route]);
    };
    Linking.getInitialURL().then(handleUrl).catch(() => undefined);
    const subscription = Linking.addEventListener('url', (event) => handleUrl(event.url));
    return () => subscription.remove();
  }, [goTab]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) {
        setStack((current) => current.slice(0, -1));
        return true;
      }
      if (tab !== 'home') {
        setTab('home');
        setStack([{ name: 'home' }]);
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [stack.length, tab]);

  const current: AppRoute = stack[stack.length - 1] ?? { name: 'home' };
  const tabVisible = tabRoutes.includes(current.name);
  const selectedHazard = current.params?.id
    ? activeHazards.find((hazard) => hazard.id === current.params?.id)
    : undefined;
  const selectedEvent = current.params?.id
    ? (eventsQuery.data ?? []).find((event) => event.id === current.params?.id)
    : undefined;

  if (authLoading || settingsLoading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.red} size="large" />
        <Text style={styles.loadingText}>SynapseSOS</Text>
      </View>
    );
  }

  const content = (() => {
    switch (current.name) {
      case 'home':
        return (
          <HomeScreen
            location={locationState.location}
            hazards={activeHazards}
            events={eventsQuery.data ?? []}
            nearby={nearby}
            feed={feedQuery.data}
            online={online}
            streamState={stream.state}
            refreshing={hazardsQuery.isFetching || feedQuery.isFetching}
            onRefresh={refreshAll}
            navigate={navigate}
            onTab={goTab}
          />
        );
      case 'map':
        return (
          <MapScreen
            location={locationState.location}
            hazards={activeHazards}
            events={eventsQuery.data ?? []}
            shelters={sheltersQuery.data?.shelters ?? []}
            nearby={nearby}
            mapConfig={mapConfigQuery.data}
            navigate={navigate}
          />
        );
      case 'alerts':
        return (
          <AlertsScreen
            hazards={activeHazards}
            feed={feedQuery.data}
            loading={hazardsQuery.isLoading}
            error={hazardsQuery.error ? 'Không tải được danh sách cảnh báo.' : null}
            onRetry={refreshAll}
            onRefreshStatus={() => feedQuery.refetch().catch(() => undefined)}
            navigate={navigate}
          />
        );
      case 'shelters':
        return (
          <SheltersScreen
            location={locationState.location}
            shelters={sheltersQuery.data?.shelters ?? []}
            loading={sheltersQuery.isLoading}
            error={sheltersQuery.error ? 'Không tải được nơi trú ẩn gần bạn.' : null}
            mapConfig={mapConfigQuery.data}
            onRetry={() => sheltersQuery.refetch().catch(() => undefined)}
          />
        );
      case 'emergency':
        return (
          <EmergencyScreen
            location={locationState.location}
            events={eventsQuery.data ?? []}
            nearby={nearby}
            navigate={navigate}
            onBack={goBack}
          />
        );
      case 'account':
        return <AccountScreen navigate={navigate} onBack={goBack} />;
      case 'settings':
        return (
          <SettingsScreen
            settings={settings}
            onChange={updateSettings}
            location={locationState.location}
            locationState={locationState.state}
            locationMessage={locationState.message}
            onRefreshLocation={() => locationState.refresh(true).catch(() => undefined)}
            online={online}
            navigate={navigate}
            onBack={goBack}
          />
        );
      case 'hazard':
        return (
          <HazardDetailScreen
            hazard={selectedHazard}
            location={locationState.location}
            navigate={navigate}
            onBack={goBack}
          />
        );
      case 'event':
        return (
          <EventDetailScreen
            event={selectedEvent}
            navigate={navigate}
            onBack={goBack}
          />
        );
      case 'widget-help':
        return (
          <WidgetHelpScreen
            location={locationState.location}
            hazards={activeHazards}
            events={eventsQuery.data ?? []}
            nearby={nearby}
            feed={feedQuery.data}
            onBack={goBack}
          />
        );
      default:
        return null;
    }
  })();

  return (
    <View style={styles.root}>
      <View style={styles.content}>{content}</View>
      {tabVisible ? (
        <>
          <TabBar active={tab} onNavigate={goTab} />
          <TouchableOpacity
            style={styles.sosFab}
            onPress={() => navigate({ name: 'emergency' })}
            accessibilityLabel="Mở ứng phó khẩn cấp"
          >
            <Text style={styles.sosText}>SOS</Text>
          </TouchableOpacity>
        </>
      ) : null}
      {lastSync ? (
        <View style={styles.syncBadge} pointerEvents="none">
          <Text style={styles.syncText}>
            Đồng bộ {new Date(lastSync).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1 },
  loading: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 14 },
  loadingText: { color: colors.text, fontSize: 18, fontWeight: '800', letterSpacing: 0.5 },
  sosFab: {
    position: 'absolute',
    right: 18,
    bottom: 88,
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: colors.redDeep,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: colors.bg,
    shadowColor: colors.red,
    shadowOpacity: 0.5,
    shadowRadius: 14,
    elevation: 10,
  },
  sosText: { color: '#FFF1F2', fontSize: 13, fontWeight: '900', letterSpacing: 0.5 },
  syncBadge: {
    position: 'absolute',
    top: 8,
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: colors.border,
  },
  syncText: { color: colors.textDim, fontSize: 8, fontWeight: '600' },
});
