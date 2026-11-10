// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { asList, request } from './client';
import type {
  AuthResponse,
  FeedStatus,
  Hazard,
  MapConfig,
  ProductInfo,
  PublicEmergencyEvent,
  SheltersResponse,
  SosEvent,
} from './types';

export const sosApi = {
  getProductInfo: () => request<ProductInfo>('/sos'),

  getMapConfig: () => request<MapConfig>('/map/config'),

  getFeedStatus: () => request<FeedStatus>('/emergency/public/status'),

  listHazards: async (params?: { limit?: number; offset?: number }): Promise<Hazard[]> => {
    const query = new URLSearchParams();
    query.set('limit', String(params?.limit ?? 300));
    if (params?.offset) query.set('offset', String(params.offset));
    return asList<Hazard>(await request(`/hazards?${query.toString()}`));
  },

  listRecentHazards: async (params?: { hours?: number; limit?: number }): Promise<Hazard[]> => {
    const query = new URLSearchParams();
    query.set('hours', String(params?.hours ?? 72));
    query.set('limit', String(params?.limit ?? 200));
    return asList<Hazard>(await request(`/hazards/recent?${query.toString()}`));
  },

  nearbyHazards: async (params: {
    lat: number;
    lng: number;
    radius_m?: number;
    limit?: number;
  }): Promise<Hazard[]> => {
    const query = new URLSearchParams({
      lat: String(params.lat),
      lng: String(params.lng),
      radius_m: String(params.radius_m ?? 100_000),
      limit: String(params.limit ?? 100),
    });
    return asList<Hazard>(await request(`/hazards/geo/near?${query.toString()}`));
  },

  listPublicEvents: async (params?: { limit?: number }): Promise<PublicEmergencyEvent[]> => {
    const query = new URLSearchParams();
    query.set('limit', String(params?.limit ?? 100));
    return asList<PublicEmergencyEvent>(await request(`/emergency/public?${query.toString()}`));
  },

  nearbyShelters: async (params: {
    lat: number;
    lng: number;
    radius_m?: number;
    limit?: number;
  }): Promise<SheltersResponse> => {
    const query = new URLSearchParams({
      lat: String(params.lat),
      lng: String(params.lng),
      radius_m: String(params.radius_m ?? 50_000),
      limit: String(params.limit ?? 50),
    });
    return request<SheltersResponse>(`/emergency/resources/shelters/near?${query.toString()}`);
  },

  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: { email: email.trim(), password },
    }),

  register: (input: { email: string; password: string; full_name: string; phone?: string }) =>
    request<AuthResponse>('/auth/register', { method: 'POST', body: input }),

  logout: (token: string) =>
    request<unknown>('/auth/logout', { method: 'POST', token }),

  listResponderEvents: async (token: string): Promise<SosEvent[]> =>
    asList<SosEvent>(await request('/emergency?limit=50', { token })),

  getDependencyHealth: () =>
    request<{ service: string; checked_at: string; dependencies: unknown[] }>('/emergency/health'),
};
