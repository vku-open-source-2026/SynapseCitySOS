// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Product-owned SOS workflow artifact checks.
 *
 * Creates POST to the Tier-2 records API. Dispatch transitions use
 * `includeInput:true`, merge invariants and PATCH the full record with
 * `ifVersion`. Event close chains event GET, dispatch/SITREP/resource queries,
 * AAR draft create (AAR-before-resolve) and event PATCH. Auth is the portable
 * `credentialRef:synapsedx-organization` / `X-API-Key`, public HTTPS Tier-2 only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'plugins', 'workflows');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const API = 'https://synapsedx.sbs/v1/capabilities/datasets';
const readWorkflow = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const entryFor = (operation) => manifest.workflows.find((entry) => entry.operation === operation);

test('manifest is SOS-owned, source-ready and inactive', () => {
    assert.equal(manifest.format, 'synapsedx-workflow-source');
    assert.equal(manifest.formatVersion, 3);
    assert.equal(manifest.product, 'sos');
    assert.equal(manifest.status, 'source_ready_pending_credential_binding');
    assert.equal(manifest.active, false);
    assert.equal(manifest.trigger, 'manualTrigger');
    assert.equal(manifest.repository, 'https://github.com/vku-open-source-2026/SynapseCitySOS');
    assert.deepEqual(manifest.bindingEnvelope, ['pluginId', 'widgetId', 'product', 'resource', 'submittedBy', 'submittedAt', 'fields', 'action']);
    assert.equal(manifest.persistence.credentialRef, 'synapsedx-organization');
    assert.equal(manifest.persistence.credentialHeader, 'X-API-Key');
    assert.deepEqual(manifest.engineContract.credentialAuth.allowedOrigins, ['https://synapsedx.sbs']);
    assert.equal(manifest.engineContract.includeInput, true);
    assert.equal(manifest.persistence.credentialBinding.status, 'pending_dx_binding');
    assert.match(manifest.persistence.credentialBinding.resolvedTo, /owner-only encrypted/);
    assert.equal(manifest.persistence.userSuppliedBinding, 'rejected');
    assert.equal(manifest.pluginWidgetBinding.portableField, 'workflowRef');
    assert.deepEqual(manifest.pluginWidgetBinding.resolvedFields, [
        'workflowArtifactId',
        'workflowArtifactRevision',
        'workflowArtifactChecksum',
    ]);
    assert.deepEqual(manifest.workflows.filter((entry) => entry.operation.endsWith('.create')).map((entry) => entry.operation).sort(), [
        'emergency.dispatch.create',
        'emergency.events.create',
    ]);
    assert.deepEqual(manifest.workflows.filter((entry) => entry.method === 'PATCH').map((entry) => entry.operation).sort(), [
        'dispatch.complete',
        'dispatch.reject',
        'emergency.close',
    ]);
    for (const entry of manifest.workflows) {
        assert.equal(entry.status, 'source_ready_pending_credential_binding');
        assert.ok(fs.existsSync(path.join(ROOT, entry.file)), entry.file);
        assert.equal(entry.dataset, manifest.persistence.datasetByResource[entry.resource]);
    }
});

test('create flows validate the DX envelope and POST to their fixed dataset', () => {
    for (const entry of manifest.workflows.filter((item) => item.operation.endsWith('.create'))) {
        const workflow = readWorkflow(entry.file);
        assert.equal(workflow.nodes.length, 3);
        const [trigger, validate, persist] = workflow.nodes;
        assert.equal(trigger.type, 'manualTrigger');
        const code = validate.parameters.code;
        for (const key of manifest.bindingEnvelope) assert.ok(code.includes(key), `${entry.workflow} ignores ${key}`);
        assert.match(code, /unknown_envelope_fields/);
        assert.match(code, /unsupported_product/);
        assert.match(code, /unsupported_resource/);
        assert.ok(code.includes(`dataset: '${entry.dataset}'`));
        assert.ok(code.includes('body: { data: record, publish:'));
        if (entry.operation === 'emergency.events.create') {
            assert.ok(code.includes('publish: true'));
            assert.match(code, /event_type_invalid/);
        } else {
            assert.ok(code.includes('publish: false'));
            assert.match(code, /emergency_event_id_required_max_128/);
        }
        assert.equal(persist.type, 'httpRequest');
        assert.equal(persist.parameters.method, 'POST');
        assert.equal(persist.parameters.url, `${API}/${entry.dataset}/records`);
        assert.equal(persist.parameters.auth.credentialRef, 'synapsedx-organization');
        assert.equal(persist.parameters.auth.header, 'X-API-Key');
        assert.deepEqual(persist.parameters.auth.allowedOrigins, ['https://synapsedx.sbs']);
        assert.equal(persist.parameters.auth.credentialId, undefined);
        assert.deepEqual(workflow.connections[validate.name].main[0][0].node, persist.name);
    }
});

