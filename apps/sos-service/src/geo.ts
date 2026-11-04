// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Hazard geospatial queries.
 *
 * Tier 2 has no spatial predicate yet (SynapseDX spatial-query issue), so SOS
 * pages the hazard dataset and evaluates the predicate in memory. The predicate
 * itself is exact: radius search uses the haversine distance on the WGS84
 * sphere and polygon search uses a ray-casting point-in-polygon test. Invalid
 * input is rejected instead of returning the whole dataset (issue #12).
 */
import { badRequest } from './errors';
import type { Data } from './filters';

export interface LatLng {
  lat: number;
  lng: number;
}

export type PolygonRings = number[][][];

const EARTH_RADIUS_M = 6_371_008.8;
const MAX_RADIUS_M = 50_000;
const MIN_RADIUS_M = 1;
const MAX_POLYGON_VERTICES = 10_000;
const MAX_RINGS = 64;

export function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in metres. Handles antimeridian crossings. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  let dLng = b.lng - a.lng;
  // Normalise to the shortest longitude delta so a ±180° crossing works.
  if (dLng > 180) dLng -= 360;
  if (dLng < -180) dLng += 360;
  const radLng = toRadians(dLng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.sin(radLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(x)));
}

export function parseCoordinates(latValue: unknown, lngValue: unknown): LatLng {
  const lat = Number(latValue);
  const lng = Number(lngValue);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw badRequest('coordinates_required', 'lat and lng must be finite numbers');
  }
  if (lat < -90 || lat > 90) throw badRequest('invalid_coordinates', 'lat must be between -90 and 90');
  if (lng < -180 || lng > 180) throw badRequest('invalid_coordinates', 'lng must be between -180 and 180');
  return { lat, lng };
}

export function parseRadius(value: unknown, fallback = 5_000): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest('invalid_radius', 'radius_m must be a finite number');
  if (parsed < MIN_RADIUS_M || parsed > MAX_RADIUS_M) {
    throw badRequest('invalid_radius', `radius_m must be between ${MIN_RADIUS_M} and ${MAX_RADIUS_M}`);
  }
  return parsed;
}

function isPosition(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length >= 2
    && Number.isFinite(Number(value[0]))
    && Number.isFinite(Number(value[1]))
    && Math.abs(Number(value[0])) <= 180
    && Math.abs(Number(value[1])) <= 90;
}

function validateRing(ring: unknown): PolygonRings[number] {
  if (!Array.isArray(ring) || ring.length < 4) {
    throw badRequest('invalid_geometry', 'each polygon ring needs at least 4 positions');
  }
  if (ring.length > MAX_POLYGON_VERTICES) {
    throw badRequest('invalid_geometry', `polygon ring exceeds ${MAX_POLYGON_VERTICES} positions`);
  }
  const positions = ring.map((position) => {
    if (!isPosition(position)) throw badRequest('invalid_geometry', 'polygon position must be [lng, lat]');
    return [Number(position[0]), Number(position[1])];
  });
  const first = positions[0];
  const last = positions[positions.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw badRequest('invalid_geometry', 'polygon ring must be closed (first equals last)');
  }
  return positions;
}

export interface GeoPolygon {
  type: 'Polygon';
  coordinates: PolygonRings;
}

export interface GeoMultiPolygon {
  type: 'MultiPolygon';
  coordinates: PolygonRings[];
}

export type GeoArea = GeoPolygon | GeoMultiPolygon;

/** Validate a GeoJSON Polygon or MultiPolygon. Throws a 400 HttpError. */
export function validatePolygon(input: unknown): GeoArea {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest('invalid_geometry', 'polygon must be a GeoJSON Polygon or MultiPolygon');
  }
  const geometry = input as { type?: unknown; coordinates?: unknown };
  if (geometry.type === 'Polygon') {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0 || geometry.coordinates.length > MAX_RINGS) {
      throw badRequest('invalid_geometry', 'polygon coordinates must contain 1..64 rings');
    }
    return { type: 'Polygon', coordinates: geometry.coordinates.map(validateRing) };
  }
  if (geometry.type === 'MultiPolygon') {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0 || geometry.coordinates.length > MAX_RINGS) {
      throw badRequest('invalid_geometry', 'multipolygon coordinates must contain 1..64 polygons');
    }
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map((polygon) => {
        if (!Array.isArray(polygon) || polygon.length === 0) throw badRequest('invalid_geometry', 'each multipolygon member needs rings');
        return polygon.map(validateRing);
      }),
    };
  }
  throw badRequest('invalid_geometry', 'geometry.type must be Polygon or MultiPolygon');
}

function ringContainsPoint(ring: number[][], point: LatLng): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects = (yi > point.lat) !== (yj > point.lat)
      && point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(point: LatLng, ring: number[][]): boolean {
  return ringContainsPoint(ring, point);
}

