import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CapabilitiesClient, CapabilitiesError } from '@synapsedx/capabilities';

const app = express();
const PORT = Number(process.env.PORT || 8084);
const TIER2_URL = (process.env.SYNAPSEDX_BASE_URL || 'https://synapsedx.sbs').replace(/\/$/, '');
const SERVICE_KEY = process.env.SYNAPSEDX_API_KEY;

function assertPublic(url: string): string {
  const parsed = new URL(url);
  const local = /^(localhost|127\.0\.0\.1|::1)$/i.test(parsed.hostname);
  if ((local && process.env.ALLOW_LOCAL_DEPENDENCIES !== 'true') || (!local && parsed.protocol !== 'https:')) {
    throw new Error('SYNAPSEDX_BASE_URL must be a public HTTPS endpoint');
  }
  return url.replace(/\/$/, '');
}

const PUBLIC_TIER2_URL = assertPublic(TIER2_URL);

type Data = Record<string, unknown>;
type Spec = { id: string; name: string; entityType: string; description: string; public?: boolean };
type Row = { id: string; data: Data; createdAt?: string; updatedAt?: string };

const DATASETS = {
  events: { id: 'sos-emergency-events', name: 'SynapseCitySOS emergency events', entityType: 'EmergencyEvent', description: 'Emergency event command records', public: true },
  eop: { id: 'sos-eop-plans', name: 'SynapseCitySOS EOP plans', entityType: 'EmergencyOperationsPlan', description: 'Emergency operations plans' },
  dispatch: { id: 'sos-dispatch-orders', name: 'SynapseCitySOS dispatch orders', entityType: 'DispatchOrder', description: 'Emergency dispatch orders' },
  resources: { id: 'sos-resource-units', name: 'SynapseCitySOS resource units', entityType: 'ResourceUnit', description: 'Emergency response resources' },
  sitrep: { id: 'sos-sitreps', name: 'SynapseCitySOS situation reports', entityType: 'SituationReport', description: 'Emergency situation reports' },
  hazards: { id: 'sos-hazard-layers', name: 'SynapseCitySOS hazard layers', entityType: 'HazardLayer', description: 'Flood, storm and other hazard observations', public: true },
  afterAction: { id: 'sos-after-action-reports', name: 'SynapseCitySOS after action reports', entityType: 'AfterActionReport', description: 'Emergency after action reports' },
} satisfies Record<string, Spec>;

function client(req: Request): CapabilitiesClient {
  const authorization = req.header('authorization');
  const token = authorization?.replace(/^Bearer\s+/i, '').trim() || process.env.SYNAPSEDX_TOKEN;
  return new CapabilitiesClient({
    baseUrl: PUBLIC_TIER2_URL,
    token: token || undefined,
    apiKey: req.header('x-api-key') || SERVICE_KEY,
  });
}

function now(): string { return new Date().toISOString(); }
function asData(row: Row): Data {
  return { ...row.data, id: row.data.id || row.id, created_at: row.data.created_at || row.createdAt, updated_at: row.data.updated_at || row.updatedAt };
}
function limitOf(req: Request, fallback = 100): number {
  const n = Number(req.query.limit);
  return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 500) : fallback;
}
function offsetOf(req: Request): number {
  const n = Number(req.query.skip ?? req.query.offset);
  return Number.isFinite(n) ? Math.max(Math.floor(n), 0) : 0;
}
function body(req: Request): Data {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw Object.assign(new Error('request_body_must_be_an_object'), { status: 400 });
  return req.body as Data;
}
function notFound(error: unknown): boolean { return error instanceof CapabilitiesError && error.status === 404; }

async function dataset(c: CapabilitiesClient, spec: Spec) {
  try { return await c.datasets.get(spec.id); }
  catch (error) {
    if (!notFound(error)) throw error;
    try {
      const created = await c.datasets.create({
        slug: spec.id,
        name: spec.name,
        entityType: spec.entityType,
        description: spec.description,
        license: 'CC-BY-4.0',
        schemaVersion: '1.0.0',
        public: spec.public === true,
      });
      return spec.public ? c.datasets.publish(created.id) : created;
    } catch (createError) {
      if (createError instanceof CapabilitiesError && (createError.status === 400 || createError.status === 409)) return c.datasets.get(spec.id);
      throw createError;
    }
  }
}