test('dispatch status flows use includeInput, invariants and conditional full PATCH', () => {
    for (const operation of ['dispatch.complete', 'dispatch.reject']) {
        const entry = entryFor(operation);
        const workflow = readWorkflow(entry.file);
        assert.equal(workflow.nodes.length, 5);
        const [, validate, read, merge, patch] = workflow.nodes;
        assert.equal(validate.type, 'code');
        assert.equal(read.parameters.method, 'GET');
        assert.equal(read.parameters.includeInput, true);
        assert.equal(read.parameters.auth.credentialRef, 'synapsedx-organization');
        assert.equal(read.parameters.auth.header, 'X-API-Key');
        assert.deepEqual(read.parameters.auth.allowedOrigins, ['https://synapsedx.sbs']);
        const mergeCode = merge.parameters.code;
        assert.match(mergeCode, /response\.input/);
        assert.match(mergeCode, /\.\.\.data, \.\.\.action\.patch/);
        assert.match(mergeCode, /ifVersion: current\.version/);
        assert.match(mergeCode, /record_terminal/);
        assert.match(mergeCode, /record_status_invalid/);
        if (operation === 'dispatch.complete') {
            assert.match(mergeCode, /dispatch_assignment_required/);
            assert.ok(mergeCode.includes('"on_scene"'));
        } else {
            assert.ok(!mergeCode.includes('dispatch_assignment_required'), 'reject must not demand an assignment');
            assert.ok(!mergeCode.includes('"in_transit"'), 'only pending/assigned may be rejected');
        }
        assert.equal(patch.parameters.method, 'PATCH');
        assert.equal(patch.parameters.body, '={{ $json.body }}');
        assert.deepEqual(workflow.connections[read.name].main[0][0].node, merge.name);
        assert.deepEqual(workflow.connections[merge.name].main[0][0].node, patch.name);
    }
});

