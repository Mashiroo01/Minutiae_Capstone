'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'service-test.html'), 'utf8');

function contentBetween(startMarker, endMarker) {
    const start = page.indexOf(startMarker);
    const end = page.indexOf(endMarker);
    assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
    assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
    return page.slice(start, end);
}

test('the default operator view follows the applicant criminal four-step workflow', () => {
    const operatorView = contentBetween('<!-- operator-view -->', '<!-- /operator-view -->');

    assert.match(operatorView, />Fingerprint Comparison</);
    assert.match(operatorView, />Applicant Fingerprint</);
    assert.match(operatorView, />Criminal Fingerprint</);
    assert.match(operatorView, />Step 1</);
    assert.match(operatorView, />Step 2</);
    assert.match(operatorView, />Step 3</);
    assert.match(operatorView, />Step 4</);
    assert.match(operatorView, />Primary Matcher</i);
    assert.match(operatorView, />Supporting Matchers</i);
    assert.match(operatorView, />Final Fingerprint Result</i);
    assert.match(operatorView, /id="scanFingerprintButton"/);
    assert.match(operatorView, /id="scanStoredFingerprintButton"[^>]*>Scan Fingerprint</);
    assert.match(operatorView, /id="compareButton"/);
    assert.match(operatorView, /id="scanAgainButton"/);
    assert.match(operatorView, /id="newComparisonButton"/);

    assert.doesNotMatch(operatorView, /threshold/i);
    assert.doesNotMatch(operatorView, /raw score/i);
    assert.doesNotMatch(operatorView, /normalized similarity/i);
    assert.doesNotMatch(operatorView, /confidence|accuracy|\bFAR\b|\bFRR\b|\bF1\b/i);
    assert.doesNotMatch(operatorView, /current fingerprint|stored fingerprint|probe fingerprint|reference fingerprint|candidate fingerprint/i);
    assert.doesNotMatch(operatorView, /\bXYT\b|\bDPI\b|file path|image hash|stdout|stderr/i);
});

test('real fingerprint correspondence visualization remains in the normal operator view', () => {
    const operatorView = contentBetween('<!-- operator-view -->', '<!-- /operator-view -->');
    const advancedView = contentBetween('<!-- advanced-info -->', '<!-- /advanced-info -->');

    assert.match(operatorView, />Fingerprint Comparison Visualization</);
    assert.match(operatorView, /Shows the fingerprint points found between the Applicant Fingerprint and Criminal Fingerprint\./);
    assert.match(operatorView, /id="primaryFingerprintComparison"/);
    assert.match(operatorView, /id="correspondenceCountHeading"/);
    assert.match(operatorView, />Ridge Ending</);
    assert.match(operatorView, />Bifurcation</);
    assert.doesNotMatch(advancedView, /id="primaryFingerprintComparison"/);
});

test('technical details and every threshold control are collapsed under advanced info', () => {
    const advancedView = contentBetween('<!-- advanced-info -->', '<!-- /advanced-info -->');

    assert.match(advancedView, /<details id="advancedInfo" class="advanced-info">/);
    assert.doesNotMatch(advancedView, /<details id="advancedInfo"[^>]*\bopen\b/);
    assert.match(advancedView, /id="advancedInfoLabel">Show Advanced Info</);
    assert.match(advancedView, />Advanced \/ Technical Information</);
    assert.match(advancedView, /id="bozorth3Threshold"/);
    assert.match(advancedView, /id="sourceAfisThreshold"/);
    assert.match(advancedView, /id="openAfisThreshold"/);
    assert.match(advancedView, /id="mccThreshold"/);
    assert.match(advancedView, /id="jiangThreshold"/);
    assert.match(advancedView, /id="developerDiagnostics"/);
    assert.doesNotMatch(advancedView, /<details id="developerDiagnostics"[^>]*\bopen\b/);
});

