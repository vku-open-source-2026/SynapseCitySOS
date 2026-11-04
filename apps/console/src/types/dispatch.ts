// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
export type DispatchPriority = 'low' | 'medium' | 'high' | 'critical';

export type DispatchStatus =
  | 'pending'
  | 'assigned'
  | 'in_transit'
  | 'on_scene'
  | 'completed'
  | 'reassigned'
  | 'canceled';

export interface DispatchAssignment {
  /** Canonical SOS resource-unit id. */
  assigned_resource_unit_id?: string | null;
  /** Resource-unit id as stored on the assignment record. */
  resource_unit_id?: string | null;
  /** @deprecated Legacy wire alias; mirror of assigned_resource_unit_id. */
  assigned_user_id?: string | null;
  role?: string;
  quantity?: number;
  notes?: string;
  assigned_at?: string;
}

export interface DispatchOrder {
  id: string;
  emergency_event_id: string;
  eop_plan_id?: string;
  task_title: string;
  task_description?: string;
  target_location?: {
    type: string;
    coordinates: number[] | number[][] | number[][][];
  };
  priority: DispatchPriority;
  status: DispatchStatus;
  assignments: DispatchAssignment[];
  /** Canonical SOS resource-unit id assigned to this order. */
  assigned_resource_unit_id?: string | null;
  /** @deprecated Legacy wire alias; mirror of assigned_resource_unit_id. */
  assigned_user_id?: string | null;
  eta_minutes?: number;
  started_at?: string;
  completed_at?: string;
  assigned_by?: string;
  updated_by?: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DispatchOrderCreateRequest {
  emergency_event_id: string;
  eop_plan_id?: string;
  task_title: string;
  task_description?: string;
  target_location?: {
    type: string;
    coordinates: number[] | number[][] | number[][][];
  };
  priority?: DispatchPriority;
  assignments?: DispatchAssignment[];
  eta_minutes?: number;
  metadata?: Record<string, unknown>;
}

export interface DispatchOrderUpdateRequest {
  task_title?: string;
  task_description?: string;
  target_location?: {
    type: string;
    coordinates: number[] | number[][] | number[][][];
  };
  priority?: DispatchPriority;
  status?: DispatchStatus;
  assignments?: DispatchAssignment[];
  eta_minutes?: number;
  started_at?: string;
  completed_at?: string;
  metadata?: Record<string, unknown>;
}

export interface DispatchOptimizeRequest {
  max_orders?: number;
  force_reestimate_eta?: boolean;
}

export interface DispatchOptimizeResult {
  optimized: number;
  auto_assigned: number;
  stale_flagged: number;
  eta_reestimated: number;
  unassignable?: number;
  candidates?: number;
  algorithm: string;
  triggered_by: string;
  optimized_at: string;
}
