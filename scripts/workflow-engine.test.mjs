// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * LOCAL TEST-ONLY: execute SOS workflow artifacts through the real Tier-1
 * SynapseFlow engine with a fake HTTP transport.
 *
 * The fake records use the real Tier-2 record envelope `{id,data,version}`.
 * Covers creates, dispatch status transitions (GET includeInput -> merge ->
 * conditional PATCH), the dispatch assignment invariant, event close
 * (AAR-before-resolve), legacy KPI values, AAR reuse/idempotency, malformed
 * rejection before HTTP, terminal refusal and CAS conflict propagation.
 * No network, real credential or deployment is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = path.resolve(ROOT, '..');
const TSX = path.join(WORKSPACE, 'SynapseOne', 'node_modules', '.bin', 'tsx');
const ENGINE = path.join(WORKSPACE, 'SynapseOne', 'apps', 'workflow-service', 'src', 'engine.ts');
const HARNESS = path.join(ROOT, 'scripts', 'workflow-engine-harness.mts');
const PARITY = path.join(ROOT, 'scripts', 'aar-parity.mts');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'workflows', 'manifest.json'), 'utf8'));
const available = fs.existsSync(TSX) && fs.existsSync(ENGINE);
const skipReason = available ? '' : 'sibling SynapseOne engine/tsx not available; engine test is local-only';

function runHarness(workflowFile, dataset, mode = 'good') {
    const stdout = execFileSync(TSX, [HARNESS, path.join(ROOT, workflowFile), dataset, 'synapsedx-organization', mode], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SYNAPSEONE_ENGINE: ENGINE, NODE_NO_WARNINGS: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout.trim().split('\n').at(-1));
}

const entryFor = (operation) => manifest.workflows.find((entry) => entry.operation === operation);
const callPath = (call) => `${call.method} ${new URL(call.url).pathname}`;

test('real engine executes valid creates with audited mutations', { skip: available ? false : skipReason }, () => {
    for (const entry of manifest.workflows.filter((item) => item.operation.endsWith('.create'))) {
        const result = runHarness(entry.file, entry.dataset);
        assert.equal(result.status, 'success', `${entry.workflow}: ${result.error}`);
        assert.equal(result.calls.length, 1);
        const call = result.calls[0];
        assert.equal(call.method, 'POST');
        assert.equal(call.url, `https://synapsedx.sbs/v1/capabilities/datasets/${entry.dataset}/records`);
        assert.equal(call.headers['x-api-key'], 'test-api-key-secret');
        const body = JSON.parse(call.body);
        assert.equal(body.data.type, entry.dataset === 'sos-emergency-events' ? 'EmergencyEvent' : 'DispatchOrder');
        assert.equal(body.publish, entry.dataset === 'sos-emergency-events');
        assert.deepEqual(result.credentialResolutions, ['bound-test-credential']);
        assert.deepEqual(result.sourceCredentialRefs, ['synapsedx-organization']);
        assert.deepEqual(result.allowedOrigins, [['https://synapsedx.sbs']]);
        assert.equal(result.validationOutput.audit.operation, entry.operation);
    }
});

test('real engine merges and conditionally patches dispatch status', { skip: available ? false : skipReason }, () => {
    for (const operation of ['dispatch.complete', 'dispatch.reject']) {
        const entry = entryFor(operation);
        const result = runHarness(entry.file, entry.dataset);
        assert.equal(result.status, 'success', `${entry.workflow}: ${result.error}`);
        assert.equal(result.calls.length, 2);
        const [read, patch] = result.calls;
        assert.equal(read.method, 'GET');
        assert.equal(patch.method, 'PATCH');
        assert.equal(patch.headers['x-api-key'], 'test-api-key-secret');
        const body = JSON.parse(patch.body);
        assert.equal(body.ifVersion, 4);
        assert.equal(body.data.metadata.keep, true, 'unrelated dispatch data was erased');
        assert.equal(body.data.task_title, 'Existing task');
        assert.equal(body.data.status, operation === 'dispatch.complete' ? 'completed' : 'canceled');
        assert.equal(body.data.assignments.length, 1, 'assignment history was not preserved');
        if (operation === 'dispatch.complete') {
            assert.equal(typeof body.data.completed_at, 'string');
        }
    }
});

