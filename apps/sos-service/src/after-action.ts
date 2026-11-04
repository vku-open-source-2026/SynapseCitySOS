// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * After-action report (AAR) KPI engine.
 *
 * All inputs are SOS records loaded through the Tier-2 records API. The formula
 * is deterministic and documented here and in README.md:
 *
 *   response_time_minutes = first assigned dispatch (or event end) - event start
 *   response_speed_score  = severity SLA band → 100/80/60/40/20/0
 *   dispatch_completion   = completed / (created - canceled) × 100
 *   sitrep_coverage       = published SITREPs / ceil(duration_hours / 6) × 100
 *   resource_efficiency   = unique assigned units / (available + assigned) × 100
 *   overall_score         = 0.3·response + 0.3·dispatch + 0.2·sitrep + 0.2·resource
 *
 * Scores are 0..100 and rounded to two decimals; a missing input yields 0, never
 * NaN or a fake success.
 */
import type { Data } from './filters';

export interface AfterActionTimelineEntry {
  timestamp: string;
  source: 'event' | 'dispatch' | 'sitrep' | 'resource';
  action: string;
  details: Data;
}

export interface AfterActionKpi {
  response_time_minutes: number;
  response_sla_minutes: number;
  response_speed_score: number;
  dispatch_completion_rate: number;
  sitrep_coverage_rate: number;
  resource_efficiency_score: number;
  overall_score: number;
  dispatch_total: number;
  dispatch_completed: number;
  dispatch_canceled: number;
  sitrep_published: number;
  sitrep_expected: number;
  resources_assigned: number;
  resources_available: number;
}

export interface ComputedAfterAction {
  timeline: AfterActionTimelineEntry[];
  kpi: AfterActionKpi;
  summary: string;
  metadata: Data;
}

const SLA_MINUTES: Record<string, number> = { critical: 30, high: 60, medium: 120, low: 240 };

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return round(Math.min(100, Math.max(0, value)));
}

export function responseSpeedScore(minutes: number | null, slaMinutes: number, responded: boolean): number {
  if (!responded || minutes === null) return 0;
  if (minutes <= slaMinutes) return 100;
  if (minutes <= slaMinutes * 1.5) return 80;
  if (minutes <= slaMinutes * 2) return 60;
  if (minutes <= slaMinutes * 4) return 40;
  return 20;
}

function assignmentTime(order: Data): number | null {
  const assignments = Array.isArray(order.assignments) ? order.assignments : [];
  for (const assignment of assignments) {
    if (!assignment || typeof assignment !== 'object') continue;
    const time = parseTime((assignment as Data).assigned_at);
    if (time !== null) return time;
  }
  return parseTime(order.assigned_at) ?? parseTime(order.started_at);
}

