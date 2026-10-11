'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildCalibrationProfile,
    selectThreshold,
    summarizeScores
} = require('../matchers/calibration/calibration-statistics');
const { buildSupportingMatcherArbiter } = require('../matchers/calibration/supporting-arbiter');
const { selectBalancedPairs } = require('../scripts/calibrate-supporting-matchers');

test('continuous threshold selection uses the separation midpoint with held-out labels', () => {
    const rows = [
        ...[60, 70, 80, 90].map((score) => ({ label: 'genuine', score })),
        ...[0, 10, 20, 30].map((score) => ({ label: 'impostor', score }))
    ];

    const selected = selectThreshold(rows);
    assert.equal(selected.threshold, 45);
    assert.equal(selected.fp, 0);
    assert.equal(selected.fn, 0);
});

test('profile construction uses matcher-specific impostor and genuine percentiles', () => {
    const genuine = summarizeScores(Array.from({ length: 100 }, (_, index) => index + 50));
    const impostor = summarizeScores(Array.from({ length: 100 }, (_, index) => index / 10));
    const profile = buildCalibrationProfile({
        matcher: 'Example',
        matcherFeed: 'Exact production feed',
        dataset: 'Benchmark',
        report: 'reports/example/summary.json',
        generatedAt: '2026-10-06T00:00:00.000Z',
        threshold: 30,
        genuine,
        impostor,
        validation: { far: 0, frr: 0 }
    });

    assert.equal(profile.status, 'calibrated');
    assert.equal(profile.mapping.lowerScore, impostor.p25);
    assert.equal(profile.mapping.upperScore, genuine.p95);
    assert.equal(profile.threshold, 30);
});

test('four-model arbiter averages calibrated percentages and requires a 3-of-4 majority', () => {
    const arbiter = buildSupportingMatcherArbiter([
        calibrated('SourceAFIS', 80, 'MATCH'),
        calibrated('OpenAFIS', 70, 'MATCH'),
        calibrated('MCC', 40, 'NO MATCH'),
        calibrated('Jiang Matcher', 60, 'MATCH')
    ]);

    assert.equal(arbiter.status, 'ok');
    assert.equal(arbiter.normalizedMatchPercentage, 62.5);
    assert.equal(arbiter.matchVotes, 3);
    assert.equal(arbiter.agreementPercentage, 75);
    assert.equal(arbiter.result, 'MATCH');
});

test('four-model arbiter sends a two-two split to review even when its mean exceeds 50', () => {
    const arbiter = buildSupportingMatcherArbiter([
        calibrated('SourceAFIS', 80, 'MATCH'),
        calibrated('OpenAFIS', 70, 'MATCH'),
        calibrated('MCC', 40, 'NO MATCH'),
        calibrated('Jiang Matcher', 30, 'NO MATCH')
    ]);

    assert.equal(arbiter.normalizedMatchPercentage, 55);
    assert.equal(arbiter.result, 'REVIEW REQUIRED');
    assert.equal(arbiter.agreementPercentage, 50);
});

test('four-model arbiter never treats missing calibration as a no-match vote', () => {
    const arbiter = buildSupportingMatcherArbiter([
        calibrated('SourceAFIS', 80, 'MATCH'),
        calibrated('OpenAFIS', 70, 'MATCH'),
        calibrated('MCC', 60, 'MATCH'),
        {
            algorithm: 'Jiang Matcher',
            status: 'ok',
            result: 'MATCH',
            normalizedMatchPercentage: null,
            normalization: { status: 'calibration_required' }
        }
    ]);

    assert.equal(arbiter.status, 'incomplete');
    assert.equal(arbiter.availableMatchers, 3);
    assert.equal(arbiter.result, 'REVIEW REQUIRED');
    assert.match(arbiter.warning, /all four/i);
});

test('calibration pair limits remain balanced across subjects and labels', () => {
    const pairs = [];
    for (let subject = 101; subject <= 110; subject += 1) {
        pairs.push({ subject: String(subject), label: 'genuine', id: `g${subject}-1` });
        pairs.push({ subject: String(subject), label: 'genuine', id: `g${subject}-2` });
        pairs.push({ subject: String(subject), label: 'impostor', id: `i${subject}-1` });
        pairs.push({ subject: String(subject), label: 'impostor', id: `i${subject}-2` });
    }
    const selected = selectBalancedPairs(pairs, 10);

    assert.equal(selected.filter((pair) => pair.label === 'genuine').length, 10);
    assert.equal(selected.filter((pair) => pair.label === 'impostor').length, 10);
    assert.equal(new Set(selected.map((pair) => pair.subject)).size, 10);
});

function calibrated(algorithm, normalizedMatchPercentage, result) {
    return {
        algorithm,
        status: 'ok',
        result,
        normalizedMatchPercentage,
        normalization: { status: 'calibrated' }
    };
}
