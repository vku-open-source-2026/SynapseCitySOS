// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, expect, it } from 'vitest';
import { distanceMeters, firstPoint, formatDistance } from '../geo';
import { feedHealth } from '../feed';
import { hazardTypeLabel, normalizeSeverity, severityMeta } from '../format';
import { parseDeepLink } from '../deepLink';
import type { FeedStatus } from '../../api/types';

function feed(overrides: Partial<FeedStatus> = {}): FeedStatus {
  return {
    status: 'ok',
    data_available: true,
    checked_at: new Date().toISOString(),
    hazard_feed: {
      status: 'ready',
      configured: true,
      source: 'vndms',
      last_run_at: null,
      last_success_at: null,
      records_ingested: 0,
      records_rejected: 0,
      error: null,
      stale: false,
      feed_version: null,
      checked_at: new Date().toISOString(),
      stale_after_minutes: 60,
    },
    ...overrides,
  };
}

describe('feed health', () => {
  it('reports a healthy feed only when every condition passes', () => {
    expect(feedHealth(feed()).state).toBe('ok');
  });

  it('never reports ok when data is unavailable', () => {
    expect(feedHealth(feed({ data_available: false })).state).toBe('unknown');
  });

  it('never reports ok for a stale feed', () => {
    const status = feed();
    status.hazard_feed.stale = true;
    expect(feedHealth(status).state).toBe('unknown');
  });

  it('reports degraded for a degraded dependency', () => {
    expect(feedHealth(feed({ status: 'degraded' })).state).toBe('degraded');
  });

  it('reports unknown when there is no status', () => {
    expect(feedHealth(undefined).state).toBe('unknown');
  });
});

describe('geometry and distance', () => {
  it('extracts a point from a polygon geometry', () => {
    expect(firstPoint({ type: 'Polygon', coordinates: [[[108.2, 16.0], [108.3, 16.1]]] })).toEqual({
      longitude: 108.2,
      latitude: 16.0,
    });
  });

  it('computes a realistic distance', () => {
    const distance = distanceMeters(
      { latitude: 16, longitude: 108 },
      { latitude: 17, longitude: 108 },
    );
    expect(distance).toBeGreaterThan(110_000);
    expect(distance).toBeLessThan(112_500);
  });

  it('formats distance', () => {
    expect(formatDistance(400)).toBe('400 m');
    expect(formatDistance(2_500)).toBe('2.5 km');
    expect(formatDistance(105_000)).toBe('105 km');
  });
});

describe('labels', () => {
  it('maps hazard types and severity', () => {
    expect(hazardTypeLabel('flood')).toBe('Ngập lụt');
    expect(hazardTypeLabel('storm')).toBe('Bão / sóng lớn');
    expect(normalizeSeverity('critical')).toBe('critical');
    expect(normalizeSeverity('unknown')).toBe('medium');
    expect(severityMeta.critical.label).toBe('Nghiêm trọng');
  });
});

describe('deep links', () => {
  it('routes hazard and SOS links', () => {
    expect(parseDeepLink('synapsecitysos://hazard/abc')).toEqual({
      name: 'hazard',
      params: { id: 'abc' },
    });
    expect(parseDeepLink('synapsecitysos://sos')).toEqual({ name: 'emergency' });
    expect(parseDeepLink('synapsecitysos://shelters')).toEqual({ name: 'shelters' });
  });

  it('ignores unknown links', () => {
    expect(parseDeepLink('https://example.com')).toBeNull();
    expect(parseDeepLink(null)).toBeNull();
  });
});
