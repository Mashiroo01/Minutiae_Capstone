'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createIsotropicCanvas,
    estimateAlignmentFromPairs,
    toOpenAfisCsv
} = require('../matchers/openafis/openafis-adapter');

test('OpenAFIS uses one isotropic coordinate scale for non-square fingerprints', () => {
    const canvas = createIsotropicCanvas(
        { width: 288, height: 384 },
        { width: 300, height: 360 }
    );

    assert.deepEqual(canvas, { width: 384, height: 384 });
});

test('OpenAFIS CSV keeps radians and source pixel coordinates on the isotropic canvas', () => {
    const csv = toOpenAfisCsv([
        { type: 'ending', x: 120.4, y: 180.6, angle: Math.PI / 2 },
        { type: 'bifurcation', x: 144, y: 165, angle: -0.1 }
    ], { width: 384, height: 384 });
    const lines = csv.trim().split(/\r?\n/);

    assert.equal(lines[0], '384,384');
    assert.equal(lines[1], `1,120,181,${Math.PI / 2}`);
    assert.equal(lines[2], '2,144,165,-0.1');
});

test('OpenAFIS diagnostics estimate one rigid transform from actual matcher pairs', () => {
    const rotation = 10 * Math.PI / 180;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const probe = [
        { x: 40, y: 60, directionRad: 0.2 },
        { x: 120, y: 80, directionRad: 1.4 },
        { x: 90, y: 170, directionRad: 5.9 }
    ];
    const pairs = probe.map((point) => ({
        probe: point,
        reference: {
            x: (point.x * cos) - (point.y * sin) + 18,
            y: (point.x * sin) + (point.y * cos) - 9,
            directionRad: point.directionRad + rotation
        }
    }));

    const alignment = estimateAlignmentFromPairs(pairs);

    assert.equal(alignment.available, true);
    assert.equal(alignment.matchedMinutiaeCount, 3);
    assert.ok(Math.abs(alignment.estimatedRotationDeg + 10) < 0.5);
    for (const pair of alignment.pairs) {
        assert.ok(Math.hypot(pair.probe.x - pair.reference.alignedX, pair.probe.y - pair.reference.alignedY) < 0.5);
    }
});