async function list(c: CapabilitiesClient, spec: Spec, req: Request): Promise<Data[]> {
  const ds = await dataset(c, spec);
  const page = await c.records.list(ds.id, { limit: limitOf(req), offset: offsetOf(req) });
  return page.items.map(asData);
}
async function get(c: CapabilitiesClient, spec: Spec, id: string): Promise<Data> {
  const ds = await dataset(c, spec);
  return asData(await c.records.get(ds.id, id));
}
async function write(c: CapabilitiesClient, spec: Spec, input: Data, id = String(input.id || randomUUID())): Promise<Data> {
  const ds = await dataset(c, spec);
  const timestamp = now();
  const data = { ...input, id, created_at: input.created_at || timestamp, updated_at: timestamp };
  try { return asData(await c.records.create(ds.id, data, { id, publish: spec.public === true })); }
  catch (error) {
    if (error instanceof CapabilitiesError && (error.status === 400 || error.status === 409)) return asData(await c.records.update(ds.id, id, data));
    throw error;
  }
}
async function update(c: CapabilitiesClient, spec: Spec, id: string, patch: Data): Promise<Data> {
  const current = await get(c, spec, id);
  return asData(await c.records.update((await dataset(c, spec)).id, id, { ...current, ...patch, id, updated_at: now() }));
}
function filterRows(rows: Data[], req: Request): Data[] {
  return rows.filter((row) => Object.entries(req.query).every(([key, value]) => ['limit', 'skip', 'offset'].includes(key) || value === undefined || String(row[key] ?? '') === String(value)));
}

app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', process.env.CORS_ORIGIN || 'https://synapsecity.sbs');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key,x-correlation-id');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,OPTIONS');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-correlation-id', req.header('x-correlation-id') || randomUUID());
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/health', async (req, res, next) => {
  try { res.json({ status: 'ok', service: 'synapsecity-sos', tier: 3, tier2: await client(req).health(), tier2Url: PUBLIC_TIER2_URL }); }
  catch (error) { next(error); }
});
app.get('/ready', async (req, res, next) => {
  try { res.json({ status: 'ready', service: 'synapsecity-sos', tier: 3, tier2: await client(req).health(), tier2Url: PUBLIC_TIER2_URL }); }
  catch (error) { next(error); }
});

// Emergency events and the public emergency projection.
app.get('/v1/emergency/public', async (req, res, next) => {
  try {
    const rows = await list(client(req), DATASETS.events, req);
    res.json(rows.map(({ id, title, event_type, severity, status, location, geometry, started_at, created_at }) => ({ id, title, event_type, severity, status, location, geometry, started_at, created_at })));
  } catch (error) { next(error); }
});
app.get('/v1/emergency/sosconn/status', (_req, res) => res.json({ provider: 'synapsecity-sos', configured: Boolean(SERVICE_KEY), reachable: Boolean(SERVICE_KEY), model: null, detail: SERVICE_KEY ? null : 'service key is not configured', checked_at: now(), base_url: PUBLIC_TIER2_URL }));
app.get('/v1/emergency/sos/timeline', async (req, res, next) => {
  try {
    const rows = await list(client(req), DATASETS.events, req);
    res.json(rows.slice(0, limitOf(req, 30)).map((event) => ({ event_id: event.id, event_code: event.event_code || null, title: event.title, severity: event.severity, status: event.status, created_at: event.created_at, source_ref: event.source || null, sla_breach_count: 0, last_update: event.updated_at || event.created_at })));
  } catch (error) { next(error); }
});
app.get('/v1/emergency', async (req, res, next) => { try { res.json(filterRows(await list(client(req), DATASETS.events, req), req)); } catch (error) { next(error); } });
app.get('/v1/emergency/:id', async (req, res, next) => { try { res.json(await get(client(req), DATASETS.events, req.params.id)); } catch (error) { next(error); } });
app.post('/v1/emergency', async (req, res, next) => { try { res.status(201).json(await write(client(req), DATASETS.events, { ...body(req), source: body(req).source || 'manual', status: body(req).status || 'monitoring', affected_asset_ids: body(req).affected_asset_ids || [], estimated_impact: body(req).estimated_impact || {}, instructions: body(req).instructions || [], tags: body(req).tags || [], metadata: body(req).metadata || {} })); } catch (error) { next(error); } });
app.put('/v1/emergency/:id', async (req, res, next) => { try { res.json(await update(client(req), DATASETS.events, req.params.id, body(req))); } catch (error) { next(error); } });
app.post('/v1/emergency/:id/resolve', async (req, res, next) => { try { res.json(await update(client(req), DATASETS.events, req.params.id, { status: 'resolved', ended_at: now(), resolution_note: body(req).resolution_note })); } catch (error) { next(error); } });

