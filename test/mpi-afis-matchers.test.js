const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
    runMccMatcher,
    runJiangMatcher,
    normalizeTranslationForLocalMatcher,
    toMpiAfisXyt
} = require('../matchers/mpi-afis/mpi-afis-runner');

const probe = Array.from({ length: 24 }, (_, index) => ({
    x: 55 + ((index * 37) % 330),
    y: 48 + ((index * 53) % 360),
    angle: ((index * 0.41) % (Math.PI * 2)),
    quality: 75 + (index % 20),
    type: index % 3 === 0 ? 'bifurcation' : 'ending'
}));

const changed = probe.map((minutia, index) => ({
    ...minutia,
    x: minutia.x + ((index % 4) * 11),
    y: minutia.y + ((index % 5) * 7),
    angle: minutia.angle + ((index % 3) * 0.35)
}));

test('the XYT adapter converts SourceAFIS direction into mpi-afis clockwise matcher direction', () => {
    const text = toMpiAfisXyt([{ x: 10.4, y: 20.6, angle: Math.PI / 2, quality: 83 }]);
    assert.equal(text.trim(), '10 21 45 83');
});

test('the XYT adapter normalizes wraparound before converting direction polarity', () => {
    const text = toMpiAfisXyt([{ x: 10, y: 20, angle: -Math.PI / 2, quality: 83 }]);
    assert.equal(text.trim(), '10 20 135 83');
});

test('MCC translation normalization changes only the coordinate origin, not local geometry', () => {
    const normalized = normalizeTranslationForLocalMatcher([
        { x: 120, y: 180, angle: 0 },
        { x: 144, y: 165, angle: 1 }
    ]);

    assert.deepEqual(normalized.shift, { x: -40, y: -85 });
    assert.deepEqual(normalized.minutiae.map(({ x, y }) => ({ x, y })), [
        { x: 80, y: 95 },
        { x: 104, y: 80 }
    ]);
    assert.equal(normalized.minutiae[1].x - normalized.minutiae[0].x, 24);
    assert.equal(normalized.minutiae[1].y - normalized.minutiae[0].y, -15);
});

test('MCC executes the reference binary and returns an independent native score', () => {
    const result = runMccMatcher({
        probeMinutiae: probe,
        referenceMinutiae: probe,
        threshold: 0.4,
        config: { executablePath: path.join(__dirname, '..', 'matchers', 'mpi-afis', 'mcc-match.exe') }
    });
    const changedResult = runMccMatcher({
        probeMinutiae: probe,
        referenceMinutiae: changed,
        threshold: 0.4,
        config: { executablePath: path.join(__dirname, '..', 'matchers', 'mpi-afis', 'mcc-match.exe') }
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.algorithm, 'MCC');
    assert.ok(Number.isFinite(result.rawScore));
    assert.ok(result.rawScore > changedResult.rawScore);
    assert.notEqual(result.rawScore, changedResult.rawScore);
});

test('Jiang executes its own reference binary and returns a score distinct from MCC', () => {
    const jiang = runJiangMatcher({
        probeMinutiae: probe,
        referenceMinutiae: probe,
        threshold: 0.4,
        config: { executablePath: path.join(__dirname, '..', 'matchers', 'mpi-afis', 'jiang-match.exe') }
    });
    const mcc = runMccMatcher({
        probeMinutiae: probe,
        referenceMinutiae: probe,
        threshold: 0.4,
        config: { executablePath: path.join(__dirname, '..', 'matchers', 'mpi-afis', 'mcc-match.exe') }
    });

    assert.equal(jiang.status, 'ok');
    assert.equal(jiang.algorithm, 'Jiang Matcher');
    assert.ok(Number.isFinite(jiang.rawScore));
    assert.notEqual(jiang.rawScore, mcc.rawScore);
});

test('disabling either matcher leaves the other matcher operational', () => {
    const executableRoot = path.join(__dirname, '..', 'matchers', 'mpi-afis');
    const disabledMcc = runMccMatcher({
        probeMinutiae: probe,
        referenceMinutiae: probe,
        threshold: 0.4,
        config: { disabled: true }
    });
    const enabledJiang = runJiangMatcher({
        probeMinutiae: probe,
        referenceMinutiae: probe,
        threshold: 0.4,
        config: { executablePath: path.join(executableRoot, 'jiang-match.exe') }
    });
    const disabledJiang = runJiangMatcher({
        probeMinutiae: probe,
        referenceMinutiae: probe,
        threshold: 0.4,
        config: { disabled: true }
    });
    const enabledMcc = runMccMatcher({
        probeMinutiae: probe,
        referenceMinutiae: probe,
        threshold: 0.4,
        config: { executablePath: path.join(executableRoot, 'mcc-match.exe') }
    });

    assert.equal(disabledMcc.error, 'MCC unavailable');
    assert.equal(enabledJiang.status, 'ok');
    assert.ok(Number.isFinite(enabledJiang.rawScore));
    assert.equal(disabledJiang.error, 'Jiang Matcher unavailable');
    assert.equal(enabledMcc.status, 'ok');
    assert.ok(Number.isFinite(enabledMcc.rawScore));
});

test('changing a matcher threshold changes only its decision and never its raw score', () => {
    const lowThreshold = runMccMatcher({
        probeMinutiae: probe,
        referenceMinutiae: changed,
        threshold: 0.01,
        config: { executablePath: path.join(__dirname, '..', 'matchers', 'mpi-afis', 'mcc-match.exe') }
    });
    const highThreshold = runMccMatcher({
        probeMinutiae: probe,
        referenceMinutiae: changed,
        threshold: 0.99,
        config: { executablePath: path.join(__dirname, '..', 'matchers', 'mpi-afis', 'mcc-match.exe') }
    });

    assert.equal(lowThreshold.rawScore, highThreshold.rawScore);
    assert.equal(lowThreshold.result, 'MATCH');
    assert.equal(highThreshold.result, 'NO MATCH');
});

test('missing executables and malformed minutiae return explicit isolated errors', () => {
    const unavailable = runMccMatcher({
        probeMinutiae: probe,
        referenceMinutiae: probe,
        threshold: 0.4,
        config: { executablePath: path.join(__dirname, 'does-not-exist.exe') }
    });
    const invalid = runJiangMatcher({
        probeMinutiae: [{ x: 'invalid', y: 10, angle: 0 }, ...probe.slice(1)],
        referenceMinutiae: probe,
        threshold: 0.4,
        config: { executablePath: path.join(__dirname, '..', 'matchers', 'mpi-afis', 'jiang-match.exe') }
    });

    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.error, 'MCC unavailable');
    assert.equal(invalid.status, 'error');
    assert.match(invalid.error, /Invalid minutia/);
});
