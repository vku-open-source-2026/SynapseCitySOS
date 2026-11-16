#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Idempotent SOS OLP 2026 demo seed (issue #25). */
const base = (process.env.SOS_API_URL || 'http://127.0.0.1:8084').replace(/\/$/, '');
const token = process.env.SOS_DEMO_TOKEN || '';

async function api(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { status: response.status, body: payload };
}

async function upsert(path, id, payload) {
  const current = await api('GET', `${path}/${encodeURIComponent(id)}`);
  if (current.status === 200) {
    const updated = await api('PUT', `${path}/${encodeURIComponent(id)}`, payload);
    return { id, status: updated.status, updated: true };
  }
  const created = await api('POST', path, { id, ...payload });
  return { id, status: created.status, updated: false };
}

async function main() {
  const health = await api('GET', '/health');
  if (health.status !== 200) { console.error(`SOS API is not healthy at ${base}`); process.exit(1); }

  const event = await upsert('/v1/emergency', 'SOS-DEMO-EVENT', {
    title: 'Demo river flood', event_type: 'flood', status: 'monitoring', severity: 'high',
    description: 'DX-Lab demonstration event. Public projection only.',
    instructions: ['Avoid the riverbank', 'Follow official evacuation routes'],
  });
  console.log(`${event.updated ? 'updated' : 'created'} event SOS-DEMO-EVENT`);

  const hazard = await upsert('/v1/hazards', 'SOS-DEMO-HAZARD', {
    title: 'Demo flood hazard', event_type: 'flood', severity: 'high', is_active: true,
    geometry: { type: 'Point', coordinates: [105.8342, 21.0278] }, source: 'dx-lab-demo',
  });
  console.log(`${hazard.updated ? 'updated' : 'created'} hazard SOS-DEMO-HAZARD`);

  const resource = await upsert('/v1/emergency/resources', 'SOS-DEMO-AMB-1', {
    name: 'Demo Ambulance 1', resource_type: 'ambulance', resource_code: 'DEMO-AMB-1',
    status: 'available', capacity: 4, available_quantity: 4,
    current_location: { type: 'Point', coordinates: [105.8400, 21.0300] },
    contact: { agency: 'Demo EMS', phone: '0900000001' },
  });
  console.log(`${resource.updated ? 'updated' : 'created'} resource SOS-DEMO-AMB-1`);

  const dispatch = await upsert('/v1/emergency/dispatch', 'SOS-DEMO-DISPATCH', {
    emergency_event_id: 'SOS-DEMO-EVENT', title: 'Demo dispatch: medical support',
    priority: 'high', status: 'pending', resource_type: 'ambulance', quantity: 1,
  });
  console.log(`${dispatch.updated ? 'updated' : 'created'} dispatch SOS-DEMO-DISPATCH`);

  const eop = await upsert('/v1/emergency/eop', 'SOS-DEMO-EOP', {
    emergency_event_id: 'SOS-DEMO-EVENT', title: 'Demo flood EOP', version: 1, status: 'review_pending',
    summary: 'Demo emergency operations plan.', markdown_body: '# Demo Flood EOP\n\n1. Activate incident command.\n2. Warn the public.\n3. Dispatch resources after HITL approval.',
  });
  console.log(`${eop.updated ? 'updated' : 'created'} EOP SOS-DEMO-EOP`);
  console.log('Demo seed complete. Follow docs/DEMO_PACK.md.');
}

main().catch((error) => { console.error(error); process.exit(1); });
