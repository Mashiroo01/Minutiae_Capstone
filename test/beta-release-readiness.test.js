'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('login copy describes the requested workspace instead of a hard-coded route', () => {
    const login = fs.readFileSync(path.join(root, 'login.html'), 'utf8');

    assert.match(login, /continue to the requested protected workspace/i);
    assert.doesNotMatch(login, /protected admin page at `index\.html`/i);
});

test('the repeatable beta release gate covers regressions, dependencies, matchers, quality, and authenticated APIs', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const gate = fs.readFileSync(path.join(root, 'scripts', 'run-beta-check.ps1'), 'utf8');
    const smoke = fs.readFileSync(path.join(root, 'scripts', 'beta-smoke.ps1'), 'utf8');

    assert.equal(packageJson.scripts['beta:check'], 'powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\run-beta-check.ps1');
    for (const command of ['test', 'audit', 'matchers:verify', 'modified-bozorth3:verify-quality', 'beta:smoke']) {
        assert.match(gate, new RegExp(command.replace(':', '\\:')));
    }
    assert.match(smoke, /action=login/);
    assert.match(smoke, /action=stats/);
    assert.match(smoke, /action=history/);
    assert.match(smoke, /action=notifications/);
    assert.match(smoke, /action=comparisons/);
    assert.match(smoke, /dataset_collection\.php\?action=list/);
    assert.match(smoke, /scanner_available/);
    assert.match(smoke, /simulation_allowed/);
});