/** Point-in-polygon with hole support (ring 0 is the shell). */
export function areaContainsPoint(area: GeoArea, point: LatLng): boolean {
  const polygons = area.type === 'Polygon' ? [area.coordinates] : area.coordinates;
  return polygons.some((rings) => {
    if (!ringContainsPoint(rings[0], point)) return false;
    // Inside a hole means outside the polygon.
    return !rings.slice(1).some((hole) => ringContainsPoint(hole, point));
  });
}

function asNumberPair(value: unknown): LatLng | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lng = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/**
 * Extract representative points from a hazard record. Supports a top-level
 * `geometry` (Point/MultiPoint/Polygon/MultiPolygon/LineString) plus the legacy
 * `lat`/`lon` and `metadata.lat`/`metadata.lon` fields used by VNDMS imports.
 */
export function hazardPoints(row: Data): LatLng[] {
  const points: LatLng[] = [];
  const geometry = row.geometry as { type?: unknown; coordinates?: unknown } | undefined;
  if (geometry && typeof geometry === 'object') {
    const type = String(geometry.type || '');
    const coordinates = geometry.coordinates;
    if (type === 'Point') {
      const point = asNumberPair(coordinates);
      if (point) points.push(point);
    } else if (type === 'MultiPoint' && Array.isArray(coordinates)) {
      for (const position of coordinates) {
        const point = asNumberPair(position);
        if (point) points.push(point);
      }
    } else if ((type === 'LineString' || type === 'MultiLineString') && Array.isArray(coordinates)) {
      for (const position of coordinates) {
        const point = asNumberPair(position);
        if (point) points.push(point);
      }
    } else if (type === 'Polygon' && Array.isArray(coordinates)) {
      for (const position of (coordinates[0] as unknown[]) || []) {
        const point = asNumberPair(position);
        if (point) points.push(point);
      }
    } else if (type === 'MultiPolygon' && Array.isArray(coordinates)) {
      for (const polygon of coordinates) {
        for (const position of ((polygon as unknown[])[0] as unknown[]) || []) {
          const point = asNumberPair(position);
          if (point) points.push(point);
        }
      }
    }
  }

  if (points.length === 0) {
    const lat = Number(row.lat ?? (row.metadata as Data | undefined)?.lat);
    const lng = Number(row.lon ?? row.lng ?? (row.metadata as Data | undefined)?.lon ?? (row.metadata as Data | undefined)?.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) points.push({ lat, lng });
  }
  return points;
}

export function hazardDistanceMeters(row: Data, origin: LatLng): number | null {
  const points = hazardPoints(row);
  if (points.length === 0) return null;
  return Math.min(...points.map((point) => haversineMeters(origin, point)));
}

export interface NearQuery {
  lat: number;
  lng: number;
  radiusM: number;
  limit: number;
  offset: number;
}

export function parseNearQuery(query: Record<string, unknown>): NearQuery {
  const origin = parseCoordinates(query.lat, query.lng);
  const radiusM = parseRadius(query.radius_m);
  const limit = Math.min(Math.max(Math.floor(Number(query.limit) || 200), 1), 500);
  const offset = Math.max(Math.floor(Number(query.skip ?? query.offset) || 0), 0);
  return { lat: origin.lat, lng: origin.lng, radiusM, limit, offset };
}

export interface NearResult {
  items: Data[];
  total: number;
  limit: number;
  offset: number;
  radius_m: number;
}

/** Radius filter, sorted by ascending distance with a stable id tiebreaker. */
export function nearHazards(rows: Data[], query: NearQuery): NearResult {
  const origin = { lat: query.lat, lng: query.lng };
  const matches = rows
    .map((row) => ({ row, distance: hazardDistanceMeters(row, origin) }))
    .filter((entry): entry is { row: Data; distance: number } => entry.distance !== null && entry.distance <= query.radiusM)
    .sort((a, b) => a.distance - b.distance || String(a.row.id).localeCompare(String(b.row.id)))
    .map((entry) => ({ ...entry.row, distance_m: Math.round(entry.distance) }));
  return {
    items: matches.slice(query.offset, query.offset + query.limit),
    total: matches.length,
    limit: query.limit,
    offset: query.offset,
    radius_m: query.radiusM,
  };
}

export interface PolygonResult {
  items: Data[];
  total: number;
  limit: number;
  offset: number;
}

export function inPolygonHazards(rows: Data[], area: GeoArea, query: { limit: number; offset: number }): PolygonResult {
  const matches = rows
    .filter((row) => hazardPoints(row).some((point) => areaContainsPoint(area, point)))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return {
    items: matches.slice(query.offset, query.offset + query.limit),
    total: matches.length,
    limit: query.limit,
    offset: query.offset,
  };
}
