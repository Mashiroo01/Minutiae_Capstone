'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'service-test.html'), 'utf8');

test('correspondence visualization is matcher-neutral in the main interface', () => {
    assert.match(page, />Fingerprint Correspondence Visualization</);
    assert.match(page, /Visual comparison of the probe and reference fingerprints based on detected minutiae correspondences\./);
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
