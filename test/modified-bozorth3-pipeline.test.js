'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const service = fs.readFileSync(path.join(root, 'fingerprint-service.js'), 'utf8');
const servicePage = fs.readFileSync(path.join(root, 'service-test.html'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const sharedResult = fs.readFileSync(path.join(root, 'fingerprint-comparison-result.js'), 'utf8');

function renderDashboardFingerprintResult(data) {
    const functionSource = dashboard.match(/function displayFingerprintResults[\s\S]*?(?=\n        async function enforceDashboardAccess)/)?.[0];
    assert.ok(functionSource, 'dashboard fingerprint result renderer must exist');

    let resultHtml = '';
    const resultElement = {
        get innerHTML() {
            return resultHtml;
        },
        set innerHTML(value) {
            resultHtml = value;
        }
    };
    vm.runInNewContext(`${functionSource}\ndisplayFingerprintResults(input);`, {
        input: data,
        document: {
            getElementById(id) {
                assert.equal(id, 'checkResults');
                return resultElement;
            }
        }
    });
    return resultHtml;
}

test('Modified Bozorth3 consumes the enhanced minutiae from both fingerprint pipelines', () => {
    assert.match(service, /function runModifiedBozorth3Comparison\(/);
    assert.match(service, /runAcademicBozorth3\(probe\.minutiae, reference\.minutiae/);
    assert.doesNotMatch(service, /runAcademicBozorth3\(sharedTemplates\.probe\.minutiae, sharedTemplates\.reference\.minutiae/);
    assert.match(service, /skipPreparation:\s*false/);
    assert.match(service, /algorithm:\s*'Modified Bozorth3'/);
    assert.match(service, /baseMatcher:\s*'Bozorth3'/);
});

test('the authoritative pipeline exports every real refinement artifact in order', () => {
    assert.match(service, /denoisedImage:/);
    assert.match(service, /gaborEnhancedImage:/);
    assert.match(service, /binarizedImage:/);
    assert.match(service, /thinnedImage:/);
    assert.match(service, /minutiaeOverlayImage:/);
    for (const stage of [
        'grayscale',
        'denoising',
        'gabor-ridge-enhancement',
        'binarization',
        'zhang-suen-thinning',
        'nist-mindtct-candidate-extraction',
        'zhang-suen-skeleton-validation',
        'bozorth3-matching'
    ]) assert.match(service, new RegExp(`'${stage}'`));
    assert.match(service, /const enhancedRaw = applyGaborRidgeEnhancement\(grayscale\.pixels/);
    assert.match(service, /const binary = adaptiveBinarize\(enhancedRaw/);
    assert.match(service, /const thinned = zhangSuenThin\(binary/);
    assert.match(service, /const crossingNumberMinutiae = extractMinutiaePoints\(thinned/);
    assert.match(service, /runMindtctExtractor\(\{/);
    assert.match(service, /filterMindtctMinutiaeBySkeleton\(/);
});

test('service-test displays actual Modified Bozorth3 stage outputs', () => {
    for (const field of ['originalImage', 'denoisedImage', 'gaborEnhancedImage', 'binarizedImage', 'thinnedImage', 'minutiaeOverlayImage']) {
        assert.match(servicePage, new RegExp(`result\\.${field}`));
    }
    for (const label of ['Original', 'Denoised', 'Gabor Enhanced', 'Binarized', 'Zhang-Suen Thinned', 'Minutiae Detected']) {
        assert.match(servicePage, new RegExp(label));
    }
    assert.match(servicePage, /Modified Bozorth3 Result/);
});

test('all operator surfaces identify the enhanced primary matcher consistently', () => {
    assert.match(servicePage, /Modified Bozorth3/);
    assert.match(admin, /Modified Bozorth3/);
    assert.match(sharedResult, /Modified Bozorth3/);
    assert.match(dashboard, /fingerprint-comparison-result\.js/);
});

test('admin exposes the calibrated result while dashboard keeps percentages private', () => {
    const backend = fs.readFileSync(path.join(root, 'backend', 'applicant_info.php'), 'utf8');

    assert.match(backend, /\/afis\/compare-all/);
    assert.match(backend, /normalizedMatchPercentage/);
    assert.match(dashboard, /Fingerprint verification is processing\./);
    assert.match(dashboard, /badge-approved">PROCESSING\.\.\.<\/span>/);
    assert.doesNotMatch(dashboard, /Calibrated Match Percentage/);
    assert.doesNotMatch(dashboard, /FingerprintComparison\.matcherPercentage\(primaryMatcher\)/);
    assert.doesNotMatch(dashboard, /Confirmed fingerprint match\./);
    assert.doesNotMatch(dashboard, /No fingerprint match found\./);
    assert.match(admin, /FingerprintComparison\.renderComparisonResult\(entry\.comparison_result\)/);
    assert.match(sharedResult, /NIST MINDTCT Candidate Extraction/);
    assert.match(sharedResult, /Zhang-Suen Skeleton Validation/);
});

test('dashboard accepts a confirmed fingerprint no-match and shows fingerprint matches as green processing', () => {
    const acceptedHtml = renderDashboardFingerprintResult({
        is_match: false,
        requires_manual_review: false,
        clearance_status: 'APPROVED'
    });
    assert.match(acceptedHtml, /Application accepted\./);
    assert.match(acceptedHtml, /badge-approved">ACCEPTED<\/span>/);
    assert.doesNotMatch(acceptedHtml, /PROCESSING/);

    const matchedHtml = renderDashboardFingerprintResult({
        is_match: true,
        requires_manual_review: true,
        clearance_status: 'UNDER_REVIEW'
    });
    assert.match(matchedHtml, /Fingerprint verification is processing\./);
    assert.match(matchedHtml, /result-card approved show/);
    assert.match(matchedHtml, /badge-approved">PROCESSING\.\.\.<\/span>/);
    assert.doesNotMatch(matchedHtml, /Calibrated Match Percentage/);
});
