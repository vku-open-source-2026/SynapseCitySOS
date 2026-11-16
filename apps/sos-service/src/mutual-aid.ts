// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Mutual-aid request semantics (issue #23). SOS owns the request/accept/
 * decline/handoff state machine; partner agencies integrate through the public
 * SOS boundary only. No City API or shared database is used.
 */
export type MutualAidStatus = 'open' | 'partially_filled' | 'filled' | 'declined' | 'handed_off';

export interface MutualAidRequest {
  id: string;
  request_number: string;
  resource_type: string;
  quantity: number;
  filled_quantity: number;
  location: { latitude?: number; longitude?: number; address?: string; city?: string; [key: string]: unknown };
  urgency: 'low' | 'medium' | 'high' | 'critical';
  contact: { name?: string; phone?: string; email?: string; agency?: string };
  requesting_agency: string;
  status: MutualAidStatus;
  notes?: string;
  history: Array<Record<string, unknown>>;
  created_at: string;
  updated_at: string;
  created_by?: string;
}

export interface MutualAidAccept {
  unit_id: string;
  accepted_quantity: number;
  eta_minutes?: number;
  contact?: Record<string, unknown>;
  expected_version?: number;
}

/** Optimistic-concurrency guard used by the accept route. */
export function assertRequestVersion(request: { record_version?: number }, expected?: number): void {
  if (expected === undefined) return;
  if (Number(request.record_version || 0) !== Number(expected)) {
    throw Object.assign(new Error('request_version_conflict'), { status: 409, code: 'request_version_conflict' });
  }
}

/** Stable duplicate detection for partner retries. */
export function duplicateRequest(rows: Array<Record<string, unknown>>, requestNumber: string): Record<string, unknown> | null {
  return rows.find((row) => String(row.request_number || '') === String(requestNumber)) || null;
}

export function validUrgency(value: unknown): MutualAidRequest['urgency'] {
  return ['low', 'medium', 'high', 'critical'].includes(String(value)) ? String(value) as MutualAidRequest['urgency'] : 'medium';
}

export function validateRequest(input: Record<string, unknown>): { ok: true; value: Omit<MutualAidRequest, 'id' | 'status' | 'history' | 'created_at' | 'updated_at'> } | { ok: false; error: string } {
  const resourceType = String(input.resource_type || '').trim();
  if (!resourceType || resourceType.length > 100) return { ok: false, error: 'resource_type_required' };
  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) return { ok: false, error: 'invalid_quantity' };
  const agency = String(input.requesting_agency || '').trim();
  if (!agency || agency.length > 200) return { ok: false, error: 'requesting_agency_required' };
  const location = input.location && typeof input.location === 'object' && !Array.isArray(input.location)
    ? input.location as MutualAidRequest['location'] : {};
  const contact = input.contact && typeof input.contact === 'object' && !Array.isArray(input.contact)
    ? input.contact as MutualAidRequest['contact'] : {};
  return {
    ok: true,
    value: {
      request_number: String(input.request_number || `MA-${Date.now().toString(36).toUpperCase()}`).slice(0, 64),
      resource_type: resourceType,
      quantity,
      filled_quantity: 0,
      location,
      urgency: validUrgency(input.urgency),
      contact,
      requesting_agency: agency,
      ...(input.notes ? { notes: String(input.notes).slice(0, 2000) } : {}),
    } as any,
  };
}

/** Validate a partial/full fill against the request and the lending unit. */
export function validateAccept(request: MutualAidRequest, input: MutualAidAccept, unit: Record<string, unknown>): { remaining: number; available: number } {
  if (!['open', 'partially_filled'].includes(request.status)) throw Object.assign(new Error('request_not_open'), { status: 409, code: 'request_not_open' });
  if (!String(input.unit_id || '').trim()) throw Object.assign(new Error('unit_id_required'), { status: 400, code: 'unit_id_required' });
  const accepted = Number(input.accepted_quantity);
  const remaining = Math.max(0, request.quantity - request.filled_quantity);
  if (!Number.isFinite(accepted) || accepted <= 0) throw Object.assign(new Error('invalid_accepted_quantity'), { status: 400, code: 'invalid_accepted_quantity' });
  if (accepted > remaining) throw Object.assign(new Error('quantity_exceeds_request'), { status: 409, code: 'quantity_exceeds_request', details: { remaining } });
  if (['offline', 'maintenance'].includes(String(unit.status || ''))) throw Object.assign(new Error('resource_unit_unavailable'), { status: 409, code: 'resource_unit_unavailable' });
  const available = Number(unit.available_quantity ?? unit.capacity ?? unit.quantity ?? accepted);
  if (Number.isFinite(available) && accepted > available) {
    throw Object.assign(new Error('insufficient_capacity'), { status: 409, code: 'insufficient_capacity', details: { available } });
  }
  return { remaining, available: Number.isFinite(available) ? available : accepted };
}

/** Public status projection: no contact, agency detail or precise coordinates. */
export function publicMutualAidProjection(request: MutualAidRequest): Record<string, unknown> {
  return {
    id: request.id,
    request_number: request.request_number,
    resource_type: request.resource_type,
    quantity: request.quantity,
    filled_quantity: request.filled_quantity,
    remaining_quantity: Math.max(0, request.quantity - request.filled_quantity),
    status: request.status,
    urgency: request.urgency,
    location: {
      ...(request.location?.city ? { city: request.location.city } : {}),
      ...(request.location?.address ? { area: String(request.location.address).split(',')[0].slice(0, 120) } : {}),
    },
    updated_at: request.updated_at,
  };
}
