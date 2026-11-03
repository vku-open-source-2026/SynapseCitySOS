// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, expect, it } from 'vitest';
import { asList, isNonListPayload } from './asList';

describe('asList', () => {
  it('returns an empty array for an HTML 200 response', () => {
    expect(asList('<!doctype html><html><body>console</body></html>')).toEqual([]);
  });

  it('returns an empty array for non-list objects and nullish values', () => {
    expect(asList({ message: 'not a list' })).toEqual([]);
    expect(asList(null)).toEqual([]);
    expect(asList(undefined)).toEqual([]);
    expect(asList(42)).toEqual([]);
  });

  it('passes a bare array through', () => {
    expect(asList([{ id: 'a' }])).toEqual([{ id: 'a' }]);
  });

  it('unwraps data, items and results envelopes', () => {
    expect(asList({ data: [1, 2] })).toEqual([1, 2]);
    expect(asList({ items: [3] })).toEqual([3]);
    expect(asList({ results: ['x'] })).toEqual(['x']);
  });

  it('detects a non-list payload so callers can show an error state', () => {
    expect(isNonListPayload('<!doctype html>')).toBe(true);
    expect(isNonListPayload({ message: 'error' })).toBe(true);
    expect(isNonListPayload([])).toBe(false);
    expect(isNonListPayload({ data: [] })).toBe(false);
    expect(isNonListPayload(null)).toBe(false);
  });
});
