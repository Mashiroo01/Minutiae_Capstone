'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    circularAngleDifference,
    estimateRigidAlignment,
    transformMinutiae
} = require('../matchers/geometric-alignment');

function minutia(x, y, angleDeg, type = 'ending') {
    return { x, y, angle: angleDeg * Math.PI / 180, quality: 100, type };
}

function transform(points, rotationDeg, translateX, translateY) {
    const rotation = rotationDeg * Math.PI / 180;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return points.map((point) => ({
        ...point,
        x: (point.x * cos) - (point.y * sin) + translateX,
        y: (point.x * sin) + (point.y * cos) + translateY,
        angle: point.angle + rotation
    }));
}

const probe = [
    minutia(40, 55, 358),
    minutia(85, 48, 20, 'bifurcation'),
    minutia(112, 92, 72),
    minutia(67, 126, 118),
    minutia(136, 143, 201, 'bifurcation'),
    minutia(172, 86, 278),
    minutia(194, 151, 325),
    minutia(104, 181, 42)
];

test('circular angle difference treats 358 degrees and 2 degrees as four degrees apart', () => {
    const difference = circularAngleDifference(358 * Math.PI / 180, 2 * Math.PI / 180);
    assert.ok(Math.abs((difference * 180 / Math.PI) - 4) < 1e-9);
});

test('rigid alignment recovers clockwise rotation and translation without absolute coordinates', () => {
    const candidate = transform(probe, 12, 24, -17);
    const alignment = estimateRigidAlignment(probe, candidate);

    assert.ok(alignment, 'expected an alignment hypothesis');
    assert.ok(Math.abs((alignment.rotation * 180 / Math.PI) + 12) < 0.75);
    assert.ok(alignment.matchedCount >= probe.length - 1);

    const aligned = transformMinutiae(candidate, alignment);
    aligned.forEach((point, index) => {
        assert.ok(Math.hypot(point.x - probe[index].x, point.y - probe[index].y) < 1);
        assert.ok(circularAngleDifference(point.angle, probe[index].angle) < 0.02);
    });
});

test('rigid alignment handles counterclockwise rotation and shifted placement', () => {
    const candidate = transform(probe, -15, -31, 26);
    const alignment = estimateRigidAlignment(probe, candidate);

    assert.ok(alignment, 'expected an alignment hypothesis');
    assert.ok(Math.abs((alignment.rotation * 180 / Math.PI) - 15) < 0.75);
    assert.ok(alignment.matchedCount >= probe.length - 1);
});

test('unrelated minutiae do not produce substantial geometric support', () => {
    const unrelated = [
        minutia(8, 12, 40),
        minutia(34, 170, 222, 'bifurcation'),
        minutia(78, 19, 315),
        minutia(141, 34, 88),
        minutia(165, 197, 150, 'bifurcation'),
        minutia(207, 61, 11),
        minutia(227, 119, 260),
        minutia(18, 213, 179)
    ];
    const alignment = estimateRigidAlignment(probe, unrelated);

    assert.ok(!alignment || alignment.matchedCount < probe.length / 2);
});
