const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SERVICE_BASE = process.env.FINGERPRINT_SERVICE_BASE || 'http://localhost:9000';
const samplePath = path.join(__dirname, '..', 'fingerprint-test.png');

async function compare(probe, reference) {
    const response = await fetch(`${SERVICE_BASE}/afis/compare-all`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            probeImage: probe.toString('base64'),
            referenceImage: reference.toString('base64'),
            thresholds: { bozorth3: 40, sourceafis: 40, openafis: 6, mcc: 0.04, jiang: 0.245 }
        })
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
        throw new Error(payload.error || `Comparison failed with HTTP ${response.status}.`);
    }
    return payload;
}

function assertRealResults(result, label) {
    const expected = ['Bozorth3', 'SourceAFIS', 'OpenAFIS', 'MCC', 'Jiang Matcher'];
    for (const algorithm of expected) {
        const matcher = result.matchers.find((item) => item.algorithm === algorithm);
        if (!matcher) throw new Error(`${label}: ${algorithm} result is missing.`);
        if (matcher.status !== 'ok') throw new Error(`${label}: ${algorithm} is unavailable: ${matcher.error}`);
        if (!Number.isFinite(matcher.score)) throw new Error(`${label}: ${algorithm} score is not finite.`);
        if (!Number.isFinite(matcher.processingTimeMs) || matcher.processingTimeMs < 0) {
            throw new Error(`${label}: ${algorithm} processing time is invalid.`);
        }
        if (algorithm === 'MCC' || algorithm === 'Jiang Matcher') {
            if (!Number.isFinite(matcher.normalizedSimilarity)) {
                throw new Error(`${label}: ${algorithm} normalized similarity is invalid.`);
            }
            if (!matcher.inputMinutiae || matcher.inputMinutiae.probeUsed < 1 || matcher.inputMinutiae.referenceUsed < 1) {
                throw new Error(`${label}: ${algorithm} did not report its real minutiae input counts.`);
            }
        }
    }
}

