// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
const API = 'https://sos.synapsecity.sbs/v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function get(path) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`${API}${path}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'SynapseSOS-Mobile-Contract/0.1' },
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      if ([429, 502, 503, 504].includes(response.status) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      return { response, body };
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
    }
  }
  throw lastError || new Error(`GET ${path} failed after retries`);
}

const product = await get('/sos');
assert(product.response.ok, `GET /sos expected 2xx, got ${product.response.status}`);
assert(product.body?.product === 'synapsecity-sos', 'GET /sos product mismatch');
assert(Array.isArray(product.body?.notOwned), 'GET /sos notOwned missing');
assert(product.body.notOwned.includes('city assets'), 'SOS boundary does not disclaim city assets');

const status = await get('/emergency/public/status');
assert(status.response.ok, `GET /emergency/public/status failed (${status.response.status})`);
assert(typeof status.body?.data_available === 'boolean', 'status.data_available missing');
assert(typeof status.body?.hazard_feed?.stale === 'boolean', 'status.hazard_feed.stale missing');
assert(typeof status.body?.hazard_feed?.status === 'string', 'status.hazard_feed.status missing');

const hazards = await get('/hazards?limit=300');
assert(hazards.response.ok, `GET /hazards failed (${hazards.response.status})`);
assert(Array.isArray(hazards.body), 'GET /hazards must return an array');
for (const hazard of hazards.body.slice(0, 10)) {
  assert(typeof hazard.id === 'string', 'hazard id missing');
  assert(typeof hazard.title === 'string', 'hazard title missing');
  assert(typeof hazard.severity === 'string', 'hazard severity missing');
  assert(typeof hazard.geometry?.type === 'string', 'hazard geometry missing');
}

const recent = await get('/hazards/recent?hours=72&limit=50');
assert(recent.response.ok, `GET /hazards/recent failed (${recent.response.status})`);
assert(Array.isArray(recent.body), 'GET /hazards/recent must return an array');

const events = await get('/emergency/public?limit=100');
assert(events.response.ok, `GET /emergency/public failed (${events.response.status})`);
assert(Array.isArray(events.body), 'GET /emergency/public must return an array');
for (const event of events.body.slice(0, 10)) {
  assert(typeof event.id === 'string', 'public event id missing');
  assert(typeof event.title === 'string', 'public event title missing');
  assert(typeof event.severity === 'string', 'public event severity missing');
  assert(event.contact_phone === undefined, 'public event leaked contact_phone');
  assert(event.assigned_resource_unit_id === undefined, 'public event leaked resource assignment');
}

const shelters = await get('/emergency/resources/shelters/near?lat=16.0544&lng=108.2022&radius_m=50000');
assert(shelters.response.ok, `GET shelters/near failed (${shelters.response.status})`);
assert(Array.isArray(shelters.body?.shelters), 'shelters response must contain shelters[]');
assert(typeof shelters.body?.radius_m === 'number', 'shelters radius_m missing');

const map = await get('/map/config');
assert(map.response.ok, `GET /map/config failed (${map.response.status})`);
assert(typeof map.body?.tileUrl === 'string', 'map tileUrl missing');
assert(map.body.tileUrl.includes('{z}'), 'map tile template is invalid');

const city = await get('/assets');
assert(city.response.status === 404, 'SOS gateway must not expose the City assets namespace');
assert(city.body?.error === 'not_found', 'SOS foreign namespace must return error=not_found');

const incident = await get('/incidents');
assert(incident.response.status === 404, 'SOS gateway must not expose city incidents');

console.log(
  JSON.stringify(
    {
      api: API,
      product: product.body.product,
      feed: status.body.hazard_feed.status,
      dataAvailable: status.body.data_available,
      hazards: hazards.body.length,
      recentHazards: recent.body.length,
      publicEvents: events.body.length,
      shelters: shelters.body.shelters.length,
      map: map.body.provider,
      boundary: 'ok',
    },
    null,
    2,
  ),
);
