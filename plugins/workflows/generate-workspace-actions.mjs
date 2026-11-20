// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Regenerate the generic SOS workspace-action workflow.
 *
 * The Tier-1 engine executes this declarative product source only after DX has
 * verified the installation, member role and pinned artifact checksum. Every
 * write goes to the allowlisted Tier-2 SOS dataset through the organization
 * technical credential; no Tier-3 API is called.
 *
 * Usage: node plugins/workflows/generate-workspace-actions.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const DX = 'https://synapsedx.sbs';
const PRODUCT = 'sos';

const S = (max = 4000) => ({ kind: 'text', max });
const N = () => ({ kind: 'number' });
const DATE = () => ({ kind: 'date' });
const JSONV = () => ({ kind: 'json' });
const BOOL = () => ({ kind: 'boolean' });

const SCHEMAS = {
  events: {
    dataset: 'sos-emergency-events', recordType: 'EmergencyEvent', publish: true,
    terminal: ['resolved', 'canceled', 'archived'],
    statuses: ['monitoring', 'active', 'contained', 'resolved', 'canceled', 'archived'],
    // Terminal close/cancel/archive stay in the SOS event lifecycle so an AAR
    // is created first; the workspace can only change the live command state.
    decisionStatus: { monitor: 'monitoring', activate: 'active', contain: 'contained' },
    allowedFrom: {
      monitoring: ['monitoring', 'active', 'contained'],
      active: ['monitoring'],
      contained: ['monitoring', 'active'],
      resolved: ['active', 'contained'],
      canceled: ['monitoring', 'active', 'contained'],
      archived: ['resolved', 'canceled'],
    },
    deleteFrom: ['monitoring'],
    fields: {
      event_code: S(120), title: S(200), description: S(4000), event_type: S(40), severity: S(40),
      status: S(40), source: S(40), address: S(300), ward: S(120), district: S(120), city: S(120),
      affected_area_km2: N(), instructions_json: JSONV(), tags_json: JSONV(), started_at: DATE(),
      ended_at: DATE(), resolution_note: S(4000), affected_asset_ids_json: JSONV(),
    },
    required: ['title'],
    defaults: { status: 'monitoring', severity: 'medium', source: 'manual' },
  },
  dispatch: {
    dataset: 'sos-dispatch-orders', recordType: 'DispatchOrder', publish: false,
    terminal: ['completed', 'canceled', 'rejected'],
    statuses: ['pending', 'assigned', 'in_transit', 'on_scene', 'completed', 'canceled', 'rejected'],
    // Assignment/start/arrive/complete require SOS resource reservation and
    // release; only a still-pending order may be rejected/canceled here.
    // The responder progression mirrors the fixed route (dispatch_action):
    // start only from assigned, arrive only from in_transit.
    decisionStatus: { start: 'in_transit', arrive: 'on_scene', reject: 'rejected', cancel: 'canceled' },
    allowedFrom: {
      assigned: ['pending'],
      in_transit: ['assigned'],
      on_scene: ['in_transit'],
      completed: ['assigned', 'in_transit', 'on_scene'],
      canceled: ['pending'],
      rejected: ['pending'],
    },
    deleteFrom: ['pending'],
    fields: {
      emergency_event_id: S(128), eop_plan_id: S(128), task_title: S(200), task_description: S(4000),
      priority: S(40), status: S(40), eta_minutes: N(), metadata_json: JSONV(),
      target_location_json: JSONV(),
    },
    required: ['emergency_event_id', 'task_title'],
    defaults: { status: 'pending', priority: 'medium' },
  },
  resources: {
    dataset: 'sos-resource-units', recordType: 'ResourceUnit', publish: false,
    terminal: ['retired'],
    statuses: ['available', 'assigned', 'deployed', 'unavailable', 'maintenance', 'retired'],
    // Assignment/retirement is owned by SOS dispatch (reservation, release and
    // terminal rules); the workspace may only take an unassigned unit out of
    // service or put it back.
    decisionStatus: { available: 'available', unavailable: 'unavailable', maintain: 'maintenance' },
    allowedFrom: {
      available: ['unavailable', 'maintenance'],
      assigned: ['available'],
      deployed: ['available', 'assigned'],
      unavailable: ['available'],
      maintenance: ['available'],
      retired: ['available', 'unavailable', 'maintenance'],
    },
    deleteFrom: ['available'],
    fields: {
      resource_code: S(120), name: S(200), resource_type: S(60), status: S(40), capacity: N(),
      capacity_unit: S(40), district: S(120), ward: S(120), contact_phone: S(40), skills_json: JSONV(),
      assigned_dispatch_order_id: S(128), current_location_json: JSONV(), metadata_json: JSONV(),
    },
    required: ['resource_code', 'name', 'resource_type'],
    defaults: { status: 'available' },
  },
  sitrep: {
    dataset: 'sos-sitreps', recordType: 'Sitrep', publish: false,
    terminal: ['published', 'archived'],
    statuses: ['draft', 'review_pending', 'published', 'archived'],
    decisionStatus: { submit: 'review_pending', archive: 'archived' },
    allowedFrom: {
      review_pending: ['draft'],
      published: ['review_pending'],
      archived: ['draft', 'review_pending', 'published'],
    },
    deleteFrom: ['draft'],
    fields: {
      emergency_event_id: S(128), title: S(200), status: S(40), author: S(160), source: S(60),
      reporting_period_start: DATE(), reporting_period_end: DATE(), numbers_json: JSONV(),
      snapshot_json: JSONV(), deltas_json: JSONV(), amends_sitrep_id: S(128),
    },
    required: ['emergency_event_id', 'title', 'reporting_period_start', 'reporting_period_end'],
    defaults: { status: 'draft' },
  },
  eop: {
    dataset: 'sos-eop-plans', recordType: 'EOPPlan', publish: false,
    terminal: ['published', 'archived', 'rejected'],
    locked: ['approved'],
    statuses: ['draft', 'review_pending', 'approved', 'published', 'archived', 'rejected'],
    // Approve/publish require the SOS HITL approval chain; the workspace may
    // submit a draft for review or reject it, never publish it.
    decisionStatus: { submit: 'review_pending', reject: 'rejected', archive: 'archived' },
    allowedFrom: {
      review_pending: ['draft'],
      approved: ['review_pending'],
      published: ['approved'],
      rejected: ['review_pending'],
      archived: ['draft', 'review_pending', 'approved', 'published'],
    },
    deleteFrom: ['draft'],
    fields: {
      emergency_event_id: S(128), version: N(), title: S(200), summary: S(4000), status: S(40),
      objectives_json: JSONV(), operational_phases_json: JSONV(), actions_json: JSONV(),
      assignment_matrix_json: JSONV(), evacuation_plan_json: JSONV(), fallback_plan_json: JSONV(),
      communications_plan_json: JSONV(), review_notes: S(4000), markdown_body: S(8000),
      metadata_json: JSONV(),
    },
    required: ['emergency_event_id', 'title'],
    defaults: { status: 'draft', version: 1 },
  },
  afterAction: {
    dataset: 'sos-after-action-reports', recordType: 'AfterActionReport', publish: false,
    terminal: ['published', 'archived'],
    statuses: ['draft', 'published', 'archived'],
    // Publication is an SOS AAR action; the workspace may only archive a draft.
    decisionStatus: { archive: 'archived' },
    allowedFrom: {
      published: ['draft'],
      archived: ['draft'],
    },
    deleteFrom: ['draft'],
    fields: {
      emergency_event_id: S(128), report_code: S(160), title: S(200), summary: S(8000), status: S(40),
      lessons_learned_json: JSONV(), recommendations_json: JSONV(), timeline_json: JSONV(),
      kpi_json: JSONV(), generated_at: DATE(), published_at: DATE(), metadata_json: JSONV(),
    },
    required: ['emergency_event_id', 'title'],
    defaults: { status: 'draft' },
  },
  hazards: {
    dataset: 'sos-hazard-layers', recordType: 'Hazard', publish: true,
    terminal: ['expired', 'resolved'],
    statuses: ['active', 'monitoring', 'expired', 'resolved'],
    decisionStatus: { activate: 'active', monitor: 'monitoring' },
    allowedFrom: {
      active: ['monitoring'],
      monitoring: ['active'],
      expired: ['active', 'monitoring'],
      resolved: ['active', 'monitoring'],
    },
    deleteFrom: ['monitoring'],
    fields: {
      hazard_id: S(160), title: S(200), description: S(4000), event_type: S(40), severity: S(40),
      source: S(40), is_active: BOOL(), district: S(120), ward: S(120), detected_at: DATE(),
      issued_at: DATE(), expires_at: DATE(), geometry_json: JSONV(), metadata_json: JSONV(),
    },
    required: ['hazard_id', 'title', 'event_type', 'severity'],
    defaults: { is_active: true, source: 'manual', severity: 'medium' },
  },
  hazardIngest: {
    dataset: 'sos-hazard-ingest-runs', recordType: 'HazardIngestRun', publish: false,
    terminal: ['completed', 'failed'],
    statuses: ['queued', 'running', 'completed', 'failed'],
    // Ingest runs are written by the ingest API/service, not by operators.
    decisionStatus: {},
    allowedFrom: {
      running: ['queued'],
      completed: ['running'],
      failed: ['queued', 'running'],
    },
    deleteFrom: [],
    fields: {
      source: S(60), status: S(40), started_at: DATE(), finished_at: DATE(), hazards_seen: N(),
      hazards_ingested: N(), error_message: S(4000), metadata_json: JSONV(),
    },
    required: ['source'],
    defaults: { status: 'queued' },
  },
  mutualAid: {
    dataset: 'sos-mutual-aid-requests', recordType: 'MutualAidRequest', publish: false,
    terminal: ['filled', 'declined', 'handed_off'],
    statuses: ['open', 'partially_filled', 'filled', 'declined', 'handed_off'],
    decisionStatus: { decline: 'declined', handoff: 'handed_off' },
    allowedFrom: {
      partially_filled: ['open'],
      filled: ['open', 'partially_filled'],
      declined: ['open', 'partially_filled'],
      handed_off: ['open', 'partially_filled'],
    },
    deleteFrom: ['open'],
    fields: {
      request_number: S(64), resource_type: S(100), quantity: N(), location_json: JSONV(),
      urgency: S(20), contact_json: JSONV(), requesting_agency: S(200), status: S(40),
      notes: S(2000),
    },
    required: ['resource_type', 'quantity', 'requesting_agency'],
    defaults: { status: 'open', quantity: 1, urgency: 'medium' },
  },
};

