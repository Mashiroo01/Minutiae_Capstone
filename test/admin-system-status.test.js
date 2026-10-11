'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const adminPage = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const startScript = fs.readFileSync(path.join(root, 'scripts', 'start-zkteco-service.ps1'), 'utf8');

test('system status renders separate service, database, matcher, and scanner health cards', () => {
    assert.match(adminPage, /id="systemStatusSummary"/);
    assert.match(adminPage, /id="systemStatusGrid"/);
    assert.match(adminPage, /id="systemMatcherGrid"/);
    assert.match(adminPage, /Modified Bozorth3/);
    assert.match(adminPage, /Fingerprint Service/);
    assert.match(adminPage, /ZKTeco Scanner/);
    assert.match(adminPage, /function renderSystemStatus\(data\)/);
});

test('system status exposes loading, refresh, timestamp, and actionable degraded states', () => {
    assert.match(adminPage, /id="systemStatusLoading"/);
    assert.match(adminPage, /id="systemStatusUpdatedAt"/);
    assert.match(adminPage, /onclick="loadSystemStatus\(\)"/);
    assert.match(adminPage, /Connect the ZKTeco ZK9500/);
    assert.match(adminPage, /Simulation is disabled/);
});

test('real scanner service can stay online for diagnostics when hardware is disconnected', () => {
    assert.doesNotMatch(startScript, /throw 'No ZKTeco ZK9500 was detected/);
    assert.match(startScript, /Service will start in real-only mode/);
    assert.match(startScript, /SCANNER_ALLOW_SIMULATION = 'false'/);
});
