// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { asList, httpClient } from '../lib/httpClient';
import type {
  GeocodeResponse,
  ReverseGeocodeResponse,
  AddressSuggestion,
} from '../types/geo';

export interface GeocodeRequest {
  address: string;
  country?: string;
}

export interface ReverseGeocodeRequest {
  longitude: number;
  latitude: number;
}

/**
 * SOS geocoding client. The asset-scoped spatial queries from the City product
 * are intentionally absent: SOS only needs address lookup for its own maps.
 */
export const geoApi = {
  geocode: async (data: GeocodeRequest): Promise<GeocodeResponse> => {
    const response = await httpClient.post<GeocodeResponse>('/geo/geocode', data);
    return response.data;
  },

  reverseGeocode: async (data: ReverseGeocodeRequest): Promise<ReverseGeocodeResponse> => {
    const response = await httpClient.post<ReverseGeocodeResponse>('/geo/reverse-geocode', data);
    return response.data;
  },

  searchAddress: async (q: string, limit?: number): Promise<AddressSuggestion[]> => {
    const response = await httpClient.get<AddressSuggestion[]>('/geo/search-address', {
      params: { q, limit },
    });
    return asList<AddressSuggestion>(response.data);
  },
};
