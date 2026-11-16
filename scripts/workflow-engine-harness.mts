// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * LOCAL TEST-ONLY harness: execute a Tier-3 workflow artifact through the real
 * Tier-1 SynapseFlow engine with a fake HTTP transport.
 *
 * Modes: good | malformed | terminal | conflict | existing-aar | resolved |
 * unassigned. It simulates DX server-side credentialRef binding in memory only
 * and never uses a real credential, network, deployment or Docker.
 *
 * The fake records use the real Tier-2 record envelope
 * `{ id, data, version }` so the AAR chain is validated against the product
 * contract rather than a flattened shortcut.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };

const MODES = ['good', 'malformed', 'terminal', 'conflict', 'existing-aar', 'resolved', 'unassigned', 'truncated'];
const [workflowPath, dataset, credentialRef, mode] = process.argv.slice(2);
if (!workflowPath || !dataset || !credentialRef || !MODES.includes(mode || '')) {
    console.log(JSON.stringify({ ok: false, error: `usage: <workflow.json> <dataset> <credentialRef> <${MODES.join('|')}>` }));
    process.exit(2);
}

const enginePath = process.env.SYNAPSEONE_ENGINE
    || new URL('../../../SynapseOne/apps/workflow-service/src/engine.ts', import.meta.url).pathname;
if (!fs.existsSync(enginePath)) {
    console.log(JSON.stringify({ ok: false, error: 'engine_not_found', enginePath }));
    process.exit(3);
}

const { runWorkflow } = await import(pathToFileURL(enginePath).href) as {
    runWorkflow: (definition: unknown, input: unknown, options: unknown) => Promise<{
        status: string;
        error?: string;
        output: unknown;
        nodeRuns: Array<{ node: string; type: string; output: unknown; status: string; error?: string }>;
    }>;
};

const kind = workflowPath.includes('create') ? 'create'
    : workflowPath.includes('close') ? 'close'
        : 'transition';
const calls: Call[] = [];
const credentialResolutions: string[] = [];
const BOUND_CREDENTIAL_ID = 'bound-test-credential';

const ids: Record<string, string> = {
    incident: 'incident-1',
    maintenance: 'wo-1',
    dispatch: 'dispatch-1',
    event: 'event-1',
};
const subject = workflowPath.includes('maintenance') ? 'maintenance'
    : workflowPath.includes('incident') ? 'incident'
        : workflowPath.includes('dispatch') ? 'dispatch' : 'event';
const recordId = ids[subject];
const terminal = mode === 'terminal';
const nowMs = Date.now();
const startMs = nowMs - 2 * 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const record = (() => {
    if (subject === 'incident') {
        return {
            id: recordId,
            data: { type: 'Incident', title: 'Existing incident', description: 'keep me', category: 'damage', severity: 'high', status: terminal ? 'resolved' : 'reported', assigned_to: 'old-operator', unrelated: { keep: true } },
            version: 3,
        };
    }
    if (subject === 'maintenance') {
        return {
            id: recordId,
            data: { type: 'Maintenance', title: 'Existing work order', description: 'keep me', asset_id: 'asset-1', priority: 'medium', status: terminal ? 'completed' : (workflowPath.includes('complete') ? 'in_progress' : 'scheduled'), assigned_to: 'tech-old', unrelated: { keep: true } },
            version: 3,
        };
    }
    if (subject === 'dispatch') {
        const unassigned = mode === 'unassigned';
        return {
            id: recordId,
            data: {
                type: 'DispatchOrder', emergency_event_id: 'event-1', task_title: 'Existing task',
                status: terminal ? 'completed' : 'pending', priority: 'medium',
                assignments: unassigned ? [] : [{ assigned_resource_unit_id: 'resource-1', assigned_at: iso(startMs + 20 * 60_000) }],
                ...(unassigned ? {} : { assigned_resource_unit_id: 'resource-1' }),
                metadata: { keep: true },
            },
            version: 4,
        };
    }
    return {
        id: recordId,
        data: {
            type: 'EmergencyEvent', title: 'Flood AAR', description: 'keep me', event_code: 'EV-AAR',
            event_type: 'flood', severity: 'high',
            status: mode === 'resolved' ? 'resolved' : terminal ? 'canceled' : 'active',
            created_at: iso(startMs), started_at: iso(startMs), metadata: { keep: true },
        },
        version: 5,
    };
})();

