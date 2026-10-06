'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { assertLegacyServiceAvailable, buildPairs, chooseThreshold, confusion, shouldIncludeLegacy, sweep } = require('../scripts/calibrate-bozorth3');

test('calibration is standalone by default and legacy service comparison is explicit opt-in', () => {
    assert.equal(shouldIncludeLegacy({}), false);
    assert.equal(shouldIncludeLegacy({ CALIBRATE_LEGACY: '0' }), false);
    assert.equal(shouldIncludeLegacy({ CALIBRATE_LEGACY: '1' }), true);
    assert.equal(shouldIncludeLegacy({ CALIBRATE_LEGACY: 'true' }), true);
});

test('legacy opt-in reports how to satisfy its service dependency', async () => {
    await assert.rejects(
        () => assertLegacyServiceAvailable('http://localhost:9999', async () => { throw new TypeError('fetch failed'); }),
        /CALIBRATE_LEGACY=1.*start the fingerprint service.*localhost:9999/i
    );
});

test('calibration pairs use filename subjects for balanced genuine and impostor ground truth', () => {
    const samples = [];
    for (const subject of ['101', '102', '103']) {
        for (let impression = 1; impression <= 3; impression++) {
            samples.push({ key: `${subject}_${impression}`, subject, impression });
        }
    }
    const pairs = buildPairs(samples);
    assert.equal(pairs.filter((pair) => pair.label === 'genuine').length, 9);
    assert.equal(pairs.filter((pair) => pair.label === 'impostor').length, 9);
    assert.ok(pairs.filter((pair) => pair.label === 'genuine').every((pair) => pair.probe.subject === pair.reference.subject));
    assert.ok(pairs.filter((pair) => pair.label === 'impostor').every((pair) => pair.probe.subject !== pair.reference.subject));
});

test('calibration metrics use higher-is-match semantics and threshold selection penalizes false accepts on ties', () => {
    const rows = [
        { label: 'genuine', score: 12 },
        { label: 'genuine', score: 20 },
        { label: 'impostor', score: 3 },
        { label: 'impostor', score: 12 }
    ];
    assert.deepEqual(confusion(rows, 12), {
        threshold: 12,
        tp: 2,
        fn: 0,
        fp: 1,
        tn: 1,
        accuracy: 0.75,
        precision: 2 / 3,
        recall: 1,
        f1: 0.8,
        far: 0.5,
        frr: 0,
        balancedAccuracy: 0.75
    });
    assert.equal(chooseThreshold(sweep(rows)).threshold, 13);
});

test('the legacy performance matrix refuses contradictory database ground truth', () => {
    const evaluator = fs.readFileSync(path.join(__dirname, '..', 'evaluate_performance_matrix.py'), 'utf8');
    assert.match(evaluator, /validate_database_ground_truth\(rows\)/);
    assert.match(evaluator, /same-subject filenames cross criminal IDs/);
    assert.match(evaluator, /fingerprint_md5/);
});
