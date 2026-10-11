'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { activateCalibrationProfile, assertLegacyServiceAvailable, buildMatchPercentageProfile, buildPairs, chooseThreshold, confusion, resolveCalibrationFeed, shouldIncludeLegacy, sweep } = require('../scripts/calibrate-bozorth3');

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

test('calibration saves a threshold-anchored percentage profile from score distributions', () => {
    const profile = buildMatchPercentageProfile({
        generatedAt: '2026-10-01T06:09:22.801Z',
        dataset: 'FVC2004/DB4_B',
        pairs: { genuine: 280, impostor: 280 },
        feeds: {
            sourceafis: {
                chosenThreshold: 20,
                genuine: { count: 280, p25: 40, p95: 183 },
                impostor: { count: 280, p25: 5, p95: 14 },
                validation: { far: 0, frr: 0.0857, accuracy: 0.9571 }
            }
        }
    }, 'reports/example/summary.json');

    assert.equal(profile.status, 'calibrated');
    assert.equal(profile.threshold, 20);
    assert.deepEqual(profile.mapping, {
        lowerScore: 5,
        lowerBasis: 'impostor p25',
        upperScore: 183,
        upperBasis: 'genuine p95'
    });
    assert.equal(profile.report, 'reports/example/summary.json');
});

test('Modified Bozorth3 calibration records the enhanced pipeline instead of reusing SourceAFIS evidence', () => {
    const profile = buildMatchPercentageProfile({
        generatedAt: '2026-10-09T08:30:00.000Z',
        dataset: 'FVC2004/DB4_B',
        pairs: { genuine: 280, impostor: 280 },
        feeds: {
            modified: {
                chosenThreshold: 12,
                genuine: { count: 280, p25: 18, p95: 90 },
                impostor: { count: 280, p25: 1, p95: 9 },
                validation: { far: 0.01, frr: 0.2, accuracy: 0.895 }
            }
        }
    }, 'reports/modified-example/summary.json', 'modified');

    assert.equal(profile.matcher, 'Modified Bozorth3');
    assert.equal(profile.threshold, 12);
    assert.equal(profile.matcherFeed, 'Median denoising -> NIST MINDTCT candidates -> adaptive Gabor enhancement -> adaptive binarization -> Zhang-Suen skeleton validation -> Bozorth3 XYT');
    assert.equal(profile.distributions.genuine.count, 280);
    assert.equal(profile.distributions.impostor.count, 280);
    assert.match(profile.profileId, /^modified-bozorth3-enhanced-/);
});

test('the modified calibration CLI targets only the enhanced feed and activates its own profile key', () => {
    assert.equal(resolveCalibrationFeed(['node', 'calibrate-bozorth3.js']), 'sourceafis');
    assert.equal(resolveCalibrationFeed(['node', 'calibrate-bozorth3.js', '--modified']), 'modified');

    const original = { schemaVersion: 1, profiles: { Bozorth3: { profileId: 'keep-me' } } };
    const profile = {
        matcher: 'Modified Bozorth3',
        status: 'calibrated',
        profileId: 'new-profile',
        threshold: 12,
        mapping: { lowerScore: 1, upperScore: 90 },
        validation: { far: 0.01, frr: 0.2, balancedAccuracy: 0.895 }
    };
    const activated = activateCalibrationProfile(original, profile);
    assert.equal(activated.profiles['Modified Bozorth3'].profileId, 'new-profile');
    assert.equal(activated.profiles.Bozorth3.profileId, 'keep-me');
    assert.equal(original.profiles['Modified Bozorth3'], undefined);
});

test('activation refuses a non-discriminating Modified Bozorth3 benchmark', () => {
    const weakProfile = {
        matcher: 'Modified Bozorth3',
        status: 'calibrated',
        threshold: 309,
        mapping: { lowerScore: 95, upperScore: 308 },
        validation: { far: 0, frr: 0.957, balancedAccuracy: 0.521 }
    };
    assert.throws(
        () => activateCalibrationProfile({ schemaVersion: 1, profiles: {} }, weakProfile),
        /cannot be activated.*mapping|cannot be activated.*validation/i
    );
});

test('profile construction records weak evidence without labeling it calibrated', () => {
    const profile = buildMatchPercentageProfile({
        generatedAt: '2026-10-09T02:15:37.496Z',
        dataset: 'FVC2004/DB4_B',
        feeds: {
            modified: {
                chosenThreshold: 309,
                genuine: { count: 280, minimum: 13, p25: 136, p95: 308, maximum: 337 },
                impostor: { count: 280, minimum: 13, p25: 95, p95: 296, maximum: 308 },
                validation: { far: 0, frr: 0.957, balancedAccuracy: 0.521 }
            }
        }
    }, 'reports/weak/summary.json', 'modified');

    assert.equal(profile.status, 'calibration_required');
    assert.equal(profile.method, null);
    assert.equal(profile.mapping, null);
    assert.equal(profile.candidateThreshold, 309);
    assert.match(profile.reason, /safety gate|score mapping/i);
});

test('the legacy performance matrix refuses contradictory database ground truth', () => {
    const evaluator = fs.readFileSync(path.join(__dirname, '..', 'evaluate_performance_matrix.py'), 'utf8');
    assert.match(evaluator, /validate_database_ground_truth\(rows\)/);
    assert.match(evaluator, /same-subject filenames cross criminal IDs/);
    assert.match(evaluator, /fingerprint_md5/);
});
