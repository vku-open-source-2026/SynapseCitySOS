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
    decisionStatus: { monitor: 'monitoring', activate: 'active', contain: 'contained', cancel: 'canceled', archive: 'archived' },
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
    decisionStatus: { assign: 'assigned', start: 'in_transit', arrive: 'on_scene', complete: 'completed', reject: 'rejected', cancel: 'canceled' },
    fields: {
      emergency_event_id: S(128), eop_plan_id: S(128), task_title: S(200), task_description: S(4000),
      priority: S(40), status: S(40), assigned_resource_unit_id: S(128), assigned_user_id: S(128),
      eta_minutes: N(), started_at: DATE(), completed_at: DATE(), assignments_json: JSONV(),
      metadata_json: JSONV(), target_location_json: JSONV(),
    },
    required: ['emergency_event_id', 'task_title'],
    defaults: { status: 'pending', priority: 'medium' },
  },
  resources: {
    dataset: 'sos-resource-units', recordType: 'ResourceUnit', publish: false,
    terminal: ['retired'],
    statuses: ['available', 'assigned', 'deployed', 'unavailable', 'maintenance', 'retired'],
    decisionStatus: { available: 'available', assign: 'assigned', deploy: 'deployed', unavailable: 'unavailable', maintain: 'maintenance', retire: 'retired' },
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
    decisionStatus: { submit: 'review_pending', publish: 'published', archive: 'archived' },
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
    statuses: ['draft', 'review_pending', 'approved', 'published', 'archived', 'rejected'],
    decisionStatus: { submit: 'review_pending', approve: 'approved', publish: 'published', reject: 'rejected', archive: 'archived' },
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
    decisionStatus: { publish: 'published', archive: 'archived' },
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
    decisionStatus: { activate: 'active', monitor: 'monitoring', expire: 'expired', resolve: 'resolved' },
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
    decisionStatus: { start: 'running', complete: 'completed', fail: 'failed' },
    fields: {
      source: S(60), status: S(40), started_at: DATE(), finished_at: DATE(), hazards_seen: N(),
      hazards_ingested: N(), error_message: S(4000), metadata_json: JSONV(),
    },
    required: ['source'],
    defaults: { status: 'queued' },
  },
  mutualAid: {
    dataset: 'sos-mutual-aid-requests', recordType: 'MutualAidRequest', publish: false,
    terminal: ['completed', 'rejected', 'canceled'],
    statuses: ['pending', 'approved', 'rejected', 'in_progress', 'completed', 'canceled'],
    decisionStatus: { approve: 'approved', reject: 'rejected', start: 'in_progress', complete: 'completed', cancel: 'canceled' },
    fields: {
      requesting_org: S(160), target_org: S(160), emergency_event_id: S(128), resource_type: S(60),
      quantity: N(), status: S(40), notes: S(4000), approved_at: DATE(), metadata_json: JSONV(),
    },
    required: ['requesting_org', 'target_org', 'resource_type'],
    defaults: { status: 'pending', quantity: 1 },
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
  record.created_at = $now;
  record.updated_at = $now;
  return { mode: 'create', url: base, body: { data: record, publish: schema.publish === true }, audit, operation: resource + '.create' };
}
if (action === 'delete') {
  return { mode: 'delete', url: base + '/' + encodeURIComponent(recordId), audit, operation: resource + '.delete' };
}
const unknown = Object.keys(fields).filter((key) => key !== 'record_id' && key !== 'id' && key !== 'decision' && key !== 'notes' && !(key in schema.fields));
if (unknown.length) throw new Error('unknown_fields:' + unknown.join(','));
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
if (patch.status !== undefined && schema.statuses.length && !schema.statuses.includes(String(patch.status))) throw new Error('status_invalid');
return { mode: 'update', url: base + '/' + encodeURIComponent(recordId), patch, audit, operation: resource + '.' + (decision || action) };
`;

const ref = (name) => ({ node: name, type: 'main', index: 0 });
const node = (name, type, typeVersion, position, parameters = {}) => ({ name, type, typeVersion, position, parameters });
const TERMINALS = Object.fromEntries(Object.entries(SCHEMAS).map(([key, value]) => [key, { terminal: value.terminal }]));

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
const schema = ${JSON.stringify(TERMINALS)};
const terminal = schema[action.resource] ? schema[action.resource].terminal : [];
if (terminal.includes(String(data.status))) throw new Error('record_terminal');
const next = { ...data, ...action.patch, updated_at: $now };
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
    node('Delete record', 'httpRequest', 4, [1300, 500], {
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
    'Delete?': { main: [[ref('Delete record')], [ref('Unsupported operation')]] },
    'Delete record': { main: [[]] },
    'Unsupported operation': { main: [[]] },
  },
};

const output = join(dir, 'sos-workspace-actions.workflow.json');
writeFileSync(output, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`wrote ${output} (${workflow.nodes.length} nodes)`);