function crud(spec: Spec, prefix: string, options: { statusAction?: string } = {}) {
  app.get(prefix, async (req, res, next) => { try { res.json(filterRows(await list(client(req), spec, req), req)); } catch (error) { next(error); } });
  app.get(`${prefix}/:id`, async (req, res, next) => { try { res.json(await get(client(req), spec, req.params.id)); } catch (error) { next(error); } });
  app.post(prefix, async (req, res, next) => { try { res.status(201).json(await write(client(req), spec, body(req))); } catch (error) { next(error); } });
  app.put(`${prefix}/:id`, async (req, res, next) => { try { res.json(await update(client(req), spec, req.params.id, body(req))); } catch (error) { next(error); } });
  if (options.statusAction) app.post(`${prefix}/:id/${options.statusAction}`, async (req, res, next) => { try { res.json(await update(client(req), spec, req.params.id, body(req))); } catch (error) { next(error); } });
}

app.post('/v1/emergency/eop/generate-draft', async (req, res, next) => { try { res.status(201).json(await write(client(req), DATASETS.eop, { ...body(req), title: body(req).title || 'Emergency Operations Plan', status: 'draft', version: 1, objectives: [], operational_phases: ['prepare', 'respond', 'recover'], actions: [], assignment_matrix: [], evacuation_plan: [], fallback_plan: [], communications_plan: [], metadata: {} })); } catch (error) { next(error); } });
app.post('/v1/emergency/eop/:id/approve', async (req, res, next) => { try { res.json(await update(client(req), DATASETS.eop, req.params.id, { status: 'approved', review_notes: body(req).review_notes })); } catch (error) { next(error); } });
app.post('/v1/emergency/eop/:id/publish', async (req, res, next) => { try { res.json(await update(client(req), DATASETS.eop, req.params.id, { status: 'published', published_at: now() })); } catch (error) { next(error); } });
app.patch('/v1/emergency/eop/:id/markdown', async (req, res, next) => { try { res.json(await update(client(req), DATASETS.eop, req.params.id, body(req))); } catch (error) { next(error); } });
app.post('/v1/emergency/eop/:id/submit', async (req, res, next) => { try { const plan = await update(client(req), DATASETS.eop, req.params.id, { status: 'review_pending' }); res.json({ plan_id: plan.id, task_source: 'synapsecity-sos', orders: [] }); } catch (error) { next(error); } });
crud(DATASETS.eop, '/v1/emergency/eop');

app.post('/v1/emergency/dispatch/optimize', async (req, res) => res.json({ optimized: 0, auto_assigned: 0, stale_flagged: 0, eta_reestimated: 0, algorithm: 'tiered-capability-baseline', triggered_by: 'synapsecity-sos', optimized_at: now() }));
for (const [action, patch] of [['assign', { status: 'assigned' }], ['complete', { status: 'completed', completed_at: now() }], ['approve', { status: 'assigned' }], ['reject', { status: 'canceled' }]] as const) {
  app.post(`/v1/emergency/dispatch/:id/${action}`, async (req, res, next) => { try { res.json(await update(client(req), DATASETS.dispatch, req.params.id, { ...patch, ...body(req) })); } catch (error) { next(error); } });
}
crud(DATASETS.dispatch, '/v1/emergency/dispatch');

crud(DATASETS.resources, '/v1/emergency/resources', { statusAction: 'status' });
crud(DATASETS.sitrep, '/v1/emergency/sitrep');
app.post('/v1/emergency/sitrep/:id/delta', async (req, res, next) => { try { const current = await get(client(req), DATASETS.sitrep, req.params.id); const deltas = Array.isArray(current.deltas) ? current.deltas : []; res.json(await update(client(req), DATASETS.sitrep, req.params.id, { deltas: [...deltas, { ...body(req), created_at: now() }] })); } catch (error) { next(error); } });
app.post('/v1/emergency/sitrep/:id/publish', async (req, res, next) => { try { res.json(await update(client(req), DATASETS.sitrep, req.params.id, { status: 'published', published_at: now() })); } catch (error) { next(error); } });
app.post('/v1/emergency/after-action/generate', async (req, res, next) => { try { res.status(201).json(await write(client(req), DATASETS.afterAction, { ...body(req), report_code: `AAR-${Date.now()}`, title: body(req).title || 'After-action report', summary: body(req).summary_override || '', status: 'draft', timeline: [], kpi: { response_speed_score: 0, dispatch_completion_rate: 0, sitrep_coverage_rate: 0, resource_efficiency_score: 0, overall_score: 0 }, lessons_learned: body(req).lessons_learned || [], recommendations: body(req).recommendations || [], metadata: {} })); } catch (error) { next(error); } });
app.post('/v1/emergency/after-action/:id/publish', async (req, res, next) => { try { res.json(await update(client(req), DATASETS.afterAction, req.params.id, { status: 'published', published_at: now() })); } catch (error) { next(error); } });
crud(DATASETS.afterAction, '/v1/emergency/after-action');

