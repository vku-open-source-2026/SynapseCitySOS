// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Dependency-free RED metrics for the SOS service.
 *
 * Exposes request count/error/duration plus Tier-2 call latency in Prometheus
 * text format at `/metrics`. Logs are structured JSON with the correlation id
 * so an edge/proxy trace can be followed end to end.
 */
import type { NextFunction, Request, Response } from 'express';

interface RouteMetric {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

const routes = new Map<string, RouteMetric>();
const startedAt = Date.now();

export interface DependencySample {
  dependency: string;
  ok: boolean;
  durationMs: number;
  at: string;
  error?: string;
}

const dependencySamples: DependencySample[] = [];
const MAX_SAMPLES = 200;

interface CounterKey {
  name: string;
  labels: Record<string, string>;
}

const counters = new Map<string, { key: CounterKey; value: number }>();

export function incrementCounter(name: string, labels: Record<string, string> = {}): void {
  const key = `${name}|${JSON.stringify(labels)}`;
  const entry = counters.get(key) ?? { key: { name, labels }, value: 0 };
  entry.value += 1;
  counters.set(key, entry);
}

function renderLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([key, value]) => `${key}="${sanitize(value)}"`).join(',')}}`;
}

export function recordDependency(dependency: string, ok: boolean, durationMs: number, error?: string): void {
  dependencySamples.push({ dependency, ok, durationMs, at: new Date().toISOString(), ...(error ? { error } : {}) });
  if (dependencySamples.length > MAX_SAMPLES) dependencySamples.splice(0, dependencySamples.length - MAX_SAMPLES);
}

export function observeRequest(route: string, durationMs: number, status: number): void {
  const metric = routes.get(route) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
  metric.count += 1;
  metric.totalMs += durationMs;
  metric.maxMs = Math.max(metric.maxMs, durationMs);
  if (status >= 500) metric.errors += 1;
  routes.set(route, metric);
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_./{}-]/g, '_');
}

/** Normalise `/v1/emergency/123` to `/v1/emergency/{id}` to bound cardinality. */
export function routeLabel(req: Request): string {
  const path = (req.originalUrl.split('?')[0] || '/').replace(/\/[0-9a-f]{8,}/gi, '/{id}');
  const segments = path.split('/');
  if (segments.length > 4) return `${segments.slice(0, 4).join('/')}/*`;
  return path;
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  const label = routeLabel(req);
  const correlationId = res.getHeader('x-correlation-id')?.toString();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    observeRequest(label, durationMs, res.statusCode);
    const line = {
      level: res.statusCode >= 500 ? 'error' : 'info',
      service: 'synapsecity-sos',
      msg: 'request',
      method: req.method,
      path: label,
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
      correlation_id: correlationId,
    };
    console.log(JSON.stringify(line));
  });
  next();
}

export function renderMetrics(): string {
  const lines: string[] = [];
  lines.push('# HELP sos_request_total Total HTTP requests.');
  lines.push('# TYPE sos_request_total counter');
  lines.push('# HELP sos_request_errors_total Total 5xx responses.');
  lines.push('# TYPE sos_request_errors_total counter');
  lines.push('# HELP sos_request_duration_ms_sum Cumulative request duration.');
  lines.push('# TYPE sos_request_duration_ms_sum counter');
  lines.push('# HELP sos_request_duration_ms_max Maximum observed request duration.');
  lines.push('# TYPE sos_request_duration_ms_max gauge');
  for (const [route, metric] of routes) {
    const label = sanitize(route);
    lines.push(`sos_request_total{route="${label}"} ${metric.count}`);
    lines.push(`sos_request_errors_total{route="${label}"} ${metric.errors}`);
    lines.push(`sos_request_duration_ms_sum{route="${label}"} ${Math.round(metric.totalMs)}`);
    lines.push(`sos_request_duration_ms_max{route="${label}"} ${Math.round(metric.maxMs)}`);
  }
  lines.push('# HELP sos_tier2_calls_total Recent Tier-2 dependency calls.');
  lines.push('# TYPE sos_tier2_calls_total counter');
  const ok = dependencySamples.filter((sample) => sample.ok).length;
  const failed = dependencySamples.length - ok;
  lines.push(`sos_tier2_calls_total{dependency="synapsedx",result="ok"} ${ok}`);
  lines.push(`sos_tier2_calls_total{dependency="synapsedx",result="error"} ${failed}`);
  if (dependencySamples.length) {
    const durations = dependencySamples.map((sample) => Math.round(sample.durationMs));
    lines.push('# HELP sos_tier2_duration_ms Recent Tier-2 call latency.');
    lines.push('# TYPE sos_tier2_duration_ms gauge');
    lines.push(`sos_tier2_duration_ms{dependency="synapsedx",stat="last"} ${durations[durations.length - 1]}`);
    lines.push(`sos_tier2_duration_ms{dependency="synapsedx",stat="max"} ${Math.max(...durations)}`);
  }
  if (counters.size) {
    lines.push('# HELP sos_events_total Product-level counters (AI drafts, stream transport, conflicts).');
    lines.push('# TYPE sos_events_total counter');
    for (const { key, value } of counters.values()) {
      lines.push(`sos_${sanitize(key.name)}_total${renderLabels(key.labels)} ${value}`);
    }
  }
  lines.push('# HELP sos_uptime_seconds Process uptime.');
  lines.push('# TYPE sos_uptime_seconds gauge');
  lines.push(`sos_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`);
  return `${lines.join('\n')}\n`;
}

export function recentDependencySamples(): DependencySample[] {
  return [...dependencySamples];
}

export function resetMetrics(): void {
  routes.clear();
  dependencySamples.length = 0;
  counters.clear();
}