const existingAar = {
    id: 'aar-event-1-v2',
    data: {
        id: 'aar-event-1-v2', emergency_event_id: 'event-1', report_code: 'AAR-EV-AAR-v2',
        title: 'After-action report — Flood AAR', status: 'draft', version: 2,
        kpi: { overall_score: 42 }, generated_by: 'sos-kpi-engine-v1',
    },
    version: 3,
};

// Legacy SOS contract fixture: 2h event, first assignment at +20m, one
// completed order and one canceled order, one published SITREP, one free
// resource. Expected KPI: response 20m → 100, dispatch 100, SITREP 100,
// resource 50, overall 90.
const dispatchRows = [
    {
        id: 'dispatch-1',
        data: {
            id: 'dispatch-1', emergency_event_id: 'event-1', task_title: 'Evacuate', status: 'completed', priority: 'high',
            assigned_resource_unit_id: 'resource-1', created_at: iso(startMs + 10 * 60_000),
            completed_at: iso(startMs + 90 * 60_000),
            assignments: [{ assigned_resource_unit_id: 'resource-1', assigned_at: iso(startMs + 20 * 60_000) }],
        },
        version: 2,
    },
    {
        id: 'dispatch-2',
        data: {
            id: 'dispatch-2', emergency_event_id: 'event-1', task_title: 'Canceled', status: 'canceled', priority: 'low',
            created_at: iso(startMs + 15 * 60_000), assignments: [],
        },
        version: 2,
    },
];
const sitrepRows = [
    {
        id: 'sitrep-1',
        data: {
            id: 'sitrep-1', emergency_event_id: 'event-1', title: 'SITREP', status: 'published',
            created_at: iso(startMs + 30 * 60_000), published_at: iso(startMs + 40 * 60_000),
        },
        version: 1,
    },
];
const resourceRows = [
    { id: 'resource-1', data: { id: 'resource-1', status: 'deployed' }, version: 1 },
    { id: 'resource-2', data: { id: 'resource-2', status: 'available' }, version: 1 },
];

globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
    const headers: Record<string, string> = {};
    const rawHeaders = init.headers || {};
    if (rawHeaders instanceof Headers) rawHeaders.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    else if (Array.isArray(rawHeaders)) for (const [key, value] of rawHeaders) headers[String(key).toLowerCase()] = String(value);
    else for (const [key, value] of Object.entries(rawHeaders as Record<string, string>)) headers[key.toLowerCase()] = String(value);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body ? String(init.body) : null;
    calls.push({ url, method, headers, body });

    const pathDataset = url.includes('/datasets/') ? url.split('/datasets/')[1].split('/')[0] : dataset;
    if (url.includes('/records/query')) {
        if (pathDataset === 'sos-dispatch-orders') {
            const total = mode === 'truncated' ? 999 : dispatchRows.length;
            return Response.json({ items: dispatchRows, total, limit: 500, offset: 0 });
        }
        if (pathDataset === 'sos-sitreps') {
            return Response.json({ items: sitrepRows, total: sitrepRows.length, limit: 100, offset: 0 });
        }
        if (pathDataset === 'sos-resource-units') {
            return Response.json({ items: resourceRows, total: resourceRows.length, limit: 200, offset: 0 });
        }
        const hasAar = mode === 'existing-aar' || mode === 'resolved';
        const items = hasAar ? [existingAar] : [];
        return Response.json({ items, total: items.length, limit: 50, offset: 0 });
    }

    if (method === 'GET') {
        return Response.json(record);
    }
    if (method === 'PATCH') {
        if (mode === 'conflict') {
            return Response.json({ error: 'version_conflict', message: 'record was modified' }, { status: 409 });
        }
        const parsed = body ? JSON.parse(body) : {};
        return Response.json({ id: recordId, data: parsed.data, version: record.version + 1 });
    }
    if (method === 'POST') {
        const parsed = body ? JSON.parse(body) : {};
        const created = {
            id: pathDataset === 'sos-after-action-reports' ? parsed.id : 'record-test-1',
            data: parsed.data,
            version: 1,
        };
        return Response.json(created, { status: 201 });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
}) as typeof fetch;

