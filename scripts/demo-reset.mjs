#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Reset the SOS OLP 2026 demo records (issue #25). */
const base = (process.env.SOS_API_URL || 'http://127.0.0.1:8084').replace(/\/$/, '');
const token = process.env.SOS_DEMO_TOKEN || '';

async function api(method, path) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { status: response.status, body: payload };
}

async function main() {
  const ids = [
    ['/v1/emergency/dispatch', 'SOS-DEMO-DISPATCH'],
    ['/v1/emergency/eop', 'SOS-DEMO-EOP'],
    ['/v1/emergency/sitrep', 'SOS-DEMO-SITREP'],
    ['/v1/emergency/after-action', 'SOS-DEMO-AAR'],
    ['/v1/emergency/resources', 'SOS-DEMO-AMB-1'],
    ['/v1/hazards', 'SOS-DEMO-HAZARD'],
    ['/v1/emergency', 'SOS-DEMO-EVENT'],
  ];
  let removed = 0;
  for (const [path, id] of ids) {
    const result = await api('DELETE', `${path}/${encodeURIComponent(id)}`);
    if (result.status < 300) removed++;
  }
  console.log(`Demo reset: ${removed} records removed.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
