// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { createRateLimiter } from './rate-limit';

function fakeRequest(ip = '1.2.3.4'): Request {
  return {
    ip,
    socket: { remoteAddress: ip },
    header: () => undefined,
  } as unknown as Request;
}

function fakeResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown = null;
  const response = {
    setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
    status: (code: number) => { statusCode = code; return response; },
    json: (payload: unknown) => { body = payload; return response; },
  } as unknown as Response;
  return { response, headers, status: () => statusCode, body: () => body };
}

test('rate limiter returns 429 with Retry-After after the burst', () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({ name: 'test', windowMs: 10_000, max: 3, now: () => clock });
  for (let i = 0; i < 3; i += 1) {
    const res = fakeResponse();
    let nextCalled = false;
    limiter.middleware(fakeRequest(), res.response, (() => { nextCalled = true; }) as NextFunction);
    assert.equal(nextCalled, true, `request ${i + 1} should pass`);
    assert.equal(res.headers['x-ratelimit-remaining'], String(2 - i));
  }
  const blocked = fakeResponse();
  let nextCalled = false;
  limiter.middleware(fakeRequest(), blocked.response, (() => { nextCalled = true; }) as NextFunction);
  assert.equal(nextCalled, false);
  assert.equal(blocked.status(), 429);
  assert.equal(blocked.headers['retry-after'], '10');
  assert.equal((blocked.body() as Record<string, unknown>).error, 'rate_limited');

  clock += 10_001;
  const afterWindow = fakeResponse();
  let allowed = false;
  limiter.middleware(fakeRequest(), afterWindow.response, (() => { allowed = true; }) as NextFunction);
  assert.equal(allowed, true);
});

test('rate limiter is per client key', () => {
  let clock = 1_000_000;
  const limiter = createRateLimiter({ name: 'test-key', windowMs: 10_000, max: 1, now: () => clock });
  const first = fakeResponse();
  limiter.middleware(fakeRequest('1.1.1.1'), first.response, (() => undefined) as NextFunction);
  const second = fakeResponse();
  let allowed = false;
  limiter.middleware(fakeRequest('2.2.2.2'), second.response, (() => { allowed = true; }) as NextFunction);
  assert.equal(allowed, true);
  assert.equal(limiter.size(), 2);
});
