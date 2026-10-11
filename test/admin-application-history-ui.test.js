'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const adminPage = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

test('applicant history API metadata remains JSON serializable with binary templates stored', () => {
    const harness = path.join(__dirname, 'helpers', 'applicant-history-record.php');
    const execution = spawnSync('php', [harness], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8'
    });

    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    const result = JSON.parse(execution.stdout);
    assert.equal(result.success, true);
    assert.equal(result.record.name, 'Applicant, History');
    assert.equal(result.fingerprints[0].finger_position, 'RIGHT_INDEX');
    assert.equal(Object.hasOwn(result.fingerprints[0], 'template'), false);
});

test('application View presents an accessible summary and chronological activity timeline', () => {
    assert.match(adminPage, /class="application-history-hero"/);
    assert.match(adminPage, /class="application-history-metrics"/);
    assert.match(adminPage, /class="application-timeline"/);
    assert.match(adminPage, /aria-label="Application activity timeline"/);
    assert.match(adminPage, /function formatApplicationHistoryDate\(value\)/);
    assert.match(adminPage, /function renderApplicationTimeline\(entries, record\)/);
});

test('application history modal uses the wide layout and exposes a close action in its footer', () => {
    assert.match(adminPage, /id="recordViewModal"[\s\S]*?modal-dialog modal-xl modal-dialog-scrollable/);
    assert.match(adminPage, /id="recordViewModalFooter"/);
    assert.match(adminPage, /data-bs-dismiss="modal">Close</);
});
