// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromNgsiLd, fromNgsiLdList } from './projection';

test('NGSI-LD entities flatten to the SOS wire record', () => {
  const record = fromNgsiLd({
    id: 'urn:ngsi-ld:EmergencyEvent:e1',
    type: 'EmergencyEvent',
    title: { type: 'Property', value: 'Flood' },
    severity: { type: 'Property', value: 'high' },
    geometry: { type: 'GeoProperty', value: { type: 'Point', coordinates: [108, 16] } },
    linked: { type: 'Relationship', object: 'urn:ngsi-ld:Hazard:h1' },
    '@context': ['https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context-v1.9.jsonld'],
  });
  assert.deepEqual(record, {
    id: 'urn:ngsi-ld:EmergencyEvent:e1',
    title: 'Flood',
    severity: 'high',
    geometry: { type: 'Point', coordinates: [108, 16] },
    linked: 'urn:ngsi-ld:Hazard:h1',
    entity_type: 'EmergencyEvent',
  });
});

test('plain records pass through and invalid entries are dropped', () => {
  assert.deepEqual(fromNgsiLd({ id: 'plain', title: 'ok' }), { id: 'plain', title: 'ok' });
  assert.equal(fromNgsiLd(null), null);
  assert.equal(fromNgsiLd([]), null);
  assert.equal(fromNgsiLd({ title: 'no id' }), null);
  assert.deepEqual(fromNgsiLdList([{ id: 'a' }, null, { id: 'b' }]).map((row) => row.id), ['a', 'b']);
});