test('dispatch completion requires a real assignment', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('dispatch.complete');
    const result = runHarness(entry.file, entry.dataset, 'unassigned');
    assert.equal(result.status, 'error');
    assert.match(String(result.error || ''), /dispatch_assignment_required/);
    assert.equal(result.calls.length, 1, 'an unassigned order must stop after the read');
    assert.equal(result.calls[0].method, 'GET');
});

test('real engine creates the AAR before patching the resolved event', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('emergency.close');
    const result = runHarness(entry.file, entry.dataset);
    assert.equal(result.status, 'success', `${entry.workflow}: ${result.error}`);
    const methods = result.calls.map(callPath);
    assert.deepEqual(methods, [
        'GET /v1/capabilities/datasets/sos-emergency-events/records/event-1',
        'POST /v1/capabilities/datasets/sos-dispatch-orders/records/query',
        'POST /v1/capabilities/datasets/sos-sitreps/records/query',
        'POST /v1/capabilities/datasets/sos-resource-units/records/query',
        'POST /v1/capabilities/datasets/sos-after-action-reports/records/query',
        'POST /v1/capabilities/datasets/sos-after-action-reports/records',
        'PATCH /v1/capabilities/datasets/sos-emergency-events/records/event-1',
    ]);
    const aarCall = result.calls[5];
    const aarBody = JSON.parse(aarCall.body);
    assert.equal(aarBody.id, 'aar-event-1-v1', 'the AAR id must use the legacy versioned form');
    assert.equal(aarBody.data.id, 'aar-event-1-v1');
    assert.equal(aarBody.data.version, 1);
    assert.equal(aarBody.data.report_code, 'AAR-EV-AAR-v1');
    assert.equal(aarBody.data.status, 'draft');
    assert.equal(aarBody.data.emergency_event_id, 'event-1');
    assert.equal(aarBody.publish, false);

    // Values match the SOS domain KPI fixture in apps/sos-service (issue #16):
    // 2h event, first assignment at +20m, 1 completed + 1 canceled order,
    // 1/1 published SITREP, 1 assigned + 1 free resource.
    assert.deepEqual(aarBody.data.kpi, {
        response_time_minutes: 20,
        response_sla_minutes: 60,
        response_speed_score: 100,
        dispatch_completion_rate: 100,
        sitrep_coverage_rate: 100,
        resource_efficiency_score: 50,
        overall_score: 90,
        dispatch_total: 2,
        dispatch_completed: 1,
        dispatch_canceled: 1,
        sitrep_published: 1,
        sitrep_expected: 1,
        resources_assigned: 1,
        resources_available: 1,
    });
    assert.ok(aarBody.data.timeline.length >= 7);
    assert.deepEqual(aarBody.data.timeline.map((row) => row.action).slice(-3), ['sitrep.published', 'dispatch.completed', 'event.resolved']);
    assert.equal(aarBody.data.metadata.first_assignment_at, aarBody.data.timeline.find((row) => row.action === 'dispatch.assigned').timestamp);
    assert.equal(aarBody.data.metadata.generated_by, 'sos-kpi-engine-v1');
    assert.equal(aarBody.data.metadata.generated_by_user, 'member-test');
    assert.match(aarBody.data.summary, /1\/1 nhiệm vụ hoàn thành/);

    const patchBody = JSON.parse(result.calls[6].body);
    assert.equal(patchBody.ifVersion, 5);
    assert.equal(patchBody.data.status, 'resolved');
    assert.equal(patchBody.data.after_action_report_id, 'aar-event-1-v1');
    assert.equal(patchBody.data.metadata.keep, true, 'unrelated event data was erased');
    assert.equal(patchBody.data.description, 'keep me');
    assert.equal(patchBody.data.resolution_note, 'Event closed after final sweep');
    assert.equal(patchBody.data.resolved_by, 'member-test');
    assert.equal(patchBody.data.ended_at, aarBody.data.metadata.event_end, 'AAR window and event ended_at must be the same close timestamp');
    assert.equal(result.validationOutput.audit.operation, 'emergency.close');
});