const CODE = `const envelope = $input || {};
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const bool = (value) => (value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined);
const parseJson = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try { return JSON.parse(value); } catch { throw new Error(name + '_invalid_json'); }
};
const envelopeKeys = new Set(['pluginId', 'widgetId', 'product', 'resource', 'action', 'submittedBy', 'submittedAt', 'fields']);
const unknownEnvelope = Object.keys(envelope).filter((key) => !envelopeKeys.has(key));
if (unknownEnvelope.length) throw new Error('unknown_envelope_fields:' + unknownEnvelope.join(','));
const product = text(envelope.product);
const resource = text(envelope.resource);
const action = text(envelope.action) || 'create';
const submittedBy = text(envelope.submittedBy);
if (!submittedBy) throw new Error('submitted_by_required');
if (product !== '${PRODUCT}') throw new Error('unsupported_product');
if (!['create', 'update', 'delete', 'execute'].includes(action)) throw new Error('unsupported_action');
const fields = envelope.fields && typeof envelope.fields === 'object' && !Array.isArray(envelope.fields) ? envelope.fields : null;
if (!fields) throw new Error('fields_required');
const SCHEMAS = ${JSON.stringify(SCHEMAS)};
const INITIAL_STATUSES = ${JSON.stringify({
    events: ['monitoring', 'active'],
    dispatch: ['pending'],
    resources: ['available'],
    sitrep: ['draft'],
    eop: ['draft'],
    afterAction: ['draft'],
    hazards: ['active', 'monitoring'],
    hazardIngest: ['queued'],
    mutualAid: ['open'],
})};
const schema = SCHEMAS[resource];
if (!schema) throw new Error('unsupported_resource');
const audit = {
  product, resource, action,
  pluginId: text(envelope.pluginId), widgetId: text(envelope.widgetId),
  submittedBy, submittedAt: text(envelope.submittedAt) || $now,
};
const base = '${DX}/v1/capabilities/datasets/' + schema.dataset + '/records';
const parseField = (name, spec) => {
  const value = fields[name];
  if (value === undefined || value === null || value === '') return undefined;
  if (spec.kind === 'number') {
    const number = num(value);
    if (number === undefined) throw new Error(name + '_must_be_number');
    return number;
  }
  if (spec.kind === 'boolean') {
    const flag = bool(value);
    if (flag === undefined) throw new Error(name + '_must_be_boolean');
    return flag;
  }
  if (spec.kind === 'json') return parseJson(value, name);
  const string = text(value);
  if (typeof value !== 'string' || string.length > (spec.max || 4000)) throw new Error(name + '_invalid_text');
  return string;
};
const recordId = text(fields.record_id || fields.id);
if (action !== 'create' && !/^[A-Za-z0-9_@.:+-]{1,256}$/.test(recordId)) throw new Error('record_id_invalid');
if (action === 'create') {
  const unknown = Object.keys(fields).filter((key) => key !== 'record_id' && !(key in schema.fields));
  if (unknown.length) throw new Error('unknown_fields:' + unknown.join(','));
  for (const required of schema.required) {
    const value = parseField(required, schema.fields[required]);
    if (value === undefined || value === '') throw new Error(required + '_required');
  }
  const record = { type: schema.recordType, ...schema.defaults };
  for (const [name, spec] of Object.entries(schema.fields)) {
    const parsed = parseField(name, spec);
    if (parsed === undefined) continue;
    record[name.endsWith('_json') ? name.slice(0, -5) : name] = parsed;
  }
  if (record.status !== undefined && schema.statuses.length && !schema.statuses.includes(String(record.status))) throw new Error('status_invalid');
  if (!(INITIAL_STATUSES[resource] || []).includes(String(record.status))) throw new Error('initial_status_invalid');
  if (resource === 'mutualAid' && record.urgency !== undefined && !['low', 'medium', 'high', 'critical'].includes(String(record.urgency))) throw new Error('urgency_invalid');
  if (resource === 'mutualAid') {
    // The SOS domain requires these fields for the public/accept projections.
    if (!record.request_number) record.request_number = 'MA-' + String($now).replace(/[^0-9]/g, '').slice(0, 14);
    record.filled_quantity = 0;
    record.history = [{ action: 'created', at: $now, by: submittedBy }];
  }
  record.created_at = $now;
  record.updated_at = $now;
  return { mode: 'create', url: base, body: { data: record, publish: schema.publish === true }, audit, operation: resource + '.create' };
}
if (action === 'delete') {
  return { mode: 'delete', url: base + '/' + encodeURIComponent(recordId), audit, operation: resource + '.delete' };
}
const unknown = Object.keys(fields).filter((key) => key !== 'record_id' && key !== 'id' && key !== 'decision' && key !== 'notes' && !(key in schema.fields));
if (unknown.length) throw new Error('unknown_fields:' + unknown.join(','));
const immutable = ['emergency_event_id', 'eop_plan_id', 'version', 'request_number'];
if (action === 'update') {
  for (const key of immutable) {
    const value = fields[key];
    if (value !== undefined && value !== null && value !== '') throw new Error(key + '_immutable');
  }
}
const patch = {};
for (const [name, spec] of Object.entries(schema.fields)) {
  const parsed = parseField(name, spec);
  if (parsed === undefined) continue;
  patch[name.endsWith('_json') ? name.slice(0, -5) : name] = parsed;
}
const decision = text(fields.decision);
const notes = text(fields.notes);
if (notes) patch.notes = notes;
if (action === 'execute') {
  const map = schema.decisionStatus || {};
  if (decision) {
    if (!map[decision]) throw new Error('decision_invalid');
    patch.status = map[decision];
  }
  if (!decision && !Object.keys(patch).length) throw new Error('action_fields_required');
  if (patch.status === 'approved') patch.approved_at = $now;
  if (patch.status === 'published') patch.published_at = $now;
  if (patch.status === 'rejected') patch.rejected_at = $now;
}
if (!Object.keys(patch).length) throw new Error('nothing_to_update');
if (action === 'update' && patch.status !== undefined) throw new Error('status_requires_execute');
if (patch.status !== undefined && schema.statuses.length && !schema.statuses.includes(String(patch.status))) throw new Error('status_invalid');
return { mode: 'update', url: base + '/' + encodeURIComponent(recordId), patch, audit, operation: resource + '.' + (decision || action) };
`;

