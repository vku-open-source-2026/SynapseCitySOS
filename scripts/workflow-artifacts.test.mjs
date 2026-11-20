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
import { validateBundle } from './lib/plugin-bundle.mjs';

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
        'eop.approve',
        'eop.publish',
        'eop.submit',
        'sitrep.delta',
        'sitrep.publish',
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

test('eop lifecycle workflows enforce four-eyes approvals and the route guards', () => {
    for (const operation of ['eop.approve', 'eop.publish', 'eop.submit']) {
        const entry = entryFor(operation);
        const workflow = readWorkflow(entry.file);
        const byName = new Map(workflow.nodes.map((node) => [node.name, node]));
        const fourEyes = byName.get('Enforce four-eyes approval readiness').parameters.code;
        assert.match(fourEyes, /approval_not_approved/);
        assert.match(fourEyes, /approval_entity_mismatch/);
        assert.match(fourEyes, /approval_action_mismatch/);
        assert.match(fourEyes, /self_approval_forbidden/, `${operation} must mirror the four-eyes rule`);
        const readApproval = byName.get('Read approval');
        assert.equal(readApproval.parameters.method, 'GET');
        assert.equal(readApproval.parameters.url, "={{ 'https://synapsedx.sbs/v1/capabilities/approvals/' + $json.encodedApprovalId }}");
        assert.equal(readApproval.parameters.auth.credentialRef, 'synapsedx-organization');
        assert.deepEqual(readApproval.parameters.auth.allowedOrigins, ['https://synapsedx.sbs']);
        assert.equal(readApproval.parameters.includeInput, true);
        assert.ok(byName.get('Read EOP plan').parameters.url.includes('/sos-eop-plans/'));
        const patch = workflow.nodes.filter((node) => node.type === 'httpRequest' && node.parameters.method === 'PATCH');
        assert.equal(patch.length, 1);
        assert.ok(patch[0].parameters.url.includes('/sos-eop-plans/'));
        assert.equal(patch[0].parameters.body, '={{ $json.body }}');
    }

    const approve = readWorkflow(entryFor('eop.approve').file);
    const approveCheck = new Map(approve.nodes.map((node) => [node.name, node])).get('Check plan and prepare approval patch').parameters.code;
    assert.match(approveCheck, /invalid_eop_status/);
    assert.match(approveCheck, /'approved'/);
    assert.match(approveCheck, /approved_role/);
    assert.match(approveCheck, /ifVersion: current\.version/);
    assert.deepEqual(approve.connections['Already approved?'].main.map((branch) => branch[0].node),
        ['Return idempotent approval', 'Patch approved plan']);

    const publish = readWorkflow(entryFor('eop.publish').file);
    const publishCheck = new Map(publish.nodes.map((node) => [node.name, node])).get('Check plan status and resolve approval').parameters.code;
    assert.match(publishCheck, /eop_not_approved/);
    assert.match(publishCheck, /approval_required/);
    assert.match(new Map(publish.nodes.map((node) => [node.name, node])).get('Match the admission approval').parameters.code, /approval_entity_mismatch/);
    assert.match(new Map(publish.nodes.map((node) => [node.name, node])).get('Prepare publication patch').parameters.code, /published_at/);

    const submit = readWorkflow(entryFor('eop.submit').file);
    const byName = new Map(submit.nodes.map((node) => [node.name, node]));
    assert.match(byName.get('Check plan and resolve approval').parameters.code, /eop_already_published/);
    assert.match(byName.get('Compute order seeds and missing creates').parameters.code, /eop_missing_orders_max_20/);
    assert.match(byName.get('Compute order seeds and missing creates').parameters.code, /query_truncated_dispatch/);
    assert.match(byName.get('Compute order seeds and missing creates').parameters.code, /source: 'eop-submit'/);
    assert.match(byName.get('Prepare submitted plan patch').parameters.code, /submitted_by/);
    const createSlots = submit.nodes.filter((node) => node.type === 'httpRequest' && node.parameters.method === 'POST' && node.parameters.url.endsWith('/sos-dispatch-orders/records'));
    assert.equal(createSlots.length, 20, 'the static fan must create at most 20 orders per run');
    for (let index = 0; index < createSlots.length; index += 1) {
        assert.equal(createSlots[index].parameters.body, `={{ $json.createBodies[${index}] }}`);
    }
    assert.equal(byName.get('Query existing plan orders').parameters.url, `${API}/sos-dispatch-orders/records/query`);
    assert.deepEqual(submit.connections['Create order 20?'].main.map((branch) => branch[0].node),
        ['Create dispatch order 20', 'Skip order 20']);
    assert.deepEqual(submit.connections['Collect created order 20'].main[0][0].node, 'Prepare submitted plan patch');
    assert.deepEqual(submit.connections['Skip order 20'].main[0][0].node, 'Prepare submitted plan patch');
});