test('an existing AAR is reused instead of duplicated', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('emergency.close');
    const result = runHarness(entry.file, entry.dataset, 'existing-aar');
    assert.equal(result.status, 'success', `${entry.workflow}: ${result.error}`);
    const methods = result.calls.map(callPath);
    assert.ok(!methods.includes('POST /v1/capabilities/datasets/sos-after-action-reports/records'), 'reuse created a second AAR');
    assert.equal(methods.at(-1), 'PATCH /v1/capabilities/datasets/sos-emergency-events/records/event-1');
    const patchBody = JSON.parse(result.calls.at(-1).body);
    assert.equal(patchBody.data.after_action_report_id, 'aar-event-1-v2');
    assert.equal(patchBody.ifVersion, 5);
});

test('closing an already resolved event is idempotent and writes nothing', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('emergency.close');
    const result = runHarness(entry.file, entry.dataset, 'resolved');
    assert.equal(result.status, 'success', `${entry.workflow}: ${result.error}`);
    const writes = result.calls.filter((call) => call.method === 'PATCH' || (call.method === 'POST' && !call.url.endsWith('/records/query')));
    assert.deepEqual(writes, [], 'idempotent close wrote data');
    assert.equal(result.output.idempotent, true);
    assert.equal(result.output.status, 'resolved');
    assert.equal(result.output.after_action_report_id, 'aar-event-1-v2');
});

test('real engine refuses terminal records and surfaces CAS conflicts', { skip: available ? false : skipReason }, () => {
    for (const operation of ['dispatch.complete', 'dispatch.reject', 'emergency.close']) {
        const entry = entryFor(operation);
        const terminal = runHarness(entry.file, entry.dataset, 'terminal');
        assert.equal(terminal.status, 'error', `${entry.workflow} accepted a terminal record`);
        assert.match(String(terminal.error || ''), /record_terminal|event_terminal/);
        assert.equal(terminal.calls.length, 1, `${entry.workflow} must stop after the read`);
        assert.equal(terminal.calls[0].method, 'GET');

        const conflict = runHarness(entry.file, entry.dataset, 'conflict');
        assert.equal(conflict.status, 'error', `${entry.workflow} ignored a CAS conflict`);
        assert.match(String(conflict.error || ''), /409/);
        assert.equal(conflict.calls.at(-1).method, 'PATCH');
        if (operation === 'emergency.close') {
            const aarIndex = conflict.calls.findIndex((call) => call.method === 'POST' && call.url.endsWith('/sos-after-action-reports/records'));
            assert.ok(aarIndex >= 0 && aarIndex < conflict.calls.length - 1, 'AAR must still be created before the event PATCH');
        }
    }
});

test('workflow AAR matches the SOS domain KPI engine on the same fixture', { skip: available ? false : skipReason }, () => {
    const stdout = execFileSync(TSX, [PARITY], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(result.ok, true);
    assert.equal(result.kpiEqual, true, `KPI drift:\n${JSON.stringify(result.workflowKpi)}\n${JSON.stringify(result.legacyKpi)}`);
    assert.equal(result.summaryEqual, true);
    assert.equal(result.timelineEqual, true);
    assert.equal(result.metadataEqual, true);
    assert.equal(result.workflowKpi.overall_score, 90);
});

test('a truncated AAR input page fails closed instead of scoring partial data', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('emergency.close');
    const result = runHarness(entry.file, entry.dataset, 'truncated');
    assert.equal(result.status, 'error');
    assert.match(String(result.error || ''), /query_truncated_dispatch/);
    assert.equal(result.calls.at(-1).method, 'POST');
    assert.ok(result.calls.at(-1).url.endsWith('/sos-dispatch-orders/records/query'));
    assert.ok(!result.calls.some((call) => call.method === 'PATCH'), 'truncated input must not resolve the event');
});

