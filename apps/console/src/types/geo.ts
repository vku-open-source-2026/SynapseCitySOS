// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Geolocation helper types owned by the SOS map/geocode feature (/v1/geo).
 *
 * Deliberately generic: this product must never model a City infrastructure
 * asset. Hazard and emergency-event geometry is declared in their own domain
 * types.
 */
export interface Coordinates {
  longitude: number;
  latitude: number;
}

export interface GeocodeResponse {
  coordinates: Coordinates;
  geojson: {
    type: 'Point';
    coordinates: [number, number];
  };
}

export interface ReverseGeocodeResponse {
  address: string;
  city: string;
  country: string;
}

export interface AddressSuggestion {
  address: string;
  coordinates: Coordinates;
  city?: string;
  country?: string;
}

/** Minimal GeoJSON geometry shape used by SOS map layers. */
export interface GeoJsonGeometry {
  type: 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon';
  coordinates: number[] | number[][] | number[][][];
}
