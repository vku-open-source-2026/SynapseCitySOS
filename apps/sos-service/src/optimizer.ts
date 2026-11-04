// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Deterministic dispatch assignment.
 *
 * This is Tier-3 business logic (matching a task to an emergency resource unit)
 * persisted through the Tier-2 records API. It deliberately does not call a
 * routing provider: ETA is a documented straight-line estimate until the
 * Tier-2 routing/ETA capability exists. The optimizer never invents work: the
 * returned counts are exactly the records it changed.
 */
import { haversineMeters, type LatLng } from './geo';
import type { Data } from './filters';

export const DEFAULT_STALE_MINUTES = 120;
const AVERAGE_RESPONSE_KMH = 35;
const BASE_DISPATCH_MINUTES = 5;

const TERMINAL = new Set(['completed', 'canceled', 'rejected']);

export interface AssignmentDecision {
  order_id: string;
  resource_unit_id: string;
  eta_minutes: number;
  distance_km: number | null;
  reason: string;
}

export interface OptimizePlan {
  assignments: AssignmentDecision[];
  stale: string[];
  unassignable: string[];
  skipped_terminal: string[];
  used_resources: string[];
}

function coordinatesOf(value: unknown): LatLng | null {
  if (!value || typeof value !== 'object') return null;
  const geometry = value as { type?: unknown; coordinates?: unknown };
  if (geometry.type === 'Point' && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
    const lng = Number(geometry.coordinates[0]);
    const lat = Number(geometry.coordinates[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }
  return null;
}

export function requiredCapability(order: Data): string {
  const metadata = (order.metadata as Data | undefined) ?? {};
  return String(order.required_capability ?? metadata.required_capability ?? 'personnel').toLowerCase();
}

export function resourceTypesForCapability(capability: string): string[] {
  switch (capability) {
    case 'personnel': return ['personnel'];
    case 'vehicle': return ['vehicle', 'personnel'];
    case 'medical':
    case 'medical_supply': return ['medical_supply', 'personnel'];
    case 'rescue':
    case 'rescue_equipment': return ['rescue_equipment', 'vehicle'];
    case 'shelter': return ['shelter'];
    case 'communications': return ['personnel', 'vehicle'];
    case 'any': return ['personnel', 'vehicle', 'medical_supply', 'rescue_equipment', 'shelter'];
    default: return ['personnel'];
  }
}

function resourceEligible(resource: Data, capability: string, used: Set<string>, orderDistrict: string): boolean {
  const id = String(resource.id);
  if (used.has(id)) return false;
  const status = String(resource.status ?? 'available');
  // Never auto-assign a unit that is offline, under maintenance, or already deployed.
  if (status !== 'available') return false;
  const type = String(resource.resource_type ?? '');
  if (!resourceTypesForCapability(capability).includes(type)) return false;
  // A shelter is a fixed facility; do not send it to an unrelated district.
  if (type === 'shelter' && orderDistrict && String(resource.district ?? '') && String(resource.district) !== orderDistrict) {
    return false;
  }
  return true;
}

function scoreResource(resource: Data, order: Data, distanceMeters: number | null): number {
  let score = 0;
  const orderDistrict = String(order.district ?? (order.target_location as Data | undefined)?.district ?? '');
  const orderWard = String(order.ward ?? '');
  if (orderDistrict && String(resource.district ?? '') === orderDistrict) score += 20;
  if (orderWard && String(resource.ward ?? '') === orderWard) score += 10;
  if (distanceMeters !== null) score += Math.max(0, 15 - distanceMeters / 1000);
  const capacity = Number(resource.capacity);
  if (Number.isFinite(capacity)) score += Math.min(5, capacity / 100);
  const type = String(resource.resource_type ?? '');
  if (type === String(order.required_resource_type ?? '')) score += 5;
  return score;
}

function etaFor(resource: Data, order: Data, distanceMeters: number | null): number {
  if (distanceMeters !== null) {
    return Math.max(1, Math.round(BASE_DISPATCH_MINUTES + (distanceMeters / 1000 / AVERAGE_RESPONSE_KMH) * 60));
  }
  const sameDistrict = String(resource.district ?? '') && String(resource.district) === String(order.district ?? '');
  const sameWard = String(resource.ward ?? '') && String(resource.ward) === String(order.ward ?? '');
  return sameWard ? 10 : sameDistrict ? 20 : 45;
}

export function planOptimization(orders: Data[], resources: Data[], options: { nowMs?: number; staleMinutes?: number } = {}): OptimizePlan {
  const nowMs = options.nowMs ?? Date.now();
  const staleMinutes = options.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const used = new Set<string>();
  const assignments: AssignmentDecision[] = [];
  const stale: string[] = [];
  const unassignable: string[] = [];
  const skippedTerminal: string[] = [];

  const openOrders = orders.filter((order) => !TERMINAL.has(String(order.status ?? 'pending')));
  // Highest priority first, then oldest first, then id for determinism.
  const priorityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...openOrders].sort((a, b) => {
    const pa = priorityRank[String(a.priority ?? 'medium')] ?? 2;
    const pb = priorityRank[String(b.priority ?? 'medium')] ?? 2;
    if (pa !== pb) return pa - pb;
    const ta = Date.parse(String(a.created_at ?? '')) || 0;
    const tb = Date.parse(String(b.created_at ?? '')) || 0;
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });

  for (const order of orders) {
    if (TERMINAL.has(String(order.status ?? 'pending'))) skippedTerminal.push(String(order.id));
  }

  for (const order of sorted) {
    const orderId = String(order.id);
    const existingAssignment = order.assigned_resource_unit_id
      ?? (Array.isArray(order.assignments) ? (order.assignments as Data[]).map((item) => item.assigned_resource_unit_id ?? item.resource_unit_id).find(Boolean) : null);
    if (existingAssignment) {
      // Already assigned: keep it, but still count it as used so a second
      // order cannot steal the same unit in the same optimization run.
      used.add(String(existingAssignment));
      continue;
    }
    const capability = requiredCapability(order);
    const orderDistrict = String(order.district ?? (order.target_location as Data | undefined)?.district ?? '');
    const orderPoint = coordinatesOf(order.target_location);
    const candidates = resources
      .filter((resource) => resourceEligible(resource, capability, used, orderDistrict))
      .map((resource) => {
        const resourcePoint = coordinatesOf(resource.current_location);
        const distance = orderPoint && resourcePoint ? haversineMeters(orderPoint, resourcePoint) : null;
        return { resource, distance, score: scoreResource(resource, order, distance) };
      })
      .sort((a, b) => b.score - a.score || String(a.resource.id).localeCompare(String(b.resource.id)));

    const chosen = candidates[0];
    if (!chosen) {
      unassignable.push(orderId);
      const createdAt = Date.parse(String(order.created_at ?? ''));
      if (Number.isFinite(createdAt) && nowMs - createdAt > staleMinutes * 60 * 1000) stale.push(orderId);
      continue;
    }
    const resourceId = String(chosen.resource.id);
    used.add(resourceId);
    assignments.push({
      order_id: orderId,
      resource_unit_id: resourceId,
      eta_minutes: etaFor(chosen.resource, order, chosen.distance),
      distance_km: chosen.distance === null ? null : Math.round((chosen.distance / 1000) * 10) / 10,
      reason: chosen.distance === null ? 'district-and-capability-match' : 'nearest-compatible-unit',
    });
  }

  return {
    assignments,
    stale,
    unassignable,
    skipped_terminal: skippedTerminal,
    used_resources: [...used],
  };
}