test('sitrep publication and delta workflows mirror the reviewed route guards', () => {
    const publish = readWorkflow(entryFor('sitrep.publish').file);
    const byName = new Map(publish.nodes.map((node) => [node.name, node]));
    const guards = byName.get('Enforce SITREP publication guards').parameters.code;
    // Guard order mirrors assert_publishable: immutable first, content, review.
    assert.match(guards, /sitrep_already_published/);
    assert.match(guards, /sitrep_content_required/);
    assert.match(guards, /sitrep_review_required/);
    assert.ok(guards.indexOf('sitrep_already_published') < guards.indexOf('sitrep_content_required'));
    assert.ok(guards.indexOf('sitrep_content_required') < guards.indexOf('sitrep_review_required'));
    assert.match(guards, /'published'\s*,\s*\n\s*published_at/);
    assert.match(guards, /reviewed_by/);
    assert.match(guards, /ifVersion: current\.version/);
    assert.ok(byName.get('Read SITREP').parameters.url.includes('/sos-sitreps/'));

    const delta = readWorkflow(entryFor('sitrep.delta').file);
    const deltaNodes = new Map(delta.nodes.map((node) => [node.name, node]));
    const compute = deltaNodes.get('Compute structural delta').parameters.code;
    assert.match(compute, /changed_fields/);
    assert.match(compute, /from_revision/);
    assert.match(compute, /to_revision/);
    assert.match(compute, /sitrep_delta_empty/);
    assert.match(compute, /action_type: 'update'/);
    assert.match(deltaNodes.get('Check SITREP and resolve delta base').parameters.code, /sitrep_status_invalid/);
    assert.match(deltaNodes.get('Extract delta base').parameters.code, /sitrep_base_not_found/);
    assert.deepEqual(delta.connections['Has amended base?'].main.map((branch) => branch[0].node),
        ['Read amended base', 'Use current record as base']);
    assert.deepEqual(delta.connections['Create delta revision?'].main.map((branch) => branch[0].node),
        ['Prepare delta revision', 'Append delta entry']);
    const revision = deltaNodes.get('Prepare delta revision').parameters.code;
    assert.match(revision, /amends_sitrep_id: sitrep\.id/);
    assert.match(revision, /status: 'draft'/);
    assert.match(revision, /deltas: \[state\.deltaEntry\]/);
    assert.match(revision, /publish: false/);
    const append = deltaNodes.get('Append delta entry').parameters.code;
    assert.match(append, /ifVersion: state\.version/);
    assert.equal(deltaNodes.get('Create delta revision').parameters.method, 'POST');
    assert.equal(deltaNodes.get('Create delta revision').parameters.url, `${API}/sos-sitreps/records`);
    assert.equal(deltaNodes.get('Create delta revision').parameters.body, '={{ $json.createBody }}');
    assert.ok(deltaNodes.get('Validate DX envelope and action fields').parameters.code.includes('_non_negative_integer_required'), 'counters must be validated as non-negative integers');
    for (const counter of ['casualties', 'deaths', 'injuries', 'missing', 'affected_people', 'evacuated_people', 'damaged_structures', 'destroyed_structures', 'rescued_people', 'resources_deployed']) {
        assert.ok(deltaNodes.get('Validate DX envelope and action fields').parameters.code.includes(`'${counter}'`), `the ${counter} count field must be accepted`);
    }
});

test('workspace lifecycle guards reject invalid transitions and non-draft deletes', () => {
    const workflow = readWorkflow('plugins/workflows/sos-workspace-actions.workflow.json');
    const byName = new Map(workflow.nodes.map((node) => [node.name, node]));
    const validate = byName.get('Validate envelope and select operation').parameters.code;
    assert.match(validate, /allowedFrom/);
    assert.match(validate, /deleteFrom/);
    assert.ok(validate.includes('"requesting_agency"'), 'mutual aid must use the SOS domain schema');
    assert.ok(!validate.includes('requesting_org'), 'mutual aid must not use the incompatible workspace schema');
    assert.ok(validate.includes('"open"'));
    assert.ok(validate.includes('"partially_filled"'));
    assert.match(validate, /record\.request_number/);
    assert.match(validate, /record\.filled_quantity = 0/);
    assert.match(validate, /record\.history =/);
    assert.match(validate, /initial_status_invalid/);
    assert.ok(validate.includes('"draft"'), 'controlled records must start in draft');
    assert.match(validate, /status_requires_execute/);
    for (const unsafe of ['"publish":"published"', '"approve":"approved"', '"assign":"assigned"']) {
        assert.ok(!validate.includes(unsafe), `workspace must not bypass ${unsafe}`);
    }
    assert.ok(!validate.includes('assigned_resource_unit_id'), 'dispatch assignment must use the SOS reservation API');
    assert.match(validate, /_immutable/);
    const merge = byName.get('Merge and enforce invariants').parameters.code;
    assert.match(merge, /record_immutable/);
    assert.match(merge, /record_status_invalid/);
    assert.match(merge, /guard\.allowedFrom/);
    assert.ok(byName.has('Read record for delete'));
    assert.ok(byName.has('Check delete allowed'));
    assert.match(
        byName.get('Check delete allowed').parameters.code,
        /record_delete_forbidden/,
    );
});

test('product forms bind executable workflows; Common forms retain app-scoped capability actions', () => {
    const workflows = new Set([
        ...manifest.workflows.map((entry) => entry.workflow),
        ...(manifest.lifecycleWorkflows || []).map((entry) => entry.workflow),
    ]);
    if (manifest.genericActionWorkflow?.workflow) workflows.add(manifest.genericActionWorkflow.workflow);
    const forms = [];
    for (const name of fs.readdirSync(path.join(ROOT, 'plugins')).filter((file) => file.endsWith('.plugin.json'))) {
        const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', name), 'utf8'));
        assert.deepEqual(validateBundle(bundle).errors, [], name);
        for (const widget of bundle.plugin.widgets.filter((item) => item.type === 'form')) {
            const submit = bundle.plugin.widgets.find(item => item.id === widget.onSubmit)?.operation;
            assert.equal(submit?.target, widget.id, `${name}/${widget.id}: missing submit action`);
            assert.equal(submit?.kind, widget.action, `${name}/${widget.id}: wrong submit operation`);
            if (widget.resource.startsWith('common')) {
                assert.equal(widget.workflowRef, undefined, 'Common uses the app-scoped capability, never a product workflow');
                continue;
            }
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