async function main() {
    const original = fs.readFileSync(samplePath);
    const changedReference = await sharp(original).flop().png().toBuffer();
    const rotatedReference = await sharp(original)
        .rotate(8, { background: { r: 255, g: 255, b: 255, alpha: 1 } })
        .png()
        .toBuffer();
    const pressureSurrogate = await sharp(original)
        .linear(0.72, 35)
        .png()
        .toBuffer();
    const metadata = await sharp(original).metadata();
    const lowQualityReference = await sharp(original)
        .resize(Math.max(64, Math.round(metadata.width / 3)))
        .resize(metadata.width, metadata.height)
        .jpeg({ quality: 20 })
        .toBuffer();
    const blurryReference = await sharp(original)
        .blur(3)
        .png()
        .toBuffer();
    const placementReference = await sharp(original)
        .affine([[1, 0], [0, 1]], {
            idx: 18,
            idy: -14,
            background: { r: 255, g: 255, b: 255, alpha: 1 }
        })
        .png()
        .toBuffer();
    const cropWidth = Math.max(64, Math.round(metadata.width * 0.68));
    const cropHeight = Math.max(64, Math.round(metadata.height * 0.68));
    const left = Math.round((metadata.width - cropWidth) / 2);
    const top = Math.round((metadata.height - cropHeight) / 2);
    const partialReference = await sharp(original)
        .extract({ left, top, width: cropWidth, height: cropHeight })
        .extend({
            left,
            right: metadata.width - cropWidth - left,
            top,
            bottom: metadata.height - cropHeight - top,
            background: { r: 255, g: 255, b: 255, alpha: 1 }
        })
        .png()
        .toBuffer();

    const scenarios = [
        { key: 'sameFilePair', label: 'same available sample submitted twice', reference: original },
        { key: 'mirroredInput', label: 'synthetically mirrored changed input', reference: changedReference },
        { key: 'rotationSurrogate', label: 'synthetic 8-degree rotation surrogate', reference: rotatedReference },
        { key: 'pressureSurrogate', label: 'synthetic contrast/brightness pressure surrogate', reference: pressureSurrogate },
        { key: 'placementSurrogate', label: 'synthetic translated-placement surrogate', reference: placementReference },
        { key: 'lowQualitySurrogate', label: 'synthetic downsample/JPEG low-quality surrogate', reference: lowQualityReference },
        { key: 'blurrySurrogate', label: 'synthetic blurred fingerprint surrogate', reference: blurryReference },
        { key: 'partialSurrogate', label: 'synthetic central partial-fingerprint surrogate', reference: partialReference }
    ];
    const results = {};
    for (const scenario of scenarios) {
        results[scenario.key] = await compare(original, scenario.reference);
        assertRealResults(results[scenario.key], scenario.label);
    }

    const identical = results.sameFilePair;
    const changed = results.mirroredInput;

    const summary = identical.matchers.map((matcher) => {
        const changedMatcher = changed.matchers.find((item) => item.algorithm === matcher.algorithm);
        if (matcher.status === 'unavailable') {
            return {
                algorithm: matcher.algorithm,
                status: 'unavailable',
                message: matcher.error,
                detail: matcher.statusMessage
            };
        }
        if (matcher.score === changedMatcher.score) {
            throw new Error(`${matcher.algorithm} returned an unchanged score for changed input.`);
        }
        return {
            algorithm: matcher.algorithm,
            identicalScore: matcher.score,
            changedScore: changedMatcher.score,
            identicalResult: matcher.result,
            changedResult: changedMatcher.result,
            identicalTimeMs: matcher.processingTimeMs,
            changedTimeMs: changedMatcher.processingTimeMs
        };
    });

    const openAfis = identical.matchers.find((item) => item.algorithm === 'OpenAFIS');
    const samplePair = openAfis.matchedMinutiae?.pairs?.[0];
    if (!samplePair || !samplePair.probe || !samplePair.reference) {
        throw new Error('OpenAFIS did not return a real matched-minutiae pair for the identical sample.');
    }

    const eventResponse = await fetch(`${SERVICE_BASE}/debug/events?limit=500`);
    const eventPayload = await eventResponse.json();
    const eventStages = new Set((eventPayload.events || []).map((event) => event.stage));
    const requiredMatcherStages = [
        'initialized',
        'probe_minutiae_loaded',
        'reference_minutiae_loaded',
        'minutiae_counts',
        'matching_executed',
        'raw_score',
        'threshold',
        'decision',
        'processing_time'
    ];
    for (const prefix of ['mcc', 'jiang']) {
        for (const stage of requiredMatcherStages) {
            const eventName = `${prefix}_${stage}`;
            if (!eventStages.has(eventName)) throw new Error(`Missing backend log event: ${eventName}`);
        }
    }

    console.log(JSON.stringify({
        verified: true,
        endpoint: `${SERVICE_BASE}/afis/compare-all`,
        scoreFusion: identical.scoreFusion,
        matcherCount: identical.matchers.length,
        matcherLogsVerified: true,
        summary,
        scenarioMatrix: scenarios.map((scenario) => ({
            key: scenario.key,
            label: scenario.label,
            results: results[scenario.key].matchers.map((matcher) => ({
                algorithm: matcher.algorithm,
                status: matcher.status,
                score: matcher.score,
                result: matcher.result,
                quality: matcher.quality || null,
                error: matcher.error || null
            }))
        })),
        datasetLimitations: [
            'The repository has one fingerprint image, so same finger scanned twice was tested only as the same-file pair.',
            'The pressure case is a labeled image-intensity surrogate, not a physical pressure rescan.',
            'Different fingers from the same person was not run because no such consented pair is present.',
            'Different participants was not run because no such consented pair is present.'
        ],
        openAfisMatchedPairCount: openAfis.matchedMinutiae.pairs.length,
        openAfisSamplePair: samplePair
    }, null, 2));
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