export function computeAfterAction(input: {
  event: Data;
  orders?: Data[];
  sitreps?: Data[];
  resources?: Data[];
  nowMs?: number;
}): ComputedAfterAction {
  const { event } = input;
  const orders = input.orders ?? [];
  const sitreps = input.sitreps ?? [];
  const resources = input.resources ?? [];
  const nowMs = input.nowMs ?? Date.now();

  const eventStart = parseTime(event.started_at) ?? parseTime(event.created_at);
  const eventEnd = parseTime(event.ended_at) ?? (event.status === 'resolved' ? parseTime(event.updated_at) : null);
  const severity = String(event.severity ?? 'medium');
  const slaMinutes = SLA_MINUTES[severity] ?? SLA_MINUTES.medium;
  const timeline: AfterActionTimelineEntry[] = [];

  if (parseTime(event.created_at) !== null) {
    timeline.push({ timestamp: new Date(parseTime(event.created_at) as number).toISOString(), source: 'event', action: 'event.created', details: { event_id: event.id, title: event.title } });
  }
  if (parseTime(event.started_at) !== null) {
    timeline.push({ timestamp: new Date(parseTime(event.started_at) as number).toISOString(), source: 'event', action: 'event.started', details: { severity, event_type: event.event_type } });
  }

  let firstAssignment: number | null = null;
  let completed = 0;
  let canceled = 0;
  const assignedResources = new Set<string>();
  for (const order of orders) {
    const created = parseTime(order.created_at);
    if (created !== null) {
      timeline.push({ timestamp: new Date(created).toISOString(), source: 'dispatch', action: 'dispatch.created', details: { order_id: order.id, task_title: order.task_title, priority: order.priority } });
    }
    const assignedAt = assignmentTime(order);
    if (assignedAt !== null) {
      if (firstAssignment === null || assignedAt < firstAssignment) firstAssignment = assignedAt;
      timeline.push({ timestamp: new Date(assignedAt).toISOString(), source: 'dispatch', action: 'dispatch.assigned', details: { order_id: order.id, resource_unit_id: order.assigned_resource_unit_id ?? order.assigned_user_id ?? null } });
    }
    const resourceId = order.assigned_resource_unit_id ?? order.assigned_user_id ?? null;
    if (resourceId) assignedResources.add(String(resourceId));
    const status = String(order.status ?? '');
    if (status === 'completed') {
      completed += 1;
      const completedAt = parseTime(order.completed_at) ?? parseTime(order.updated_at);
      if (completedAt !== null) {
        timeline.push({ timestamp: new Date(completedAt).toISOString(), source: 'dispatch', action: 'dispatch.completed', details: { order_id: order.id } });
      }
    } else if (status === 'canceled' || status === 'rejected') {
      canceled += 1;
    }
  }

  let publishedSitreps = 0;
  for (const sitrep of sitreps) {
    const created = parseTime(sitrep.created_at);
    if (created !== null) {
      timeline.push({ timestamp: new Date(created).toISOString(), source: 'sitrep', action: 'sitrep.created', details: { sitrep_id: sitrep.id, title: sitrep.title } });
    }
    if (String(sitrep.status ?? '') === 'published') {
      publishedSitreps += 1;
      const published = parseTime(sitrep.published_at) ?? parseTime(sitrep.updated_at);
      if (published !== null) {
        timeline.push({ timestamp: new Date(published).toISOString(), source: 'sitrep', action: 'sitrep.published', details: { sitrep_id: sitrep.id } });
      }
    }
  }

  if (parseTime(event.ended_at) !== null || event.status === 'resolved') {
    const ended = parseTime(event.ended_at) ?? parseTime(event.updated_at) ?? nowMs;
    timeline.push({ timestamp: new Date(ended).toISOString(), source: 'event', action: 'event.resolved', details: { status: event.status ?? 'resolved' } });
  }

  timeline.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.action.localeCompare(b.action));

  const responseAt = firstAssignment ?? eventEnd;
  const responded = firstAssignment !== null;
  const responseMinutes = eventStart !== null && responseAt !== null
    ? round(Math.max(0, (responseAt - eventStart) / 60_000), 1)
    : null;

  const countedOrders = orders.filter((order) => !['canceled', 'rejected'].includes(String(order.status ?? ''))).length;
  const dispatchCompletion = countedOrders > 0 ? round((completed / countedOrders) * 100, 2) : 0;

  const durationMs = eventStart !== null ? Math.max(0, (eventEnd ?? nowMs) - eventStart) : 0;
  const expectedSitreps = Math.max(1, Math.ceil(durationMs / (6 * 60 * 60 * 1000)));
  const sitrepCoverage = round((Math.min(publishedSitreps, expectedSitreps) / expectedSitreps) * 100, 2);

  const availableResources = resources.filter((resource) => String(resource.status ?? '') === 'available'
    && !assignedResources.has(String(resource.id))).length;
  const denominator = availableResources + assignedResources.size;
  const resourceEfficiency = denominator > 0 ? round((assignedResources.size / denominator) * 100, 2) : 0;

  const responseScore = responseSpeedScore(responseMinutes, slaMinutes, responded);
  const overall = round(0.3 * responseScore + 0.3 * dispatchCompletion + 0.2 * sitrepCoverage + 0.2 * resourceEfficiency, 2);

  const kpi: AfterActionKpi = {
    response_time_minutes: responseMinutes ?? 0,
    response_sla_minutes: slaMinutes,
    response_speed_score: clampScore(responseScore),
    dispatch_completion_rate: clampScore(dispatchCompletion),
    sitrep_coverage_rate: clampScore(sitrepCoverage),
    resource_efficiency_score: clampScore(resourceEfficiency),
    overall_score: clampScore(overall),
    dispatch_total: orders.length,
    dispatch_completed: completed,
    dispatch_canceled: canceled,
    sitrep_published: publishedSitreps,
    sitrep_expected: expectedSitreps,
    resources_assigned: assignedResources.size,
    resources_available: availableResources,
  };

  const summary = [
    `Sự kiện ${event.event_code ?? event.id} (${event.title ?? ''}) kết thúc với ${completed}/${countedOrders} nhiệm vụ hoàn thành.`,
    responded
      ? `Phản ứng đầu tiên sau ${responseMinutes ?? 0} phút (SLA ${slaMinutes} phút).`
      : 'Không ghi nhận phân công phản ứng nào.',
    `${publishedSitreps}/${expectedSitreps} SITREP đã xuất bản; ${assignedResources.size} nguồn lực được điều động.`,
  ].join(' ');

  return {
    timeline,
    kpi,
    summary,
    metadata: {
      generated_by: 'sos-kpi-engine-v1',
      formula: 'overall=0.3*response+0.3*dispatch+0.2*sitrep+0.2*resource',
      event_start: eventStart === null ? null : new Date(eventStart).toISOString(),
      event_end: eventEnd === null ? null : new Date(eventEnd).toISOString(),
      first_assignment_at: firstAssignment === null ? null : new Date(firstAssignment).toISOString(),
      sla_minutes: slaMinutes,
      computed_at: new Date(nowMs).toISOString(),
    },
  };
}

/** Compute the SOS timeline SLA column from real thresholds. */
export function slaBreachCount(event: Data, firstAssignmentAt: number | null, nowMs = Date.now()): number {
  const severity = String(event.severity ?? 'medium');
  const slaMinutes = SLA_MINUTES[severity] ?? SLA_MINUTES.medium;
  const start = parseTime(event.started_at) ?? parseTime(event.created_at);
  if (start === null) return 0;
  const terminal = ['resolved', 'canceled'].includes(String(event.status ?? ''));
  const end = parseTime(event.ended_at) ?? (terminal ? parseTime(event.updated_at) : nowMs);
  const response = firstAssignmentAt ?? end;
  if (response === null) return 0;
  const elapsed = (response - start) / 60_000;
  return elapsed > slaMinutes ? 1 : 0;
}
