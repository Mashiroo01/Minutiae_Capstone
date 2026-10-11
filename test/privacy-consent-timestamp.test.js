'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('applicant consent ISO timestamps are normalized for MariaDB', () => {
    const harness = path.join(__dirname, 'helpers', 'privacy-consent-timestamp.php');
    const execution = spawnSync('php', [harness], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8'
    });

    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    const output = JSON.parse(execution.stdout);
    assert.equal(output.result.success, true);
    assert.equal(output.stored, '2026-10-10 06:49:19');
});
