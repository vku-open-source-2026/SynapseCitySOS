// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * LOCAL TEST-ONLY parity harness: run the SOS event-close AAR code node and the
 * real Tier-3 domain KPI engine (`apps/sos-service/src/after-action.ts`) on the
 * same fixture, then compare their output. No network, credential or write.
 */
import fs from 'node:fs';
import { computeAfterAction } from '../apps/sos-service/src/after-action.ts';

const WORKFLOW = new URL('../plugins/workflows/sos-event-close.workflow.json', import.meta.url).pathname;
const workflow = JSON.parse(fs.readFileSync(WORKFLOW, 'utf8'));
const computeNode = workflow.nodes.find((node: { name: string }) => node.name === 'Compute AAR and prepare create');
if (!computeNode) throw new Error('compute node not found');

const nowMs = Date.now();
const startMs = nowMs - 2 * 3600_000;
const closedAt = new Date(nowMs).toISOString();
const iso = (ms: number) => new Date(ms).toISOString();

const event = {
  id: 'aar-event',
  event_code: 'EV-AAR',
  title: 'Flood AAR',
  event_type: 'flood',
  severity: 'high',
  status: 'active',
  created_at: iso(startMs),
  started_at: iso(startMs),
  ended_at: closedAt,
};
const dispatch = [
  {
    id: 'aar-order-1', emergency_event_id: 'aar-event', task_title: 'Evacuate', status: 'completed', priority: 'high',
    assigned_resource_unit_id: 'aar-resource', created_at: iso(startMs + 10 * 60_000),
    completed_at: iso(startMs + 90 * 60_000), updated_at: iso(startMs + 90 * 60_000),
    assignments: [{ assigned_resource_unit_id: 'aar-resource', assigned_at: iso(startMs + 20 * 60_000) }],
  },
  {
    id: 'aar-order-2', emergency_event_id: 'aar-event', task_title: 'Canceled', status: 'canceled', priority: 'low',
    created_at: iso(startMs + 15 * 60_000), assignments: [],
  },
];
const sitreps = [
  {
    id: 'aar-sitrep', emergency_event_id: 'aar-event', title: 'SITREP', status: 'published',
    created_at: iso(startMs + 30 * 60_000), published_at: iso(startMs + 40 * 60_000),
  },
];
const resources = [
  { id: 'aar-resource', status: 'available' },
  { id: 'aar-free', status: 'available' },
];

const state = {
  mode: 'create',
  event,
  dispatch,
  sitreps,
  resources,
  nextVersion: 1,
  closedAt,
  closedBy: 'member-test',
  action: { audit: { submittedBy: 'member-test' } },
};

// The code node is product-owned source in this repository, not remote input.
const runWorkflowCode = new Function('$input', '$json', '$now', computeNode.parameters.code);
const workflowAar = runWorkflowCode(state, state, closedAt).aarBody.data;

// The domain service computes the AAR from a resolved preview (status resolved,
// ended_at set); that is exactly what the event-close action does before its
// own merge, so compare against the same preview.
const legacy = computeAfterAction({ event: { ...event, status: 'resolved', ended_at: closedAt }, orders: dispatch, sitreps, resources, nowMs: Date.parse(closedAt) });

const pick = (value: Record<string, unknown>) => JSON.stringify(value);
const metadataKeys = ['generated_by', 'formula', 'event_start', 'event_end', 'first_assignment_at', 'sla_minutes', 'computed_at'];
const metadataEqual = metadataKeys.every((key) => pick(workflowAar.metadata[key]) === pick((legacy.metadata as Record<string, unknown>)[key]));

console.log(JSON.stringify({
    ok: true,
    kpiEqual: pick(workflowAar.kpi) === pick(legacy.kpi),
    summaryEqual: workflowAar.summary === legacy.summary,
    timelineEqual: pick(workflowAar.timeline) === pick(legacy.timeline),
    metadataEqual,
    workflowKpi: workflowAar.kpi,
    legacyKpi: legacy.kpi,
    workflowSummary: workflowAar.summary,
    legacySummary: legacy.summary,
}));
