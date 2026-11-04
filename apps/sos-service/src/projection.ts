// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Public projection adapter.
 *
 * Public SOS surfaces must read the Tier-2 publication API
 * (`datasets.entities`, backed by SynapseLDS) rather than the private records
 * API. That is what enforces dataset publication state and public attribute
 * visibility. This module maps the NGSI-LD entity shape to the flat SOS wire
 * records the console already consumes.
 *
 * Limitation: Tier-2 currently exposes only `limit`/`offset` and no status
 * predicate on the publication endpoint, so terminal emergency statuses are
 * filtered after the page is read. That remains tracked in SOS issue #19.
 */
import type { Data } from './filters';

function isDescriptor(value: unknown): value is { type?: string; value?: unknown; object?: unknown } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (('value' in (value as Data)) || ('object' in (value as Data)))
    && typeof (value as Data).type === 'string';
}

/** Flatten one NGSI-LD entity into a plain SOS record. */
export function fromNgsiLd(entity: unknown): Data | null {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return null;
  const source = entity as Data;
  if (!source.id && !source.entityId) return null;
  const output: Data = {
    id: String(source.id ?? source.entityId),
  };
  for (const [key, value] of Object.entries(source)) {
    if (key === '@context' || key === 'id' || key === 'type') continue;
    if (isDescriptor(value)) {
      if (value.type === 'GeoProperty') output[key] = value.value;
      else if (value.type === 'Relationship') output[key] = value.object ?? value.value ?? null;
      else output[key] = value.value;
    } else {
      output[key] = value;
    }
  }
  if (source.type && !output.entity_type) output.entity_type = source.type;
  return output;
}

export function fromNgsiLdList(entities: unknown[]): Data[] {
  return entities.map(fromNgsiLd).filter((entity): entity is Data => entity !== null);
}
