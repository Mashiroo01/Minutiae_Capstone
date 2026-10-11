'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    attachMatchPercentage,
    normalizeWithProfile
} = require('../matchers/calibration/match-percentage');
const storedCalibration = require('../config/matcher-calibration.json');

const calibratedProfile = {
    status: 'calibrated',
    profileId: 'test-profile',
    matcher: 'Bozorth3',
    threshold: 20,
    scoreDirection: 'higher-is-more-similar',
    method: 'piecewise-linear-threshold-anchored',
    mapping: {
        lowerScore: 5,
        upperScore: 183
    },
    distributions: {
        impostor: { count: 280, p25: 5, p95: 14 },
        genuine: { count: 280, p25: 40, p95: 183 }
    }
};

test('piecewise calibration anchors the threshold at 50 and clamps to 0-100', () => {
    assert.equal(normalizeWithProfile(-10, calibratedProfile), 0);
    assert.equal(normalizeWithProfile(5, calibratedProfile), 0);
    assert.equal(normalizeWithProfile(20, calibratedProfile), 50);
    assert.equal(normalizeWithProfile(183, calibratedProfile), 100);
    assert.equal(normalizeWithProfile(500, calibratedProfile), 100);
    assert.ok(normalizeWithProfile(19.9, calibratedProfile) < 50);
    assert.ok(normalizeWithProfile(20.1, calibratedProfile) > 50);
});

test('piecewise calibration is monotonic across the matcher score range', () => {
    const scores = [-5, 0, 5, 10, 19, 20, 21, 40, 64, 106, 183, 300];
    const percentages = scores.map((score) => normalizeWithProfile(score, calibratedProfile));

    for (let index = 1; index < percentages.length; index += 1) {
        assert.ok(percentages[index] >= percentages[index - 1]);
    }
});

test('calibrated decoration preserves native score, threshold, and decision', () => {
    const nativeResult = {
        algorithm: 'Bozorth3',
        status: 'ok',
        score: 64,
        rawScore: 64,
        threshold: 20,
        result: 'MATCH',
        isMatch: true
    };
    const decorated = attachMatchPercentage(nativeResult, {
        profiles: { Bozorth3: calibratedProfile }
    });

    assert.equal(decorated.score, 64);
    assert.equal(decorated.rawScore, 64);
    assert.equal(decorated.threshold, 20);
    assert.equal(decorated.result, 'MATCH');
    assert.equal(decorated.decision, 'MATCH');
    assert.equal(decorated.isMatch, true);
    assert.equal(decorated.normalizedMatchPercentage, 63.5);
    assert.equal(decorated.normalization.status, 'calibrated');
});

test('uncalibrated matchers report Calibration Required instead of a fake percentage', () => {
    const decorated = attachMatchPercentage({
        algorithm: 'SourceAFIS',
        status: 'ok',
        score: 91.25,
        rawScore: 91.25,
        threshold: 40,
        result: 'MATCH'
    }, {
        profiles: {
            SourceAFIS: {
                status: 'calibration_required',
                threshold: 40,
                reason: 'No labeled genuine/impostor benchmark score set is available.'
            }
        }
    });

    assert.equal(decorated.normalizedMatchPercentage, null);
    assert.equal(decorated.normalization.status, 'calibration_required');
    assert.match(decorated.normalization.warning, /labeled genuine\/impostor/i);
});

test('a threshold override invalidates a profile calibrated at a different threshold', () => {
    const decorated = attachMatchPercentage({
        algorithm: 'Bozorth3',
        status: 'ok',
        score: 64,
        rawScore: 64,
        threshold: 30,
        result: 'MATCH'
    }, {
        profiles: { Bozorth3: calibratedProfile }
    });

    assert.equal(decorated.normalizedMatchPercentage, null);
    assert.equal(decorated.normalization.status, 'threshold_mismatch');
    assert.match(decorated.normalization.warning, /calibrated threshold is 20/i);
});

test('matcher errors never receive a percentage', () => {
    const decorated = attachMatchPercentage({
        algorithm: 'Bozorth3',
        status: 'error',
        score: null,
        rawScore: null,
        threshold: 20,
        result: 'UNAVAILABLE'
    }, {
        profiles: { Bozorth3: calibratedProfile }
    });

    assert.equal(decorated.normalizedMatchPercentage, null);
    assert.equal(decorated.normalization.status, 'unavailable');
});

test('stored profiles calibrate every matcher from recorded benchmark evidence', () => {
    assert.equal(storedCalibration.profiles.Bozorth3.status, 'calibrated');
    assert.equal(storedCalibration.profiles.Bozorth3.threshold, 20);
    assert.equal(storedCalibration.profiles.Bozorth3.distributions.genuine.count, 280);
    assert.equal(storedCalibration.profiles.Bozorth3.distributions.impostor.count, 280);

    for (const matcher of ['SourceAFIS', 'OpenAFIS', 'MCC', 'Jiang Matcher']) {
        assert.equal(storedCalibration.profiles[matcher].status, 'calibrated');
        assert.equal(storedCalibration.profiles[matcher].distributions.genuine.count, 140);
        assert.equal(storedCalibration.profiles[matcher].distributions.impostor.count, 140);
    }
});

test('the validated Modified Bozorth3 benchmark emits its threshold-anchored percentage', () => {
    const profile = storedCalibration.profiles['Modified Bozorth3'];
    assert.equal(profile.status, 'calibrated');
    assert.match(profile.report, /modified-bozorth3-calibration-/);
    assert.equal(profile.threshold, 16);
    assert.ok(profile.validation.far < 0.05);
    assert.ok(profile.validation.frr < 0.25);
    assert.ok(profile.validation.balancedAccuracy >= 0.8);

    const decorated = attachMatchPercentage({
        algorithm: 'Modified Bozorth3',
        status: 'ok',
        score: 16,
        threshold: 16,
        result: 'MATCH'
    }, storedCalibration);
    assert.equal(decorated.normalizedMatchPercentage, 50);
    assert.equal(decorated.normalization.status, 'calibrated');
    assert.match(decorated.normalization.warning, /not a probability/i);
});
