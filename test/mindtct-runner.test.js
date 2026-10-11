'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    filterMindtctMinutiaeBySkeleton,
    parseMindtctOutput,
    runMindtctExtractor
} = require('../matchers/mindtct/mindtct-runner');

test('MINDTCT output maps native direction, reliability, and type to matcher minutiae', () => {
    const result = parseMindtctOutput([
        '12 34 90 0.87 1',
        '56 78 0 0.42 0'
    ].join('\n'));

    assert.deepEqual(result.map(({ x, y, quality, type }) => ({ x, y, quality, type })), [
        { x: 12, y: 34, quality: 87, type: 'ending' },
        { x: 56, y: 78, quality: 42, type: 'bifurcation' }
    ]);
    assert.ok(Math.abs(result[0].angle - (Math.PI / 2)) < 1e-9);
    assert.ok(Math.abs(result[1].angle - 0) < 1e-9);
});

test('MINDTCT runner writes exact raw pixels and removes its temporary input', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindtct-runner-test-'));
    const pixels = Uint8Array.from([0, 64, 128, 255]);
    let inputPath;
    try {
        const result = runMindtctExtractor({
            pixels,
            width: 2,
            height: 2,
            ppi: 500,
            config: { executablePath: 'mock-mindtct', tempDir },
            execute: (options) => {
                inputPath = options.inputPath;
                assert.deepEqual(fs.readFileSync(inputPath), Buffer.from(pixels));
                assert.equal(options.width, 2);
                assert.equal(options.height, 2);
                assert.equal(options.ppi, 500);
                return { status: 0, stdout: '1 1 4 0.91 1\n', stderr: '' };
            }
        });
        assert.equal(result.status, 'ok');
        assert.equal(result.minutiae.length, 1);
        assert.equal(result.minutiae[0].quality, 91);
        assert.equal(fs.existsSync(inputPath), false);
    } finally {
        fs.rmdirSync(tempDir);
    }
});

test('MINDTCT runner rejects a raw buffer whose dimensions do not match', () => {
    assert.throws(() => runMindtctExtractor({
        pixels: Uint8Array.from([1, 2, 3]),
        width: 2,
        height: 2,
        execute: () => ({ status: 0, stdout: '', stderr: '' })
    }), /exactly 4 grayscale pixels/);
});

test('MINDTCT candidates are retained only when the Zhang-Suen skeleton supports them', () => {
    const width = 12;
    const height = 10;
    const skeleton = new Uint8Array(width * height);
    skeleton[3 * width + 4] = 1;
    const result = filterMindtctMinutiaeBySkeleton([
        { x: 4, y: 7, angle: Math.PI / 2, quality: 90 },
        { x: 10, y: 1, angle: 0, quality: 80 }
    ], skeleton, width, height, { radius: 1 });

    assert.equal(result.accepted.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.deepEqual(
        { imageX: result.accepted[0].imageX, imageY: result.accepted[0].imageY },
        { imageX: 4, imageY: 3 }
    );
    assert.ok(Math.abs(result.accepted[0].imageAngle - (Math.PI * 1.5)) < 1e-9);
});
