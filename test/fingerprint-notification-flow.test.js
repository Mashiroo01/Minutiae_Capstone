'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const harness = path.join(__dirname, 'helpers', 'fingerprint-notification-flow.php');

function runHarness(mode) {
    const execution = spawnSync('php', [harness, mode], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8'
    });

    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    return JSON.parse(execution.stdout);
}

test('a canonical MATCH persists a complete unread admin notification', () => {
    const recorded = runHarness('record-match');

    assert.equal(recorded.success, true);
    assert.deepEqual(recorded.notification, {
        id: String(recorded.record_id),
        comparisonId: 'comparison-match-1',
        type: 'fingerprint_match',
        status: 'unread',
        finalResult: 'MATCH',
        createdAt: recorded.notification.createdAt,
        viewed: false
    });
    assert.ok(recorded.notification.createdAt);
});

test('NO MATCH stores the comparison without creating an admin notification', () => {
    const recorded = runHarness('record-no-match');

    assert.equal(recorded.success, true);
    assert.equal(recorded.notification, null);
});

test('multiple notifications retain durable seen/read state and exact comparison identity', () => {
    const result = runHarness('lifecycle');

    assert.notEqual(result.first.notification.id, result.second.notification.id);
    assert.notEqual(result.first.notification.comparisonId, result.second.notification.comparisonId);
    assert.deepEqual(result.unreadBefore.map((item) => item.comparisonId), [
        'comparison-match-b',
        'comparison-match-a'
    ]);
    assert.deepEqual(result.unreadAfterSeen.map((item) => item.comparisonId), ['comparison-match-b']);
    assert.deepEqual(result.activeAfterSeen.map((item) => item.comparisonId), [
        'comparison-match-b',
        'comparison-match-a'
    ]);
    assert.deepEqual(result.activeAfterRead.map((item) => item.comparisonId), ['comparison-match-b']);
    assert.equal(result.exactComparison.comparison_id, 'comparison-match-a');
    assert.equal(result.exactComparison.comparison_result.finalResult.decision, 'MATCH');
});

test('large MATCH results are chunked below the database packet limit and restored exactly', () => {
    const result = runHarness('large-result');

    assert.equal(result.recorded.success, true);
    assert.equal(result.recorded.notification.status, 'unread');
    assert.ok(result.inlineBytes < 1000, `expected a small storage marker, got ${result.inlineBytes} bytes`);
    assert.ok(result.chunkCount > 1, 'expected the large result to be split into multiple chunks');
    assert.ok(result.largestChunk <= 256 * 1024, `chunk exceeded 256 KiB: ${result.largestChunk}`);
    assert.equal(result.restoredPayloadBytes, 2 * 1024 * 1024);
    assert.equal(result.restoredDecision, 'MATCH');
});

test('comparison history returns lightweight summaries instead of decoding every large result', () => {
    const result = runHarness('history-summary');

    assert.equal(result.count, 1);
    assert.equal(result.comparisonId, 'comparison-history-large');
    assert.equal(result.hasComparisonResult, false);
    assert.equal(result.finalResult, 'MATCH');
});

test('application history exposes notification metadata without loading comparison images', () => {
    const result = runHarness('applicant-history-notifications');

    assert.equal(result.count, 1);
    assert.equal(result.hasComparisonResult, false);
    assert.equal(result.comparisonId, 'comparison-applicant-view');
    assert.equal(result.notificationStatus, 'unread');
    assert.equal(result.notificationFinalResult, 'MATCH');
    assert.equal(result.fingerMatched, 'RIGHT_RING');
});

test('dashboard and admin use the persistent notification API with four-second polling', () => {
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
    const admin = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

    assert.match(dashboard, /\[Dashboard\] Fingerprint comparison completed/);
    assert.match(dashboard, /\[Dashboard\] Notification event saved successfully/);
    assert.match(dashboard, /No admin match notification created/);
    assert.match(admin, /action=notifications&state=active/);
    assert.match(admin, /action=notification_status/);
    assert.match(admin, /action=comparison&comparison_id=/);
    assert.match(admin, /\[Admin\] New fingerprint match notification received/);
    assert.match(admin, /window\.setInterval\([\s\S]*?,\s*4000\s*\)/);
    assert.doesNotMatch(admin, /minutiae_super_admin_alert_signature/);
});

test('the match route never reports MATCH after comparison persistence fails', () => {
    const backend = fs.readFileSync(path.join(__dirname, '..', 'backend', 'applicant_info.php'), 'utf8');

    assert.match(backend, /\$persistenceErrors\s*=\s*\[\]/);
    assert.match(backend, /empty\(\$recordedComparison\['success'\]\)/);
    assert.match(backend, /Fingerprint comparison completed but its result could not be persisted/);
});