test('real engine rejects malformed actions before any HTTP call', { skip: available ? false : skipReason }, () => {
    for (const entry of manifest.workflows.filter((item) => item.method === 'PATCH')) {
        const result = runHarness(entry.file, entry.dataset, 'malformed');
        assert.equal(result.status, 'error', `${entry.workflow} accepted a malformed action`);
        assert.equal(result.calls.length, 0, `${entry.workflow} made an HTTP call`);
        assert.deepEqual(result.credentialResolutions, []);
    }
});

test('eop approve consumes a four-eyes approval and records it on the plan', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('eop.approve');
    const result = runHarness(entry.file, entry.dataset);
    assert.equal(result.status, 'success', `${entry.workflow}: ${result.error}`);
    assert.deepEqual(result.calls.map(callPath), [
        'GET /v1/capabilities/approvals/approval-1',
        'GET /v1/capabilities/datasets/sos-eop-plans/records/eop-1',
        'PATCH /v1/capabilities/datasets/sos-eop-plans/records/eop-1',
    ]);
    assert.equal(result.calls[0].headers['x-api-key'], 'test-api-key-secret');
    const body = JSON.parse(result.calls[2].body);
    assert.equal(body.ifVersion, 3);
    assert.equal(body.data.status, 'approved');
    assert.equal(body.data.approval_id, 'approval-1');
    assert.equal(body.data.approved_by, 'member-test');
    assert.equal(typeof body.data.approved_at, 'string');
    assert.equal(body.data.approved_role, 'manager');
    assert.deepEqual(body.data.approval_roles, ['manager']);
    assert.equal(body.data.review_notes, 'Reviewed by the duty officer');
    assert.equal(result.validationOutput.audit.operation, 'eop.approve');
});

test('eop approve refuses self-approvals, pending approvals and foreign entities', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('eop.approve');
    const cases = [
        ['self-approval', /self_approval_forbidden/],
        ['unapproved', /approval_not_approved/],
        ['wrong-entity', /approval_entity_mismatch/],
    ];
    for (const [mode, code] of cases) {
        const result = runHarness(entry.file, entry.dataset, mode);
        assert.equal(result.status, 'error', `${mode} was accepted`);
        assert.match(String(result.error || ''), code);
        assert.equal(result.calls.length, 1, `${mode} must stop after the approval read`);
        assert.ok(result.calls[0].url.includes('/v1/capabilities/approvals/'), 'the refusal must happen at the approval read');
        assert.equal(result.calls.filter((call) => call.method === 'PATCH').length, 0, 'a refused approval must never write');
    }
});

test('eop publish refuses an unapproved plan and publishes an approved one', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('eop.publish');
    const refused = runHarness(entry.file, entry.dataset, 'terminal');
    assert.equal(refused.status, 'error');
    assert.match(String(refused.error || ''), /eop_not_approved/);
    assert.equal(refused.calls.length, 1, 'the guard must fire at the plan read');
    assert.ok(refused.calls[0].url.includes('/sos-eop-plans/'));

    const result = runHarness(entry.file, entry.dataset);
    assert.equal(result.status, 'success', `${entry.workflow}: ${result.error}`);
    assert.deepEqual(result.calls.map(callPath), [
        'GET /v1/capabilities/datasets/sos-eop-plans/records/eop-1',
        'GET /v1/capabilities/approvals/approval-1',
        'PATCH /v1/capabilities/datasets/sos-eop-plans/records/eop-1',
    ]);
    const body = JSON.parse(result.calls[2].body);
    assert.equal(body.ifVersion, 3);
    assert.equal(body.data.status, 'published');
    assert.equal(body.data.published_by, 'member-test');
    assert.equal(typeof body.data.published_at, 'string');

    const idempotent = runHarness(entry.file, entry.dataset, 'published');
    assert.equal(idempotent.status, 'success', idempotent.error);
    assert.equal(idempotent.calls.length, 1, 'an already published plan must not be written again');
    assert.equal(idempotent.output.idempotent, true);
});

