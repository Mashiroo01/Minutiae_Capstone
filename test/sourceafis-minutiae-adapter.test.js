const assert = require('node:assert/strict');
const test = require('node:test');

const {
    normalizeRadians,
    parseSerializedFeatureTemplate
} = require('../matchers/sourceafis/sourceafis-minutiae-runner');

test('SourceAFIS feature templates become matcher-independent minutiae without rescaling', () => {
    const result = parseSerializedFeatureTemplate({
        width: 320,
        height: 480,
        positionsX: [12, 205],
        positionsY: [34, 401],
        directions: [Math.PI / 2, Math.PI],
        types: 'EB'
    });

    assert.equal(result.width, 320);
    assert.equal(result.height, 480);
    assert.deepEqual(result.minutiae, [
        { x: 12, y: 34, angle: Math.PI / 2, quality: 100, type: 'ending' },
        { x: 205, y: 401, angle: Math.PI, quality: 100, type: 'bifurcation' }
    ]);
    assert.match(result.source, /score-independent/);
});

test('SourceAFIS directions are normalized into clockwise [0, 2π) radians', () => {
    assert.ok(Math.abs(normalizeRadians(-Math.PI / 2) - (Math.PI * 1.5)) < 1e-12);
    assert.ok(Math.abs(normalizeRadians(Math.PI * 2.5) - (Math.PI / 2)) < 1e-12);
});

test('malformed SourceAFIS feature templates fail explicitly', () => {
    assert.throws(() => parseSerializedFeatureTemplate({
        width: 320,
        height: 480,
        positionsX: [1, 2],
        positionsY: [1],
        directions: [0, 1],
        types: 'EE'
    }), /inconsistent feature counts/);
});