test('advanced info toggle exposes its state with accessible wording', () => {
    assert.match(page, /advancedInfo\.addEventListener\('toggle'/);
    assert.match(page, /advancedInfoLabel\.textContent = advancedInfo\.open \? 'Hide Advanced Info' : 'Show Advanced Info'/);
    assert.match(page, /aria-label="Show Advanced Info"/);
});

test('comparison rendering keeps Modified Bozorth3 primary and groups four supporting matchers', () => {
    assert.match(page, /const primaryMatcher = FingerprintComparison\.matcherByName\(result, 'Modified Bozorth3'\)/);
    assert.match(page, /const supportingMatchers = matchers\.filter\(\(matcher\) => !\['Modified Bozorth3', 'Bozorth3'\]\.includes\(matcher\.algorithm\)\)/);
    assert.match(page, /id="primaryMatcherResult"/);
    assert.match(page, /id="primaryMatcherPercentage"/);
    assert.match(page, /id="supportingMatcherResults"/);
    assert.match(page, /id="supportingAgreement"/);
    assert.match(page, /id="supportingArbiterPercentage"/);
    assert.match(page, /id="supportingArbiterDecision"/);
    assert.match(page, /id="finalDecision"/);
    assert.match(page, /\$\{agreeingMatchers\.length\} of \$\{completedMatchers\.length\}/);
});

test('the supporting arbiter is presented as a calibrated four-model score with a decision warning', () => {
    assert.match(page, />Four-Model Arbiter</);
    assert.match(page, /result\.supportingArbiter/);
    assert.match(page, /supportingArbiter\.normalizedMatchPercentage/);
    assert.match(page, /3-of-4/);
    assert.match(page, /not a probability of identity/i);
});

test('operator percentages use only backend calibrated match percentages and never raw matcher scores', () => {
    const percentageFormatter = contentBetween('function formatOperatorPercentage(matcher)', 'function renderOperatorResults()');

    assert.match(percentageFormatter, /matcher\?\.normalizedMatchPercentage/);
    assert.match(percentageFormatter, /normalization\?\.status === 'calibrated'/);
    assert.match(percentageFormatter, /Calibration Required/);
    assert.doesNotMatch(percentageFormatter, /matcher\?\.score|matcher\.score|rawScore/);
    assert.match(page, /primaryMatcherPercentage\.textContent = formatOperatorPercentage\(primaryMatcher\)/);
    assert.match(page, /class="matcher-percentage"/);
    assert.match(page, />Match Percentage</);
});

test('advanced results disclose the calibration method, ranges, status, and warning', () => {
    assert.match(page, />Normalized Match Percentage</);
    assert.match(page, />Calibration Status</);
    assert.match(page, />Normalization Method</);
    assert.match(page, />Calibration Ranges</);
    assert.match(page, />Interpretation Warning</);
    assert.match(page, /matcher\.normalization\?\.distributions/);
});

test('operator comparison exposes a clear loading state', () => {
    assert.match(page, /Comparing fingerprints\.\.\./);
    assert.match(page, /Please wait while the fingerprints are being analyzed\./);
});

test('fingerprint quality is translated into simple operator states', () => {
    assert.match(page, /function qualityState\(value\)/);
    assert.match(page, /label: 'Good'/);
    assert.match(page, /label: 'Acceptable'/);
    assert.match(page, /label: 'Poor'/);
    assert.match(page, /Fingerprint quality is too low\./);
    assert.match(page, /Please scan the finger again\./);
});

test('correspondence visualization is matcher-neutral in the main interface', () => {
    assert.match(page, />Fingerprint Comparison Visualization</);
    assert.match(page, /Shows the fingerprint points found between the Applicant Fingerprint and Criminal Fingerprint\./);
    assert.doesNotMatch(page, /class="matcher-tabs"/);
    assert.doesNotMatch(page, /state\.selectedMatcher/);
    assert.doesNotMatch(page, /id="selectedMatcherSummary"/);
    assert.match(page, /id="toggleMinutiae"/);
    assert.match(page, /id="toggleMatchedPairs"/);
    assert.match(page, /id="toggleDirections"/);
    assert.doesNotMatch(page, /id="toggleUnmatched"/);
    assert.match(page, /id="zoomInButton"/);
    assert.match(page, /id="zoomOutButton"/);
    assert.match(page, /id="resetViewButton"/);
    assert.match(page, /id="fullscreenComparisonButton"/);
});

test('correspondence data comes only from OpenAFIS with a small technical disclosure', () => {
    assert.match(page, /find\(\(item\) => item\.algorithm === 'OpenAFIS'\)/);
    assert.match(page, /<summary>Technical Details<\/summary>/);
    assert.match(page, /Correspondence visualization source: <strong>OpenAFIS<\/strong>/);
    assert.match(page, /state\.selectedPairId/);
    assert.match(page, /data-pair-id/);
    assert.match(page, /class="correspondence-table"/);
    assert.match(page, />View all</);
});

test('correspondence summary and details use general matcher-neutral wording', () => {
    assert.match(page, /id="correspondenceCountHeading"/);
    assert.match(page, /<summary>View Correspondence Details<\/summary>/);
    assert.match(page, /matched minutiae correspondences detected/);
    assert.match(page, /Showing \$\{pairs\.length\} of \$\{allPairs\.length\} detected correspondences/);
    assert.doesNotMatch(page, /visualization uses only its own matcher result/);
});

test('zoom and pan transform the image and overlay as one coordinate surface', () => {
    assert.match(page, /function applyVisualizationTransform\(\)/);
    assert.match(page, /comparison-transform-layer/);
    assert.match(page, /state\.visualization\.zoom/);
    assert.match(page, /pointerdown/);
    assert.match(page, /wheel/);
});

test('a new comparison resets stale correspondence inspection state', () => {
    assert.match(page, /state\.compare = result;[\s\S]*?state\.selectedPairId = '';[\s\S]*?state\.visualization\.showAllPairs = false;[\s\S]*?resetVisualizationView\(\);[\s\S]*?renderCompare\(\);/);
});

test('comparison layout has explicit compact and mobile presentation rules', () => {
    assert.match(page, /\.visualization-toolbar/);
    assert.match(page, /\.correspondence-table/);
    assert.match(page, /@media \(max-width: 760px\)[\s\S]*\.comparison-inspector/);
});

test('comparison points use the same aspect-ratio-preserving placement as scanner images', () => {
    const comparisonPointSource = contentBetween('function comparisonPoint(', 'function pointAngleRadians(');
    const context = {
        input: {
            point: { x: 0, y: 0 },
            side: 'probe',
            fingerprint: { width: 250, height: 500 },
            layout: { imageSize: 500, probe: { x: 0, y: 34 } }
        },
        result: null
    };
    vm.runInNewContext(`${comparisonPointSource}\nresult = comparisonPoint(input.point, input.side, input.fingerprint, input.layout);`, context);
    assert.deepEqual({ ...context.result }, { x: 125, y: 34 });

    context.input.point = { x: 250, y: 500 };
    vm.runInNewContext(`${comparisonPointSource}\nresult = comparisonPoint(input.point, input.side, input.fingerprint, input.layout);`, context);
    assert.deepEqual({ ...context.result }, { x: 375, y: 534 });
});
