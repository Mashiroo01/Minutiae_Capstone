'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SERVICE_BASE = process.env.FINGERPRINT_SERVICE_BASE || 'http://localhost:9000';
const ROOT = path.join(__dirname, '..');
const DATASET_ROOT = process.env.FVC_REPEATED_DATASET_ROOT
    || process.env.FVC2004_DB4_B_ROOT
    || path.join(ROOT, 'temp', 'matcher-build', 'openafis', 'data', 'valid', 'fvc2004', 'DB2_B');
const DATASET_NAME = path.basename(DATASET_ROOT);
const REQUESTED_MATCHERS = ['OpenAFIS', 'MCC', 'Jiang Matcher'];

function sample(identity, impression) {
    return {
        id: `FVC2004-${DATASET_NAME}-${identity}-${impression}`,
        fingerPosition: `FVC2004 ${DATASET_NAME} identity ${identity}`,
        filePath: path.join(DATASET_ROOT, `${identity}_${impression}.tif`)
    };
}

async function compare(probe, reference) {
    const probeImage = fs.readFileSync(probe.filePath);
    const referenceImage = fs.readFileSync(reference.filePath);
    const response = await fetch(`${SERVICE_BASE}/afis/compare-all`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            probeImage: probeImage.toString('base64'),
            referenceImage: referenceImage.toString('base64'),
            probeInfo: {
                fingerprintId: probe.id,
                fileName: path.basename(probe.filePath),
                fingerPosition: probe.fingerPosition,
                dpi: 500
            },
            referenceInfo: {
                fingerprintId: reference.id,
                fileName: path.basename(reference.filePath),
                fingerPosition: reference.fingerPosition,
                dpi: 500
            }
        })
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
        throw new Error(payload.error || `Comparison failed with HTTP ${response.status}.`);
    }
    return payload;
}

function requestedResults(payload) {
    return REQUESTED_MATCHERS.map((algorithm) => {
        const matcher = payload.matchers.find((item) => item.algorithm === algorithm);
        if (!matcher) throw new Error(`${algorithm} result is missing.`);
        if (matcher.status !== 'ok') throw new Error(`${algorithm} failed: ${matcher.error || matcher.statusMessage}`);
        if (!Number.isFinite(matcher.rawScore)) throw new Error(`${algorithm} returned a non-finite raw score.`);
        if (!matcher.inputDiagnostics?.verifiedSharedPair) throw new Error(`${algorithm} did not verify the shared input pair.`);
        return matcher;
    });
}

function decisionErrors(scenario, matchers) {
    const errors = [];
    for (const matcher of matchers) {
        if (matcher.result !== scenario.expected) {
            errors.push(
                `${scenario.label}: ${matcher.algorithm} returned ${matcher.result} `
                + `(raw score ${matcher.rawScore}, threshold ${matcher.threshold}); expected ${scenario.expected}.`
            );
        }
    }
    return errors;
}

async function main() {
    const requestedScenarioKeys = new Set(
        String(process.env.VERIFY_SCENARIOS || '').split(',').map((item) => item.trim()).filter(Boolean)
    );
    const allScenarios = [
        { key: 'exact', label: 'identity 101 impression 1 vs itself', probe: sample('101', '1'), reference: sample('101', '1'), expected: 'MATCH' },
        { key: 'genuine12', label: 'identity 101 impression 1 vs 2', probe: sample('101', '1'), reference: sample('101', '2'), expected: 'MATCH' },
        { key: 'genuine13', label: 'identity 101 impression 1 vs 3', probe: sample('101', '1'), reference: sample('101', '3'), expected: 'MATCH' },
        { key: 'differentIdentity', label: 'identity 101 impression 1 vs identity 102 impression 1', probe: sample('101', '1'), reference: sample('102', '1'), expected: 'NO MATCH' }
    ];
    const scenarios = requestedScenarioKeys.size
        ? allScenarios.filter((scenario) => requestedScenarioKeys.has(scenario.key))
        : allScenarios;

    const report = [];
    const failures = [];
    for (const scenario of scenarios) {
        const payload = await compare(scenario.probe, scenario.reference);
        const matchers = requestedResults(payload);
        report.push({
            key: scenario.key,
            pair: scenario.label,
            groundTruth: scenario.expected === 'MATCH' ? 'Genuine' : 'Impostor',
            inputDiagnostics: payload.inputDiagnostics,
            referenceMatchers: payload.matchers
                .filter((matcher) => matcher.algorithm === 'Bozorth3' || matcher.algorithm === 'SourceAFIS')
                .map((matcher) => ({ algorithm: matcher.algorithm, rawScore: matcher.rawScore, threshold: matcher.threshold, decision: matcher.result })),
            matchers: matchers.map((matcher) => ({
                algorithm: matcher.algorithm,
                rawScore: matcher.rawScore,
                threshold: matcher.threshold,
                scoreDirection: matcher.scoreDirection || 'higher-is-more-similar',
                decision: matcher.result,
                minutiae: matcher.inputMinutiae,
                diagnostics: matcher.matcherDiagnostics || null
            }))
        });
        failures.push(...decisionErrors(scenario, matchers));
    }

    console.log(JSON.stringify({ verified: failures.length === 0, dataset: `FVC2004 ${DATASET_NAME}`, scenarios: report }, null, 2));
    if (failures.length) {
        throw new Error(failures.join('\n'));
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
