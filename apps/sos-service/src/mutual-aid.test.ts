// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Mutual-aid semantics (#23) and SOS HITL policy helpers (#24). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertRequestVersion, duplicateRequest, publicMutualAidProjection, validateAccept, validateRequest,
  type MutualAidRequest,
} from './mutual-aid';
import { approverRolesFor, hitlRequired } from './hitl';

const request: MutualAidRequest = {
  id: 'ma-1', request_number: 'MA-1', resource_type: 'ambulance', quantity: 10, filled_quantity: 2,
  location: { latitude: 21.0278, longitude: 105.8342, address: '12 Main Street, Hanoi', city: 'Hanoi' },
  urgency: 'high', contact: { name: 'Duty officer', phone: '0900000000', email: 'duty@example.com', agency: 'Partner EMS' },
  requesting_agency: 'Partner EMS', status: 'partially_filled', history: [],
  created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
};

test('mutual-aid requests validate required capacity fields and dedupe retries', () => {
  const valid = validateRequest({
    resource_type: 'ambulance', quantity: 10, requesting_agency: 'Partner EMS',
    location: { city: 'Hanoi' }, urgency: 'high',
  });
  assert.equal(valid.ok, true);
  if (valid.ok) assert.equal(valid.value.filled_quantity, 0);

  assert.equal(validateRequest({ quantity: 10, requesting_agency: 'x' }).ok, false);
  assert.equal(validateRequest({ resource_type: 'ambulance', quantity: 0, requesting_agency: 'x' }).ok, false);
  assert.equal(validateRequest({ resource_type: 'ambulance', quantity: 1 }).ok, false);

  assert.equal(duplicateRequest([request as any], 'MA-1')?.id, 'ma-1');
  assert.equal(duplicateRequest([request as any], 'MA-2'), null);
});

test('partial fills update only the accepted quantity and never exceed capacity', () => {
  const partial = validateAccept(request, { unit_id: 'unit-1', accepted_quantity: 3, eta_minutes: 20 }, { status: 'available', available_quantity: 5 });
  assert.equal(partial.remaining, 8);
  assert.equal(partial.available, 5);

  assert.throws(() => validateAccept(request, { unit_id: 'unit-1', accepted_quantity: 9 }, { available_quantity: 20 }), (error: any) => error.code === 'quantity_exceeds_request');
  assert.throws(() => validateAccept(request, { unit_id: 'unit-1', accepted_quantity: 1 }, { status: 'offline' }), (error: any) => error.code === 'resource_unit_unavailable');
  assert.throws(() => validateAccept(request, { unit_id: 'unit-1', accepted_quantity: 4 }, { available_quantity: 2 }), (error: any) => error.code === 'insufficient_capacity');
  assert.throws(() => validateAccept({ ...request, status: 'filled' }, { unit_id: 'unit-1', accepted_quantity: 1 }, {}), (error: any) => error.code === 'request_not_open');
});

test('optimistic versions reject the second accept in a race', () => {
  const current = { ...request, record_version: 4 };
  assert.doesNotThrow(() => assertRequestVersion(current, 4));
  assert.throws(() => assertRequestVersion(current, 3), (error: any) => error.status === 409 && error.code === 'request_version_conflict');
});

test('public mutual-aid projection removes contact, agency and precise coordinates', () => {
  const projection = publicMutualAidProjection(request);
  assert.equal(projection.contact, undefined);
  assert.equal(projection.requesting_agency, undefined);
  const location = projection.location as Record<string, unknown>;
  assert.equal(location.latitude, undefined);
  assert.equal(location.longitude, undefined);
  assert.equal(location.city, 'Hanoi');
  assert.equal(location.area, '12 Main Street');
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes('0900000000'), false);
  assert.equal(serialized.includes('duty@example.com'), false);
  assert.equal(serialized.includes('Partner EMS'), false);
});

test('SOS approver roles are server-derived per action, not client input', () => {
  assert.deepEqual(approverRolesFor('dispatch.assign'), ['incident-commander', 'duty-manager']);
  assert.deepEqual(approverRolesFor('eop.approve'), ['incident-commander', 'duty-manager']);
  const previous = process.env.SOS_DISPATCH_APPROVER_ROLES;
  process.env.SOS_DISPATCH_APPROVER_ROLES = 'shift-supervisor';
  try {
    assert.deepEqual(approverRolesFor('dispatch.assign'), ['shift-supervisor']);
  } finally {
    if (previous === undefined) delete process.env.SOS_DISPATCH_APPROVER_ROLES;
    else process.env.SOS_DISPATCH_APPROVER_ROLES = previous;
  }
  const required = process.env.SOS_HITL_REQUIRED;
  process.env.SOS_HITL_REQUIRED = 'true';
  assert.equal(hitlRequired(), true);
  if (required === undefined) delete process.env.SOS_HITL_REQUIRED;
  else process.env.SOS_HITL_REQUIRED = required;
});