// Hazards are the live flood/storm/landslide feed. They are published through
// Tier 2 so the public map and the command centre share one projection.
app.get('/v1/hazards/recent', async (req, res, next) => { try { const rows = await list(client(req), DATASETS.hazards, req); res.json(rows.slice(0, limitOf(req)).map((hazard) => ({ ...hazard, linked_event_id: hazard.linked_event_id || null, linked_eop_plan_id: hazard.linked_eop_plan_id || null }))); } catch (error) { next(error); } });
app.get('/v1/hazards/geo/near', async (req, res, next) => { try { res.json(await list(client(req), DATASETS.hazards, req)); } catch (error) { next(error); } });
app.post('/v1/hazards/geo/in-polygon', async (req, res, next) => { try { res.json(await list(client(req), DATASETS.hazards, req)); } catch (error) { next(error); } });
app.get('/v1/hazards/ingest/status', (_req, res) => res.json({ status: 'ready', last_run_at: null, source: 'synapsecity-sos', records_ingested: 0 }));
app.get('/v1/hazards/vndms-live', async (req, res, next) => { try { res.json(await list(client(req), DATASETS.hazards, req)); } catch (error) { next(error); } });
crud(DATASETS.hazards, '/v1/hazards');
app.post('/v1/hazards/:id/deploy', async (req, res, next) => {
  try {
    const hazard = await get(client(req), DATASETS.hazards, req.params.id);
    const event = await write(client(req), DATASETS.events, { title: hazard.title, description: hazard.description, event_type: hazard.event_type, severity: hazard.severity, source: 'forecast', status: 'active', location: { district: hazard.district, ward: hazard.ward }, geometry: hazard.geometry, metadata: { hazard_id: hazard.hazard_id || hazard.id } });
    const plan = await write(client(req), DATASETS.eop, { emergency_event_id: event.id, title: `EOP — ${event.title}`, status: 'draft', version: 1, objectives: [], operational_phases: ['respond'], actions: [], assignment_matrix: [], evacuation_plan: [], fallback_plan: [], communications_plan: [], metadata: {} });
    await update(client(req), DATASETS.hazards, req.params.id, { linked_event_id: event.id, linked_eop_plan_id: plan.id });
    res.json({ hazard, event, eop_plan: plan });
  } catch (error) { next(error); }
});

app.get('/v1/emergency/stream/hazards', async (req, res) => {
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = async () => {
    try { res.write(`event: hazards\\ndata: ${JSON.stringify({ snapshot: await list(client(req), DATASETS.hazards, req) })}\\n\\n`); }
    catch { res.write(`event: hazards\\ndata: ${JSON.stringify({ snapshot: [] })}\\n\\n`); }
  };
  await send();
  const timer = setInterval(() => { void send(); }, 30000);
  req.on('close', () => clearInterval(timer));
});

// The emergency assistant is intentionally capability-backed and stateless.
app.get('/v1/ai/status', (_req, res) => res.json({ status: 'ready', provider: 'synapsecity-sos', tier2: PUBLIC_TIER2_URL }));
app.post('/v1/ai/chat', async (req, res) => res.json({ message: 'SynapseCitySOS assistant is ready. Use the hazard, event, EOP and dispatch panels for operational actions.', citations: [], request: req.body }));

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = Number(error?.status) || (error instanceof CapabilitiesError ? Number(error.status) || 502 : 500);
  res.status(status).json({ error: error?.message || 'sos_service_error', upstream: error?.body });
});

if (require.main === module) app.listen(PORT, () => console.log(`[synapsecity-sos] emergency service listening on :${PORT}; Tier-2=${PUBLIC_TIER2_URL}`));
export { app };