test('event close creates the AAR before patching the resolved event', () => {
    const entry = entryFor('emergency.close');
    const workflow = readWorkflow(entry.file);
    assert.ok(workflow.nodes.length >= 12, 'event close needs the query/AAR chain');
    const byName = new Map(workflow.nodes.map((node) => [node.name, node]));
    assert.equal(byName.get('Read event').parameters.includeInput, true);
    assert.equal(byName.get('Query dispatch orders').parameters.includeInput, true);
    assert.equal(byName.get('Create AAR draft').parameters.includeInput, true);
    assert.equal(byName.get('Create AAR draft').parameters.url, `${API}/sos-after-action-reports/records`);
    assert.equal(byName.get('Create AAR draft').parameters.method, 'POST');
    assert.equal(byName.get('Patch resolved event').parameters.method, 'PATCH');
    assert.equal(byName.get('Patch resolved event').parameters.body, '={{ $json.body }}');
    assert.equal(byName.get('Patch resolved event').parameters.auth.credentialRef, 'synapsedx-organization');
    assert.deepEqual(byName.get('Patch resolved event').parameters.auth.allowedOrigins, ['https://synapsedx.sbs']);

    const queryUrl = byName.get('Query dispatch orders').parameters.url;
    assert.equal(queryUrl, `${API}/sos-dispatch-orders/records/query`);
    assert.equal(byName.get('Query existing AARs').parameters.url, `${API}/sos-after-action-reports/records/query`);
    assert.equal(byName.get('Query existing AARs').parameters.includeInput, true);
    for (const name of ['Extract dispatch orders', 'Extract SITREPs', 'Extract resources']) {
        assert.match(byName.get(name).parameters.code, /item\.data/, `${name} must unwrap the Tier-2 record envelope`);
    }
    const compute = byName.get('Compute AAR and prepare create').parameters.code;
    assert.match(compute, /kpi/);
    assert.match(compute, /response_speed_score/);
    assert.match(compute, /status: 'draft'/);
    assert.match(compute, /overall=0\.3\*response\+0\.3\*dispatch\+0\.2\*sitrep\+0\.2\*resource/);
    assert.match(compute, /generated_by: 'sos-kpi-engine-v1'/);
    assert.match(compute, /generated_by_user: state\.closedBy/);
    assert.match(compute, /metadata: \{/);
    const decide = byName.get('Decide close path and version').parameters.code;
    assert.match(decide, /'idempotent'/);
    assert.match(decide, /'reuse'/);
    assert.match(decide, /'create'/);
    assert.match(decide, /latestAaR/);
    assert.match(decide, /closedAt: \$now/);
    assert.match(byName.get('Already resolved?').parameters.condition, /idempotent/);
    assert.match(byName.get('Reuse existing AAR?').parameters.condition, /reuse/);
    assert.match(byName.get('Return idempotent close').parameters.code, /idempotent: true/);
    assert.match(byName.get('Prepare event patch with existing AAR').parameters.code, /state\.latestAaR\.id/);
    assert.match(byName.get('Prepare event patch with existing AAR').parameters.code, /ifVersion: state\.version/);
    const patch = byName.get('Prepare event patch').parameters.code;
    assert.match(patch, /ifVersion: state\.version/);
    assert.match(patch, /after_action_report_id/);
    assert.match(patch, /ended_at: state\.closedAt/);
    assert.match(patch, /status: 'resolved'/);
    assert.match(byName.get('Check terminal state and prepare queries').parameters.code, /event_terminal/);
    assert.match(byName.get('Check terminal state and prepare queries').parameters.code, /event_status_invalid/);

    // AAR-before-resolve is enforced by the typed connection graph:
    // create -> prepare -> patch, and reuse -> patch without a create.
    const out = (name) => workflow.connections[name].main.map((branch) => branch[0].node);
    assert.deepEqual(out('Already resolved?'), ['Return idempotent close', 'Reuse existing AAR?']);
    assert.deepEqual(out('Reuse existing AAR?'), ['Prepare event patch with existing AAR', 'Compute AAR and prepare create']);
    assert.deepEqual(out('Compute AAR and prepare create'), ['Create AAR draft']);
    assert.deepEqual(out('Create AAR draft'), ['Prepare event patch']);
    assert.deepEqual(out('Prepare event patch'), ['Patch resolved event']);
    assert.deepEqual(out('Prepare event patch with existing AAR'), ['Patch resolved event']);
    assert.equal(workflow.connections['Return idempotent close'], undefined);
});

test('AAR versioning and idempotency rules match the SOS domain service', () => {
    const rules = manifest.aarInvariants;
    assert.equal(rules.dataset, 'sos-after-action-reports');
    assert.match(rules.idPattern, /v<version>/);
    assert.match(rules.reportCodePattern, /event_code/);
    assert.match(rules.versionSource, /highest existing AAR version/);
    assert.equal(rules.status, 'draft');
    assert.equal(rules.publish, false);
    assert.equal(rules.generatedBy, 'sos-kpi-engine-v1');
    assert.match(rules.formula, /overall=0\.3\*response/);
    assert.ok(rules.metadata.includes('generated_by_user'));
    const close = manifest.transitionRules.close;
    assert.deepEqual(close.allowedFrom, ['monitoring', 'active', 'contained']);
    assert.deepEqual(close.idempotentStatuses, ['resolved']);
    assert.deepEqual(close.refusedStatuses, ['canceled', 'archived']);
    assert.ok(close.invariants.some((text) => /reused instead of duplicated/.test(text)));
    assert.ok(close.invariants.some((text) => /same close timestamp/.test(text)));
    assert.ok(close.invariants.some((text) => /409 version_conflict/.test(text)));
    assert.ok(manifest.transitionRules.complete.requiresAssignment);
    assert.deepEqual(manifest.transitionRules.reject.allowedFrom, ['pending', 'assigned']);
});

test('no artifact writes via a projection, Base SDK or Tier-3 API', () => {
    for (const entry of manifest.workflows) {
        const text = JSON.stringify(readWorkflow(entry.file));
        assert.ok(!/webhook|publish-record|synapseone\.api/.test(text), 'no webhook/LDS/first-party projection node');
        assert.ok(!/synapsecity\.sbs|\/v1\/assets|\/v1\/incidents|\/v1\/maintenance/i.test(text), 'no City references');
        assert.ok(!/\/v1\/emergency/.test(text), 'no Tier-3 API path');
        assert.ok(!/import\s*\(|eval\s*\(|require\s*\(/.test(text), 'validation code must not load remote code');
        const urls = [...text.matchAll(/https?:\/\/[^"']+/g)].map((match) => match[0]);
        for (const url of urls) {
            assert.equal(new URL(url).origin, 'https://synapsedx.sbs', `unexpected URL ${url}`);
        }
    }
});

test('every credential-backed request pins the exact Tier-2 origin', () => {
    for (const entry of manifest.workflows) {
        const workflow = readWorkflow(entry.file);
        for (const node of workflow.nodes) {
            const auth = node.parameters && node.parameters.auth;
            if (node.type !== 'httpRequest' || !auth) continue;
            assert.equal(auth.credentialRef, 'synapsedx-organization');
            assert.equal(auth.header, 'X-API-Key');
            assert.deepEqual(auth.allowedOrigins, ['https://synapsedx.sbs']);
            assert.equal(auth.credentialId, undefined, 'a deployment credential id must not be committed');
            assert.ok(node.parameters.url.includes('https://synapsedx.sbs/'), node.parameters.url);
            const origins = [...node.parameters.url.matchAll(/https?:\/\/[^/"' ]+/g)].map((match) => match[0]);
            assert.deepEqual(origins, ['https://synapsedx.sbs'], 'credential destination must be the public Tier-2 origin only');
        }
    }
});

test('transition action design is implemented and keeps invariants', () => {
    const design = JSON.parse(fs.readFileSync(path.join(DIR, 'actions.design.json'), 'utf8'));
    assert.equal(design.product, 'sos');
    assert.equal(design.status, 'implemented_source_ready');
    assert.match(design.implementation, /includeInput/);
    assert.match(design.blocker, /ifVersion/);
    for (const action of design.actions) {
        assert.equal(action.method, 'PATCH');
        assert.ok(action.fields.some((field) => field.required));
        assert.ok(action.allowedFrom.length >= 1);
        assert.ok(manifest.workflows.some((entry) => entry.operation === action.operation), `${action.operation} has no workflow`);
        if (action.operation === 'emergency.close') {
            assert.equal(action.createBefore.dataset, 'sos-after-action-reports');
            assert.match(action.createBefore.invariant, /AAR first/);
        }
    }
});

test('plugin bundles bind every form to an executable declarative workflow', () => {
    const workflows = new Set([
        ...manifest.workflows.map((entry) => entry.workflow),
        ...(manifest.lifecycleWorkflows || []).map((entry) => entry.workflow),
    ]);
    if (manifest.genericActionWorkflow?.workflow) workflows.add(manifest.genericActionWorkflow.workflow);
    const forms = [];
    for (const name of fs.readdirSync(path.join(ROOT, 'plugins')).filter((file) => file.endsWith('.plugin.json'))) {
        const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', name), 'utf8'));
        for (const widget of bundle.plugin.widgets.filter((item) => item.type === 'form')) {
            forms.push(widget);
            assert.ok(widget.workflowRef && widget.workflowRef.name, `${name}/${widget.id} lacks workflowRef`);
            assert.ok(['create', 'update', 'delete', 'execute'].includes(widget.action), `${name}/${widget.id} action`);
            assert.ok(workflows.has(widget.workflowRef.name), `${name}/${widget.id} references unknown workflow ${widget.workflowRef.name}`);
            assert.ok(widget.fields.length >= 1);
        }
    }
    assert.ok(forms.length >= 5, 'expected bound SOS forms');
    assert.ok(forms.some((widget) => widget.action === 'create'));
    assert.ok(forms.some((widget) => widget.action === 'update'));
});
