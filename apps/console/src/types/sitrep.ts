// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
export type SitrepStatus = 'draft' | 'review_pending' | 'published' | 'archived';

export interface SitrepDelta {
  actor_id?: string;
  action_type: string;
  changes: Record<string, unknown>;
  created_at?: string;
}

export interface SitrepNumbers {
  casualties?: number;
  deaths?: number;
  injuries?: number;
  missing?: number;
  affected_people?: number;
  evacuated_people?: number;
  damaged_structures?: number;
  destroyed_structures?: number;
  rescued_people?: number;
  resources_deployed?: number;
}

export interface Sitrep {
  id: string;
  emergency_event_id: string;
  title: string;
  snapshot: Record<string, unknown>;
  deltas: SitrepDelta[];
  status: SitrepStatus;
  version?: number;
  author?: string;
  source?: string;
  reporting_period_start?: string | null;
  reporting_period_end?: string | null;
  numbers?: SitrepNumbers;
  amends_sitrep_id?: string | null;
  published_by?: string;
  published_at?: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SitrepCreateRequest {
  emergency_event_id: string;
  title: string;
  reporting_period_start: string;
  reporting_period_end: string;
  snapshot?: Record<string, unknown>;
  numbers?: SitrepNumbers;
  author?: string;
  source?: string;
  deltas?: SitrepDelta[];
  metadata?: Record<string, unknown>;
}

export interface SitrepUpdateRequest {
  title?: string;
  snapshot?: Record<string, unknown>;
  status?: SitrepStatus;
  metadata?: Record<string, unknown>;
}