const definition = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const sourceCredentialRefs: string[] = [];
const allowedOrigins: string[][] = [];
for (const node of definition.nodes || []) {
    const auth = node?.parameters?.auth;
    if (node?.type === 'httpRequest' && auth?.credentialRef) {
        sourceCredentialRefs.push(String(auth.credentialRef));
        allowedOrigins.push(Array.isArray(auth.allowedOrigins) ? auth.allowedOrigins.map(String) : []);
        auth.credentialId = BOUND_CREDENTIAL_ID;
    }
}

const baseEnvelope = {
    pluginId: 'plugin-test',
    widgetId: 'widget-test',
    product: workflowPath.includes('SynapseCitySOS') ? 'sos' : 'city',
    resource: subject === 'incident' ? 'incidents'
        : subject === 'maintenance' ? 'maintenance'
            : subject === 'dispatch' ? 'dispatch' : 'events',
    submittedBy: 'member-test',
    submittedAt: '2026-11-14T00:00:00.000Z',
    fields: {},
};
const createFields: Record<string, string> = {
    title: 'Bridge inspection',
    description: 'Cracked support beam',
    category: 'damage',
    severity: 'high',
    asset_id: 'asset-1',
    priority: 'high',
    scheduled_date: '2026-11-20',
    event_type: 'flood',
    emergency_event_id: 'event-1',
    task_title: 'Deploy rescue boat',
    task_description: 'Check the low-lying ward',
};
const transitionFields: Record<string, string> = subject === 'incident'
    ? (workflowPath.includes('resolve')
        ? { incident_id: recordId, resolution_notes: 'Fixed the span', resolution_type: 'fixed' }
        : { incident_id: recordId, assigned_to: 'operator-2' })
    : subject === 'maintenance'
        ? (workflowPath.includes('assign')
            ? { work_order_id: recordId, assigned_to: 'tech-2' }
            : { work_order_id: recordId })
        : subject === 'dispatch'
            ? { order_id: recordId }
            : { event_id: recordId, resolution_note: 'Event closed after final sweep' };
if (mode === 'malformed') {
    baseEnvelope.fields = { description: 'malformed submission' };
} else if (kind === 'create') {
    baseEnvelope.fields = Object.fromEntries(Object.entries(createFields).filter(([key]) => {
        if (workflowPath.includes('incident')) return ['title', 'description', 'category', 'severity'].includes(key);
        if (workflowPath.includes('maintenance')) return ['asset_id', 'title', 'description', 'priority', 'scheduled_date'].includes(key);
        if (workflowPath.includes('event')) return ['title', 'description', 'event_type', 'severity'].includes(key);
        return ['emergency_event_id', 'task_title', 'task_description', 'priority'].includes(key);
    }));
} else {
    baseEnvelope.fields = transitionFields;
}

let result;
try {
    result = await runWorkflow(definition, baseEnvelope, {
        name: 'tier3-workflow-engine-test',
        principal: { sub: 'member-test', kind: 'user' },
        credentialResolver: async (id: string) => {
            credentialResolutions.push(id);
            return id === BOUND_CREDENTIAL_ID ? { kind: 'api-key', secret: 'test-api-key-secret' } : null;
        },
    });
} catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), calls, credentialResolutions, sourceCredentialRefs, allowedOrigins }));
    process.exit(1);
}

const validationRun = result.nodeRuns.find((run) => run.node.startsWith('Validate DX envelope'));
console.log(JSON.stringify({
    ok: true,
    kind,
    mode,
    status: result.status,
    error: result.error,
    output: result.output,
    calls,
    credentialResolutions,
    sourceCredentialRefs,
    allowedOrigins,
    validationOutput: validationRun?.output ?? null,
    nodeRuns: result.nodeRuns.map((run) => ({ node: run.node, type: run.type, status: run.status, error: run.error })),
}));
