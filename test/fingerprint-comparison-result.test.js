'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const comparison = require('../fingerprint-comparison-result');

function matcher(algorithm, percentage, result, overrides = {}) {
    return {
        algorithm,
        status: 'ok',
        score: overrides.score ?? percentage,
        rawScore: overrides.rawScore ?? overrides.score ?? percentage,
        normalizedMatchPercentage: percentage,
        threshold: overrides.threshold ?? 20,
        result,
        processingTimeMs: overrides.processingTimeMs ?? 5,
        normalization: { status: 'calibrated' },
        ...overrides
    };
}

test('the shared result preserves backend matcher percentages and keeps Modified Bozorth3 primary', () => {
    const result = comparison.buildFingerprintComparisonResult({
        success: true,
        traceId: 'trace-123',
        matchers: [
            matcher('Modified Bozorth3', 86, 'MATCH', { baseMatcher: 'Bozorth3' }),
            matcher('SourceAFIS', 91, 'MATCH'),
            matcher('OpenAFIS', 84, 'MATCH'),
            matcher('MCC', 76, 'MATCH'),
            matcher('Jiang Matcher', 34, 'NO MATCH')
        ],
        probe: { image: 'probe', quality: 82, preprocessing: { stages: ['normalize'] } },
        reference: { image: 'reference', quality: 78, preprocessing: { stages: ['normalize'] } }
    }, { createdAt: '2026-10-08T00:00:00.000Z' });

    assert.equal(result.comparisonId, 'trace-123');
    assert.deepEqual(result.matchers.map((item) => item.normalizedMatchPercentage), [86, 91, 84, 76, 34]);
    assert.equal(result.primaryMatcher.algorithm, 'Modified Bozorth3');
    assert.equal(result.primaryMatcher.normalizedMatchPercentage, 86);
    assert.equal(result.matcherAgreement.agreeing, 4);
    assert.equal(result.matcherAgreement.completed, 5);
    assert.equal(result.matcherAgreement.label, '4 of 5');
    assert.equal(result.finalResult.decision, 'MATCH');
    assert.equal(result.quality.subject.label, 'Good');
    assert.equal(result.quality.reference.label, 'Good');
    assert.deepEqual(result.preprocessing.subject, { stages: ['normalize'] });
});

test('missing values remain unavailable instead of being fabricated', () => {
    const result = comparison.buildFingerprintComparisonResult({
        success: true,
        matchers: [{
            algorithm: 'Bozorth3',
            status: 'error',
            result: 'UNAVAILABLE'
        }],
        probe: {},
        reference: {}
    });

    assert.equal(result.primaryMatcher.normalizedMatchPercentage, undefined);
    assert.equal(result.quality.subject.score, null);
    assert.equal(result.quality.subject.label, 'Unavailable');
    assert.equal(result.finalResult.decision, 'REVIEW REQUIRED');
    assert.equal(result.correspondences.available, false);
    assert.deepEqual(result.correspondences.pairs, []);
});

test('visualization exposes only actual OpenAFIS correspondence pairs', () => {
    const pairs = [{
        id: 'pair-1',
        probe: { x: 10, y: 20, type: 'ridge-ending' },
        reference: { x: 30, y: 40, type: 'bifurcation' }
    }];
    const result = comparison.buildFingerprintComparisonResult({
        success: true,
        matchers: [
            matcher('Bozorth3', 55, 'NO MATCH'),
            matcher('OpenAFIS', 42, 'NO MATCH', {
                matchedMinutiae: { available: true, pairs }
            })
        ],
        probe: { image: 'probe', width: 100, height: 100 },
        reference: { image: 'reference', width: 100, height: 100 }
    });

    assert.equal(result.correspondences.sourceMatcher, 'OpenAFIS');
    assert.strictEqual(result.correspondences.pairs, pairs);
    assert.match(comparison.renderFingerprintVisualization(result), /data-pair-id="pair-1"/);
    assert.match(comparison.renderFingerprintVisualization(result), /<line /);

    const unavailable = comparison.buildFingerprintComparisonResult({
        success: true,
        matchers: [matcher('Bozorth3', 55, 'NO MATCH')],
        probe: { image: 'probe' },
        reference: { image: 'reference' }
    });
    assert.doesNotMatch(comparison.renderFingerprintVisualization(unavailable), /<line /);
    assert.match(comparison.renderFingerprintVisualization(unavailable), /Correspondence data is unavailable/);
});

test('serialized comparison stores each fingerprint payload once and hydrates display aliases in memory', () => {
    const result = comparison.buildFingerprintComparisonResult({
        success: true,
        matchers: [matcher('Modified Bozorth3', 70, 'MATCH')],
        probe: { originalImage: 'unique-probe-image', quality: 80 },
        reference: { originalImage: 'unique-reference-image', quality: 80 }
    });
    const serialized = JSON.stringify(result);

    assert.equal(serialized.match(/unique-probe-image/g)?.length, 1);
    assert.equal(serialized.match(/unique-reference-image/g)?.length, 1);

    const hydrated = comparison.ensureComparisonResult(JSON.parse(serialized));
    assert.equal(hydrated.subjectFingerprint.originalImage, 'unique-probe-image');
    assert.equal(hydrated.referenceFingerprint.originalImage, 'unique-reference-image');
});