test('eop submit seeds deterministic dispatch orders and never demotes a published plan', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('eop.submit');
    const result = runHarness(entry.file, entry.dataset);
    assert.equal(result.status, 'success', `${entry.workflow}: ${result.error}`);
    const creates = result.calls.filter((call) => call.method === 'POST' && !call.url.endsWith('/records/query'));
    assert.equal(creates.length, 2, 'the two plan actions must each seed one order');
    const first = JSON.parse(creates[0].body);
    const second = JSON.parse(creates[1].body);
    assert.equal(first.id, 'eop-1-activate-command');
    assert.equal(second.id, 'eop-1-evacuate-ward-7', 'order ids must sanitize like the domain order_id_for');
    assert.equal(first.data.status, 'pending');
    assert.equal(first.data.eop_plan_id, 'eop-1');
    assert.equal(first.data.eop_plan_version, 2);
    assert.equal(first.data.metadata.source, 'eop-submit');
    assert.equal(first.data.metadata.action_id, 'activate-command');
    assert.equal(first.data.target_district, 'District 7');
    assert.equal(first.publish, false);
    assert.equal(second.data.metadata.estimated_minutes, 60, 'a missing estimate falls back to 60 minutes');
    assert.equal(second.data.priority, 'medium');
    assert.equal(second.data.task_title, 'Evacuate ward 7');

    const patchCall = result.calls.at(-1);
    assert.equal(patchCall.method, 'PATCH');
    const patch = JSON.parse(patchCall.body);
    assert.equal(patch.ifVersion, 3);
    assert.equal(patch.data.status, 'approved', 'submit must not change the plan status');
    assert.equal(patch.data.submitted_by, 'member-test');
    assert.equal(typeof patch.data.submitted_at, 'string');
    assert.deepEqual(patch.data.order_ids, ['eop-1-activate-command', 'eop-1-evacuate-ward-7']);

    const published = runHarness(entry.file, entry.dataset, 'terminal');
    assert.equal(published.status, 'error');
    assert.match(String(published.error || ''), /eop_already_published/);
    assert.equal(published.calls.length, 1);
});

test('sitrep publish moves a review_pending SITREP to published', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('sitrep.publish');
    const result = runHarness(entry.file, entry.dataset);
    assert.equal(result.status, 'success', `${entry.workflow}: ${result.error}`);
    assert.deepEqual(result.calls.map(callPath), [
        'GET /v1/capabilities/datasets/sos-sitreps/records/sitrep-1',
        'PATCH /v1/capabilities/datasets/sos-sitreps/records/sitrep-1',
    ]);
    const body = JSON.parse(result.calls[1].body);
    assert.equal(body.ifVersion, 3);
    assert.equal(body.data.status, 'published');
    assert.equal(body.data.published_by, 'member-test');
    assert.equal(body.data.reviewed_by, 'member-test');
    assert.equal(typeof body.data.published_at, 'string');
    assert.equal(result.validationOutput.audit.operation, 'sitrep.publish');
});

test('sitrep publish refuses published, contentless and unreviewed SITREPs', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('sitrep.publish');
    const cases = [
        ['terminal', /sitrep_already_published/],
        ['no-content', /sitrep_content_required/],
        ['unreviewed', /sitrep_review_required/],
    ];
    for (const [mode, code] of cases) {
        const result = runHarness(entry.file, entry.dataset, mode);
        assert.equal(result.status, 'error', `${mode} was published`);
        assert.match(String(result.error || ''), code);
        assert.equal(result.calls.length, 1, `${mode} must stop after the SITREP read`);
        assert.equal(result.calls.filter((call) => call.method === 'PATCH').length, 0);
    }
});

