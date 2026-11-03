// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { app } from './server';

type SosMetadata = {
  product: string;
  domain: string;
  publicUrl: string;
  features: string[];
  notOwned: string[];
  datasets: string[];
  dependency: { product: string; tier: number; publicUrl: string; sdk: string };
};

let server: Server;
let baseUrl: string;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('GET /v1/sos advertises emergency-only ownership', async () => {
  const response = await fetch(`${baseUrl}/v1/sos`);
  assert.equal(response.status, 200);
  const metadata = (await response.json()) as SosMetadata;

  assert.equal(metadata.product, 'synapsecity-sos');
  assert.equal(metadata.domain, 'emergency-operations');
  assert.equal(metadata.publicUrl, 'https://sos.synapsecity.sbs');
  for (const feature of ['hazards', 'emergency events', 'EOP', 'dispatch', 'resource units', 'SITREP', 'AAR', 'live hazard stream', 'command centre', 'public hazard map']) {
    assert.ok(metadata.features.includes(feature), `missing feature: ${feature}`);
  }
  for (const foreign of ['city assets', 'city incidents', 'IoT', 'maintenance', 'infrastructure alerts', 'budgets', 'operational reports', 'geofences', 'ingest', 'technician portal']) {
    assert.ok(metadata.notOwned.includes(foreign), `missing notOwned entry: ${foreign}`);
  }
  assert.equal(metadata.dependency.product, 'synapsedx');
  assert.equal(metadata.dependency.tier, 2);
  assert.equal(metadata.dependency.sdk, '@synapsedx/capabilities');

  assert.ok(metadata.datasets.length > 0);
  for (const dataset of metadata.datasets) {
    assert.match(dataset, /^sos-/, `foreign dataset leaked into SOS metadata: ${dataset}`);
    assert.ok(!dataset.startsWith('city-'));
  }
});

test('foreign SynapseCity namespaces return 404 JSON', async () => {
  const foreignPaths = [
    '/v1/assets',
    '/v1/assets/asset-1',
    '/v1/incidents',
    '/v1/incidents/incident-1',
    '/v1/iot/sensors',
    '/v1/budgets',
    '/v1/notifications',
    '/v1/users',
    '/v1/city',
    '/v1/public/assets',
    '/v1/public/assets/asset-1',
    '/v1/public/incidents',
    '/v1/maintenance',
    '/v1/alerts',
    '/v1/reports',
    '/v1/geofences',
    '/v1/ingest',
  ];

  for (const path of foreignPaths) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must return 404`);
    assert.deepEqual(await response.json(), { error: 'not_found', product: 'synapsecity-sos' }, `${path} must return the SOS not-found body`);
  }
});

test('encoded, uppercase and trailing-slash variants cannot bypass the SOS guard', async () => {
  const bypasses = [
    '/v1/ASSETS',
    '/v1/Assets/',
    '/v1/%61ssets',
    '/v1/incidents%2F1',
    '/v1/public/%61ssets',
    '/v1/city/',
    '/v1/%63ity',
    '/v1/users/',
    '/%76%31/assets',
  ];

  for (const path of bypasses) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must not bypass the SOS boundary`);
    assert.deepEqual(await response.json(), { error: 'not_found', product: 'synapsecity-sos' }, `${path} must return the SOS not-found body`);
  }
});

test('unknown /v1 namespaces fall back to 404 JSON', async () => {
  for (const path of ['/v1', '/v1/unknown', '/v1/public/unknown', '/v1/not-an-sos-namespace']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must return 404`);
    assert.deepEqual(await response.json(), { error: 'not_found', product: 'synapsecity-sos' }, `${path} must return the SOS not-found body`);
  }
});

test('owned map configuration still responds', async () => {
  const response = await fetch(`${baseUrl}/v1/map/config`);
  assert.equal(response.status, 200);
  const config = (await response.json()) as { provider: string; tileUrl: string };
  assert.ok(config.provider);
  assert.ok(config.tileUrl);
});