const ref = (name) => ({ node: name, type: 'main', index: 0 });
const node = (name, type, typeVersion, position, parameters = {}) => ({ name, type, typeVersion, position, parameters });
const GUARDS = Object.fromEntries(Object.entries(SCHEMAS).map(([key, value]) => [key, {
  terminal: value.terminal,
  locked: value.locked || [],
  allowedFrom: value.allowedFrom || {},
  deleteFrom: value.deleteFrom || [],
}]));

const workflow = {
  name: 'sos-workspace-actions',
  nodes: [
    node('DX manual execution', 'manualTrigger', 1, [200, 300]),
    node('Validate envelope and select operation', 'code', 2, [420, 300], { code: CODE }),
    node('Create?', 'if', 1, [640, 300], {
      conditions: { combinator: 'and', conditions: [{ leftValue: '={{$json.mode}}', rightValue: 'create', operator: 'equals' }] },
    }),
    node('Create record', 'httpRequest', 4, [860, 180], {
      url: '={{ $json.url }}', method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      auth: { credentialRef: 'synapsedx-organization', header: 'X-API-Key', allowedOrigins: [DX] },
      body: '={{ $json.body }}', timeoutMs: 15000,
    }),
    node('Update?', 'if', 1, [860, 420], {
      conditions: { combinator: 'and', conditions: [{ leftValue: '={{$json.mode}}', rightValue: 'update', operator: 'equals' }] },
    }),
    node('Read current record', 'httpRequest', 4, [1080, 360], {
      url: '={{ $json.url }}', method: 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      auth: { credentialRef: 'synapsedx-organization', header: 'X-API-Key', allowedOrigins: [DX] },
      includeInput: true, timeoutMs: 15000,
    }),
    node('Merge and enforce invariants', 'code', 2, [1300, 360], {
      code: `const response = $input || {};
const current = response.body;
const action = response.input;
if (response.statusCode !== 200 || !current || typeof current.data !== 'object' || !current.data) throw new Error('record_not_found');
const data = current.data;
if (!Number.isInteger(current.version)) throw new Error('record_version_unavailable');
const guards = ${JSON.stringify(GUARDS)};
const guard = guards[action.resource] || { terminal: [], locked: [], allowedFrom: {}, deleteFrom: [] };
if (guard.terminal.includes(String(data.status))) throw new Error('record_terminal');
if ((guard.locked || []).includes(String(data.status)) && action.patch.status === undefined) throw new Error('record_immutable');
const next = { ...data, ...action.patch, updated_at: $now };
if (action.patch.status !== undefined && String(action.patch.status) !== String(data.status)) {
  const allowed = (guard.allowedFrom || {})[String(action.patch.status)] || [];
  if (!allowed.includes(String(data.status))) throw new Error('record_status_invalid');
}
return { body: { data: next, ifVersion: current.version }, url: action.url, audit: action.audit, operation: action.operation };`,
    }),
    node('Patch full record', 'httpRequest', 4, [1520, 360], {
      url: '={{ $json.url }}', method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      auth: { credentialRef: 'synapsedx-organization', header: 'X-API-Key', allowedOrigins: [DX] },
      body: '={{ $json.body }}', timeoutMs: 15000,
    }),
    node('Delete?', 'if', 1, [1080, 560], {
      conditions: { combinator: 'and', conditions: [{ leftValue: '={{$json.mode}}', rightValue: 'delete', operator: 'equals' }] },
    }),
    node('Read record for delete', 'httpRequest', 4, [1300, 500], {
      url: '={{ $json.url }}', method: 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      auth: { credentialRef: 'synapsedx-organization', header: 'X-API-Key', allowedOrigins: [DX] },
      includeInput: true, timeoutMs: 15000,
    }),
    node('Check delete allowed', 'code', 2, [1520, 500], {
      code: `const response = $input || {};
const action = response.input;
if (response.statusCode !== 200 || !response.body || typeof response.body.data !== 'object' || !response.body.data) throw new Error('record_not_found');
const guards = ${JSON.stringify(GUARDS)};
const guard = guards[action.resource] || { deleteFrom: [] };
if (!guard.deleteFrom.includes(String(response.body.data.status))) throw new Error('record_delete_forbidden');
return { url: action.url, audit: action.audit, operation: action.operation };`,
    }),
    node('Delete record', 'httpRequest', 4, [1740, 500], {
      url: '={{ $json.url }}', method: 'DELETE',
      headers: { Accept: 'application/json' },
      auth: { credentialRef: 'synapsedx-organization', header: 'X-API-Key', allowedOrigins: [DX] },
      timeoutMs: 15000,
    }),
    node('Unsupported operation', 'code', 2, [1300, 620], {
      code: 'throw new Error(\'unsupported_operation\');\nreturn {};',
    }),
  ],
  connections: {
    'DX manual execution': { main: [[ref('Validate envelope and select operation')]] },
    'Validate envelope and select operation': { main: [[ref('Create?')]] },
    'Create?': { main: [[ref('Create record')], [ref('Update?')]] },
    'Create record': { main: [[]] },
    'Update?': { main: [[ref('Read current record')], [ref('Delete?')]] },
    'Read current record': { main: [[ref('Merge and enforce invariants')]] },
    'Merge and enforce invariants': { main: [[ref('Patch full record')]] },
    'Patch full record': { main: [[]] },
    'Delete?': { main: [[ref('Read record for delete')], [ref('Unsupported operation')]] },
    'Read record for delete': { main: [[ref('Check delete allowed')]] },
    'Check delete allowed': { main: [[ref('Delete record')]] },
    'Delete record': { main: [[]] },
    'Unsupported operation': { main: [[]] },
  },
};

const output = join(dir, 'sos-workspace-actions.workflow.json');
writeFileSync(output, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`wrote ${output} (${workflow.nodes.length} nodes)`);