test('sitrep delta appends a real structural delta to a draft SITREP', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('sitrep.delta');
    const result = runHarness(entry.file, entry.dataset);
    assert.equal(result.status, 'success', `${entry.workflow}: ${result.error}`);
    assert.deepEqual(result.calls.map(callPath), [
        'GET /v1/capabilities/datasets/sos-sitreps/records/sitrep-1',
        'PATCH /v1/capabilities/datasets/sos-sitreps/records/sitrep-1',
    ]);
    const body = JSON.parse(result.calls[1].body);
    assert.equal(body.ifVersion, 2);
    assert.equal(body.data.status, 'draft', 'the append path must not change the status');
    assert.equal(body.data.deltas.length, 1);
    const delta = body.data.deltas[0];
    assert.equal(delta.action_type, 'update');
    assert.equal(delta.actor_id, 'member-test');
    assert.equal(delta.from_revision, 1);
    assert.equal(delta.to_revision, 1);
    const changed = new Map(delta.changed_fields.map((row) => [row.field, row]));
    assert.deepEqual(changed.get('casualties'), { field: 'casualties', from: 2, to: 5 });
    assert.deepEqual(changed.get('summary'), { field: 'summary', from: 'First sweep complete', to: 'Second sweep complete' });
    assert.ok(delta.changed_fields.length >= 2, 'the delta must be a non-empty structural diff');
});

test('sitrep delta against a published SITREP creates an amending revision', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('sitrep.delta');
    const result = runHarness(entry.file, entry.dataset, 'published');
    assert.equal(result.status, 'success', `${entry.workflow}: ${result.error}`);
    assert.deepEqual(result.calls.map(callPath), [
        'GET /v1/capabilities/datasets/sos-sitreps/records/sitrep-1',
        'POST /v1/capabilities/datasets/sos-sitreps/records',
    ]);
    const create = JSON.parse(result.calls[1].body);
    assert.match(create.id, /^sitrep-\d+-[a-z0-9]{6}$/);
    assert.equal(create.publish, false);
    assert.equal(create.data.id, create.id);
    assert.equal(create.data.amends_sitrep_id, 'sitrep-1');
    assert.equal(create.data.status, 'draft');
    assert.equal(create.data.version, 2);
    assert.equal(create.data.published_at, null);
    assert.equal(create.data.deltas.length, 1);
    assert.equal(create.data.deltas[0].from_revision, 1);
    assert.equal(create.data.deltas[0].to_revision, 2);
    assert.ok(create.data.deltas[0].changed_fields.length >= 1, 'the revision must carry a non-empty structural delta');
    assert.equal(result.output.superseded_sitrep_id, 'sitrep-1');
});

test('sitrep delta refuses a no-op delta before any write', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('sitrep.delta');
    const result = runHarness(entry.file, entry.dataset, 'no-content');
    assert.equal(result.status, 'error');
    assert.match(String(result.error || ''), /sitrep_delta_empty/);
    assert.equal(result.calls.length, 1, 'a no-op delta must stop after the read');
    assert.equal(result.calls[0].method, 'GET');
});

test('four-eyes dispatch assignment reserves the unit and assigns the order', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('dispatch.assign');
    const result = runHarness(entry.file, entry.dataset);
    assert.equal(result.status, 'success', `${entry.workflow}: ${result.error}`);
    assert.deepEqual(result.calls.map(callPath), [
        'GET /v1/capabilities/approvals/approval-1',
        'GET /v1/capabilities/datasets/sos-dispatch-orders/records/dispatch-1',
        'GET /v1/capabilities/datasets/sos-resource-units/records/resource-1',
        'PATCH /v1/capabilities/datasets/sos-resource-units/records/resource-1',
        'PATCH /v1/capabilities/datasets/sos-dispatch-orders/records/dispatch-1',
    ]);
    const reserve = JSON.parse(result.calls[3].body);
    assert.equal(reserve.ifVersion, 1);
    assert.equal(reserve.data.status, 'assigned');
    assert.equal(reserve.data.assigned_dispatch_order_id, 'dispatch-1');
    assert.equal(reserve.data.assigned_by, 'member-test');
    assert.equal(typeof reserve.data.assigned_at, 'string');

    const assigned = JSON.parse(result.calls[4].body);
    assert.equal(assigned.ifVersion, 4);
    assert.equal(assigned.data.status, 'assigned');
    assert.equal(assigned.data.assigned_resource_unit_id, 'resource-1');
    assert.equal(assigned.data.assigned_user_id, 'resource-1', 'the legacy mirror still carries the unit id');
    assert.equal(assigned.data.assigned_by, 'member-test');
    assert.equal(assigned.data.approval_id, 'approval-1');
    assert.equal(assigned.data.approved_by, 'member-test');
    assert.deepEqual(assigned.data.approval_roles, ['manager']);
    assert.equal(typeof assigned.data.approved_at, 'string');
    assert.equal(assigned.data.assignments.length, 1);
    assert.equal(assigned.data.assignments[0].dispatch_order_id, 'dispatch-1');
    assert.equal(assigned.data.assignments[0].assigned_resource_unit_id, 'resource-1');
    assert.equal(result.validationOutput.audit.operation, 'dispatch.assign');
});

