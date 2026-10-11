'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('dashboard family-first formatting matches an equivalent stored criminal name', () => {
    const databasePath = path.join(root, 'backend', 'FingerprintDB.php').replace(/\\/g, '/');
    const script = `require '${databasePath}'; echo json_encode([FingerprintDB::normalizeDemographicName('Applicant, 311'), FingerprintDB::normalizeDemographicName('  APPLICANT   311 ')]);`;
    const execution = spawnSync('php', ['-r', script], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true
    });

    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    assert.deepEqual(JSON.parse(execution.stdout), ['applicant 311', 'applicant 311']);

    const database = fs.readFileSync(path.join(root, 'backend', 'FingerprintDB.php'), 'utf8');
    assert.match(database, /searchCriminalByDemographics[\s\S]*normalizeDemographicName/);
});
