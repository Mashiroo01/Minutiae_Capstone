const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

test('the academic comparison supports five engines without duplicating them as visualization tabs', () => {
    const service = fs.readFileSync(path.join(root, 'fingerprint-service.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'service-test.html'), 'utf8');

    for (const matcher of ['Bozorth3', 'SourceAFIS', 'OpenAFIS', 'MCC', 'Jiang Matcher']) {
        assert.match(service, new RegExp(matcher, 'i'));
        assert.match(html, new RegExp(matcher, 'i'));
    }

    assert.doesNotMatch(html, /<button class="matcher-tab/);
    assert.equal((html.match(/class="threshold-field/g) || []).length, 5);
    assert.match(html, /completed}\/\$\{matchers\.length \|\| 5}/);
    assert.match(html, /id="mccThreshold"/);
    assert.match(html, /id="jiangThreshold"/);
    assert.match(html, /Minutiae Used/);
    assert.match(html, /Detailed correspondence visualization unavailable for this matcher/);
});

test('the comparison page inline JavaScript compiles', () => {
    const html = fs.readFileSync(path.join(root, 'service-test.html'), 'utf8');
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];

    assert.ok(scripts.length > 0, 'Expected at least one inline script');
    for (const [, source] of scripts) {
        assert.doesNotThrow(() => new vm.Script(source));
    }
});

test('the comparison preserves clean source images and reports matcher input diagnostics', () => {
    const service = fs.readFileSync(path.join(root, 'fingerprint-service.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'service-test.html'), 'utf8');

    assert.match(html, /probeImage:\s*state\.probe\.result\.originalImage/);
    assert.match(html, /referenceImage:\s*state\.candidate\.result\.originalImage/);
    assert.doesNotMatch(html, /probePreprocessed:\s*true/);
    assert.doesNotMatch(html, /referencePreprocessed:\s*true/);
    assert.match(service, /sourceAfisProbe/);
    assert.match(service, /const sourceAfisProbe = probeBuffer/);
    assert.match(service, /const sourceAfisReference = referenceBuffer/);
    assert.match(service, /inputDiagnostics/);
    assert.match(service, /imageHash/);
    assert.match(service, /coordinateConvention/);
    assert.match(service, /angleConvention/);
});

test('Bozorth3 uses the calibrated score-independent minutiae feed and exposes native diagnostics', () => {
    const service = fs.readFileSync(path.join(root, 'fingerprint-service.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'service-test.html'), 'utf8');

    assert.match(service, /require\('\.\/matchers\/bozorth3\/bozorth3-runner'\)/);
    assert.match(service, /bozorth3Threshold:\s*Number\(process\.env\.BOZORTH3_MATCH_THRESHOLD \|\| 20\)/);
    assert.match(service, /runAcademicBozorth3\(sharedTemplates\.probe\.minutiae, sharedTemplates\.reference\.minutiae/);
    assert.doesNotMatch(service, /runAcademicBozorth3\(probe\.minutiae, reference\.minutiae/);
    assert.match(service, /bozorth3Minutiae:\s*sharedTemplates\.probe\.minutiae/);
    assert.match(html, /id="bozorth3Threshold"[^>]*value="20"/);
    assert.match(html, /Bozorth3 Diagnostics/);
    assert.match(html, /Template SHA-256/);
    assert.match(html, /Native Command/);
    assert.match(html, /Quality Gate/);
});