test('dispatch assignment refuses a self-approval and never reserves', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('dispatch.assign');
    const result = runHarness(entry.file, entry.dataset, 'self-approval');
    assert.equal(result.status, 'error');
    assert.match(String(result.error || ''), /self_approval_forbidden/);
    assert.equal(result.calls.length, 1, 'the refusal must happen at the approval read');
    assert.equal(result.calls.filter((call) => call.method === 'PATCH').length, 0, 'a refused approval must never reserve or assign');
});

test('a terminal order releases its stranded reservation before refusing', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('dispatch.assign');
    const result = runHarness(entry.file, entry.dataset, 'terminal');
    assert.equal(result.status, 'error');
    assert.match(String(result.error || ''), /order_terminal/);
    assert.match(String(result.error || ''), /released/);
    const patches = result.calls.filter((call) => call.method === 'PATCH');
    assert.equal(patches.length, 1, 'only the compensation release may write');
    assert.ok(patches[0].url.includes('/sos-resource-units/'));
    const release = JSON.parse(patches[0].body);
    assert.equal(release.data.status, 'available');
    assert.equal(release.data.assigned_dispatch_order_id, null);
    assert.equal(typeof release.data.released_at, 'string');
    assert.ok(!result.calls.some((call) => call.method === 'PATCH' && call.url.includes('/sos-dispatch-orders/')), 'a terminal order must never be assigned');
});

test('dispatch progression moves an assigned order to in transit', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('dispatch.progress');
    const result = runHarness(entry.file, entry.dataset);
    assert.equal(result.status, 'success', `${entry.workflow}: ${result.error}`);
    assert.deepEqual(result.calls.map(callPath), [
        'GET /v1/capabilities/datasets/sos-dispatch-orders/records/dispatch-1',
        'PATCH /v1/capabilities/datasets/sos-dispatch-orders/records/dispatch-1',
    ]);
    const body = JSON.parse(result.calls[1].body);
    assert.equal(body.ifVersion, 4);
    assert.equal(body.data.status, 'in_transit');
    assert.equal(typeof body.data.started_at, 'string');
    assert.equal(body.data.status_history.length, 1);
    assert.equal(body.data.status_history[0].from, 'assigned');
    assert.equal(body.data.status_history[0].to, 'in_transit');
    assert.equal(body.data.status_history[0].action, 'start');
    assert.equal(body.data.status_history[0].by, 'member-test');
    assert.equal(body.data.assigned_resource_unit_id, 'resource-1', 'the progression keeps the reservation');
    assert.equal(result.validationOutput.audit.operation, 'dispatch.progress');
});

test('dispatch progression refuses terminal orders and invalid transitions', { skip: available ? false : skipReason }, () => {
    const entry = entryFor('dispatch.progress');
    const terminal = runHarness(entry.file, entry.dataset, 'terminal');
    assert.equal(terminal.status, 'error');
    assert.match(String(terminal.error || ''), /order_terminal/);
    assert.equal(terminal.calls.length, 1);

    const invalid = runHarness(entry.file, entry.dataset, 'bad-transition');
    assert.equal(invalid.status, 'error');
    assert.match(String(invalid.error || ''), /invalid_dispatch_transition/);
    assert.equal(invalid.calls.length, 1, 'an invalid step must stop after the read');
    assert.equal(invalid.calls.filter((call) => call.method === 'PATCH').length, 0);
});