test('bifurcation markers stay aligned with letterboxed non-square fingerprint images', () => {
    const pairs = [{
        id: 'B1',
        probe: { x: 0, y: 0, type: 'bifurcation' },
        reference: { x: 0, y: 0, type: 'bifurcation' }
    }];
    const result = comparison.buildFingerprintComparisonResult({
        success: true,
        matchers: [matcher('OpenAFIS', 70, 'MATCH', {
            matchedMinutiae: { available: true, pairs }
        })],
        probe: { image: 'probe', width: 250, height: 500 },
        reference: { image: 'reference', width: 500, height: 250 }
    });

    const html = comparison.renderFingerprintVisualization(result);
    assert.match(html, /<line x1="130" y1="45" x2="540" y2="155">/);
    assert.match(html, /points="130,39 124,50 136,50"/);
    assert.match(html, /points="540,149 534,160 546,160"/);
});

test('the default result is simple while thresholds and diagnostics stay collapsed', () => {
    const result = comparison.buildFingerprintComparisonResult({
        success: true,
        traceId: 'trace-advanced',
        matchers: [matcher('Bozorth3', 86, 'MATCH', { score: 42, threshold: 20 })],
        probe: { image: 'probe', quality: 80 },
        reference: { image: 'reference', quality: 80 }
    });
    const html = comparison.renderComparisonResult(result);
    const advancedIndex = html.indexOf('<details class="fp-advanced">');

    assert.ok(advancedIndex > 0);
    assert.doesNotMatch(html.slice(0, advancedIndex), /Raw Score|Threshold|Developer Diagnostics/);
    assert.match(html.slice(advancedIndex), /Raw Score/);
    assert.match(html.slice(advancedIndex), /Threshold/);
    assert.match(html.slice(advancedIndex), /Developer Diagnostics/);
    assert.doesNotMatch(html, /<details class="fp-advanced"[^>]*\bopen\b/);
    assert.doesNotMatch(html, /<details class="fp-developer-diagnostics"[^>]*\bopen\b/);
});

test('admin and dashboard inline scripts compile', () => {
    for (const fileName of ['admin.html', 'dashboard.html']) {
        const html = fs.readFileSync(path.join(root, fileName), 'utf8');
        const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
            .map((match) => match[1])
            .filter((source) => source.trim());

        assert.ok(inlineScripts.length > 0, `${fileName} should contain inline JavaScript`);
        inlineScripts.forEach((source) => assert.doesNotThrow(() => new vm.Script(source), `${fileName} inline JavaScript should compile`));
    }
});

test('admin exposes rejection only for a pending fingerprint MATCH reviewed by a super admin', () => {
    const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
    const functionSource = admin.match(/function isRejectableFingerprintMatch[\s\S]*?(?=\n\s*function configureFingerprintMatchActions)/)?.[0];
    assert.ok(functionSource, 'fingerprint rejection eligibility helper must exist');

    const context = {};
    vm.runInNewContext(`${functionSource}\nresult = [
        isRejectableFingerprintMatch({ review_status: 'PENDING_REVIEW', comparison_result: { finalResult: { decision: 'MATCH' } } }, { role: 'super_admin' }),
        isRejectableFingerprintMatch({ review_status: 'PENDING_REVIEW', comparison_result: { finalResult: { decision: 'MATCH' } } }, { role: 'admin' }),
        isRejectableFingerprintMatch({ review_status: 'PENDING_REVIEW', comparison_result: { finalResult: { decision: 'NO MATCH' } } }, { role: 'super_admin' }),
        isRejectableFingerprintMatch({ review_status: 'REVIEWED', comparison_result: { finalResult: { decision: 'MATCH' } } }, { role: 'super_admin' })
    ];`, context);

    assert.deepEqual(Array.from(context.result), [true, false, false, false]);
    assert.match(admin, /id="rejectFingerprintMatchButton"/);
    assert.match(admin, /decision:\s*'reject'/);
});

test('application View integrates fingerprint notification details and opens the persisted result', () => {
    const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
    const backend = fs.readFileSync(path.join(root, 'backend', 'applicant_info.php'), 'utf8');

    assert.match(admin, /Fingerprint Match Notifications/);
    assert.match(admin, /notification_final_result/);
    assert.match(admin, /notification_status/);
    assert.match(admin, /finger_matched/);
    assert.match(admin, /comparison_id/);
    assert.match(admin, /View Fingerprint Result/);
    assert.match(admin, /openApplicationFingerprintComparison/);
    assert.match(backend, /'fingerprint_notifications'\s*=>/);
});

test('dashboard, backend, service test, and admin share one persisted result path', () => {
    const service = fs.readFileSync(path.join(root, 'fingerprint-service.js'), 'utf8');
    const php = fs.readFileSync(path.join(root, 'backend', 'applicant_info.php'), 'utf8');
    const database = fs.readFileSync(path.join(root, 'backend', 'FingerprintDB.php'), 'utf8');
    const dashboard = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
    const servicePage = fs.readFileSync(path.join(root, 'service-test.html'), 'utf8');
    const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');

    assert.match(service, /buildFingerprintComparisonResult/);
    assert.match(php, /\/afis\/compare-all/);
    assert.match(php, /comparison_result/);
    assert.match(database, /comparison_result/);
    assert.match(dashboard, /comparison_result/);
    assert.match(servicePage, /fingerprint-comparison-result\.js/);
    assert.match(servicePage, /FingerprintComparison/);
    assert.match(admin, /fingerprint-comparison-result\.js/);
    assert.match(admin, /FingerprintComparison\.renderComparisonResult/);
    assert.doesNotMatch(admin, /fetch\(['"]http:\/\/localhost:9000\/afis\/(?:compare|compare-all)/);
});
