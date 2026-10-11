'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    classifyBozorthDecision,
    prepareBozorthMinutiae,
    runBozorth3Matcher,
    toCygwinPath,
    toBozorthXyt
} = require('../matchers/bozorth3/bozorth3-runner');

test('prepareBozorthMinutiae rejects invalid, out-of-bounds, duplicate, and low-quality points without mutating input', () => {
    const input = [
        { x: 20, y: 20, angle: 0.2, quality: 90, type: 'ending' },
        { x: 20.4, y: 20.3, angle: 0.3, quality: 80, type: 'ending' },
        { x: 40, y: 40, angle: 0.4, quality: 70, type: 'bifurcation' },
        { x: 60, y: 60, angle: 0.6, quality: 60, type: 'ending' },
        { x: 2, y: 2, angle: 0.8, quality: 99, type: 'ending' },
        { x: Number.NaN, y: 30, angle: 1, quality: 100, type: 'ending' },
        { x: 70, y: 70, angle: 1.2, quality: 10, type: 'ending' }
    ];
    const snapshot = structuredClone(input);

    const result = prepareBozorthMinutiae(input, {
        width: 100,
        height: 100,
        borderMargin: 10,
        minimumQuality: 50,
        duplicateRadius: 2,
        maximumPoints: 2
    });

    assert.deepEqual(input, snapshot);
    assert.deepEqual(result.minutiae.map(({ x, y, quality }) => ({ x, y, quality })), [
        { x: 20, y: 20, quality: 90 },
        { x: 40, y: 40, quality: 70 }
    ]);
    assert.deepEqual(result.counts, {
        extracted: 7,
        finite: 6,
        insideRoi: 5,
        qualityAccepted: 4,
        deduplicated: 3,
        used: 2
    });
});

test('Bozorth XYT conversion preserves coordinates and normalizes clockwise radians to degrees', () => {
    assert.equal(toBozorthXyt([
        { x: 10.4, y: 20.6, angle: 0 },
        { x: 30, y: 40, angle: Math.PI / 2 },
        { x: 50, y: 60, angle: -Math.PI / 2 }
    ]), '10 21 0\n30 40 90\n50 60 270\n');
});

test('Cygwin path conversion preserves Linux executable paths and converts Windows paths', () => {
    assert.equal(toCygwinPath('/home/mendi/nbis/bozorth3/bin/bozorth3'), '/home/mendi/nbis/bozorth3/bin/bozorth3');
    assert.equal(toCygwinPath('C:\\tmp\\probe.xyt'), '/cygdrive/c/tmp/probe.xyt');
});

test('decision classification treats the calibrated threshold as a match and reserves borderline for scores just below it', () => {
    assert.deepEqual(classifyBozorthDecision({ score: 60, threshold: 20, borderlineBand: 3, qualityPassed: false }), {
        result: 'INSUFFICIENT QUALITY',
        isMatch: null,
        decisionState: 'insufficient-quality',
        reviewRecommended: false
    });
    assert.equal(classifyBozorthDecision({ score: 20, threshold: 20, borderlineBand: 3, qualityPassed: true }).result, 'MATCH');
    assert.equal(classifyBozorthDecision({ score: 22, threshold: 20, borderlineBand: 3, qualityPassed: true }).result, 'MATCH');
    assert.equal(classifyBozorthDecision({ score: 24, threshold: 20, borderlineBand: 3, qualityPassed: true }).result, 'MATCH');
    assert.equal(classifyBozorthDecision({ score: 18, threshold: 20, borderlineBand: 3, qualityPassed: true }).result, 'BORDERLINE');
    assert.equal(classifyBozorthDecision({ score: 16, threshold: 20, borderlineBand: 3, qualityPassed: true }).result, 'NO MATCH');
});

test('runner reports native execution provenance, preserves raw score, and removes unique templates', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bozorth3-runner-test-'));
    const seen = [];
    const minutiae = Array.from({ length: 20 }, (_, index) => ({
        x: 20 + index * 3,
        y: 25 + index * 2,
        angle: index / 10,
        quality: 100,
        type: index % 2 ? 'ending' : 'bifurcation'
    }));

    try {
        const result = runBozorth3Matcher({
            probeMinutiae: minutiae,
            referenceMinutiae: minutiae.map((item) => ({ ...item, x: item.x + 1 })),
            threshold: 20,
            probeQuality: 80,
            referenceQuality: 82,
            config: { executablePath: 'mock-bozorth3', tempDir, minimumMinutiae: 18, minimumImageQuality: 35 },
            execute: ({ command, probePath, referencePath }) => {
                seen.push({ command, probePath, referencePath });
                assert.ok(fs.existsSync(probePath));
                assert.ok(fs.existsSync(referencePath));
                assert.notEqual(probePath, referencePath);
                return { status: 0, stdout: '57\n', stderr: '' };
            }
        });

        assert.equal(result.rawScore, 57);
        assert.equal(result.result, 'MATCH');
        assert.equal(result.execution.exitCode, 0);
        assert.match(result.execution.command, /mock-bozorth3/);
        assert.equal(result.templates.probe.sha256.length, 64);
        assert.equal(result.templates.reference.sha256.length, 64);
        assert.ok(result.templates.probe.sample.length > 0);
        assert.equal(seen.length, 1);
        assert.equal(fs.existsSync(seen[0].probePath), false);
        assert.equal(fs.existsSync(seen[0].referencePath), false);
    } finally {
        fs.rmdirSync(tempDir);
    }
});

test('runner preserves the native score but withholds a decision when minutiae quality is insufficient', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bozorth3-quality-test-'));
    const minutiae = Array.from({ length: 10 }, (_, index) => ({ x: 20 + index, y: 30 + index, angle: 0.1 * index, quality: 100 }));
    try {
        const result = runBozorth3Matcher({
            probeMinutiae: minutiae,
            referenceMinutiae: minutiae,
            threshold: 20,
            probeQuality: 80,
            referenceQuality: 80,
            config: { executablePath: 'mock-bozorth3', tempDir, minimumMinutiae: 18, minimumImageQuality: 35 },
            execute: () => ({ status: 0, stdout: '91\n', stderr: '' })
        });
        assert.equal(result.rawScore, 91);
        assert.equal(result.result, 'INSUFFICIENT QUALITY');
        assert.equal(result.isMatch, null);
        assert.equal(result.qualityGate.countPassed, false);
    } finally {
        fs.rmdirSync(tempDir);
    }
});
