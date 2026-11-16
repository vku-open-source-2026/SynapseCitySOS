// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type HazardType =
  | 'flood'
  | 'storm'
  | 'landslide'
  | 'fire'
  | 'earthquake'
  | 'outage'
  | 'pollution'
  | 'drought'
  | 'traffic'
  | 'epidemic'
  | 'other';

export interface Coordinates {
  longitude: number;
  latitude: number;
}

export interface Geometry {
  type: string;
  coordinates: unknown;
}

export interface Hazard {
  id: string;
  hazard_id: string;
  title: string;
  description?: string;
  event_type: HazardType | string;
  severity: Severity;
  source: string;
  status?: string;
  is_active: boolean;
  geometry: Geometry;
  district?: string;
  ward?: string;
  provinces?: string[];
  url?: string;
  metadata?: Record<string, unknown>;
  detected_at?: string;
  published_at?: string;
  ingest_timestamp?: string;
  issued_at?: string;
  expires_at?: string;
  last_seen_at?: string;
  created_at: string;
  updated_at: string;
  distance_m?: number;
  linked_event_id?: string | null;
}

export interface PublicEmergencyEvent {
  id: string;
  title: string;
  event_type: string;
  severity: Severity;
  status: string;
  location?: {
    address?: string | null;
    ward?: string | null;
    district?: string | null;
    city?: string | null;
  } | null;
  geometry?: Geometry | null;
  started_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface FeedStatus {
  status: 'ok' | 'degraded' | string;
  data_available: boolean;
  checked_at: string;
  hazard_feed: {
    status: string;
    configured: boolean;
    source: string;
    last_run_at: string | null;
    last_success_at: string | null;
    records_ingested: number;
    records_rejected: number;
    error: string | null;
    stale: boolean;
    feed_version: string | null;
    checked_at: string;
    stale_after_minutes: number;
    records_visible?: number;
    connector?: Record<string, unknown>;
  };
}

export interface NearbyShelter {
  id: string;
  name: string;
  resource_code: string | null;
  district: string | null;
  ward: string | null;
  capacity: number | null;
  capacity_unit: string | null;
  status: string | null;
  contact_phone: string | null;
  current_location: Geometry | null;
  distance_m: number;
}

export interface SheltersResponse {
  shelters: NearbyShelter[];
  radius_m: number;
  total: number;
}

export interface MapConfig {
  provider: string;
  tileUrl: string;
  attribution: string;
  maxZoom: number;
  maxNativeZoom: number;
  style?: string;
}

export interface ProductInfo {
  product: string;
  domain: string;
  publicUrl: string;
  features: string[];
  notOwned: string[];
  datasets: string[];
  dependency?: Record<string, unknown> | string;
  limitations?: Record<string, string>;
  auth?: Record<string, unknown>;
}

export interface AuthUser {
  id: string;
  email: string;
  full_name: string;
  role: string;
  permissions?: string[];
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: AuthUser;
}

export interface SosEvent {
  id: string;
  event_code?: string;
  title: string;
  description?: string;
  event_type: string;
  severity: Severity;
  status: string;
  location?: {
    address?: string;
    ward?: string;
    district?: string;
    city?: string;
    geometry?: Geometry;
  };
  instructions?: string[];
  started_at?: string;
  created_at: string;
  updated_at: string;
}
