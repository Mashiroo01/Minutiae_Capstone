'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sharp = require('sharp');
const { runBozorth3Matcher } = require('../matchers/bozorth3/bozorth3-runner');
const { runMindtctExtractor } = require('../matchers/mindtct/mindtct-runner');

const ROOT = path.join(__dirname, '..');
const DATASET_ROOT = process.env.FVC_DATASET_ROOT
    || path.join(ROOT, 'temp', 'matcher-build', 'openafis', 'data', 'valid', 'fvc2004', 'DB4_B');
const PORT = Number(process.env.MODIFIED_BOZORTH3_VERIFY_PORT || 19001);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const EXTRACTOR = process.env.MODIFIED_BOZORTH3_VERIFY_EXTRACTOR || 'service';
const MINDTCT_IMAGE_FIELD = process.env.MODIFIED_BOZORTH3_VERIFY_MINDTCT_IMAGE || 'gaborEnhancedImage';
const SKELETON_RADIUS = process.env.MODIFIED_BOZORTH3_VERIFY_SKELETON_RADIUS === undefined
    ? null
    : Number(process.env.MODIFIED_BOZORTH3_VERIFY_SKELETON_RADIUS);

function agreesWithSkeleton(minutia, skeleton, width, height, radius) {
    const centerX = Math.round(minutia.x);
    const centerY = Math.round(height - minutia.y);
    for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
            const x = centerX + ox;
            const y = centerY + oy;
            if (x >= 0 && y >= 0 && x < width && y < height && skeleton[y * width + x] < 128) return true;
        }
    }
    return false;
}

async function waitForHealth(child) {
    let lastError;
    for (let attempt = 0; attempt < 40; attempt++) {
        if (child.exitCode != null) throw new Error(`Fingerprint service exited with code ${child.exitCode}.`);
        try {
            const response = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1000) });
            if (response.ok) return;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Fingerprint service did not become healthy: ${lastError?.message || 'timeout'}`);
}

async function extract(key) {
    const filePath = path.join(DATASET_ROOT, `${key}.tif`);
    const response = await fetch(`${BASE_URL}/afis/process`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            image: fs.readFileSync(filePath).toString('base64'),
            modifiedBozorth3: EXTRACTOR === 'service'
        }),
        signal: AbortSignal.timeout(30000)
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error || `HTTP ${response.status}`);
    let minutiae = payload.minutiae;
    if (EXTRACTOR === 'mindtct') {
        const enhanced = await sharp(Buffer.from(payload[MINDTCT_IMAGE_FIELD], 'base64'))
            .greyscale()
            .raw()
            .toBuffer({ resolveWithObject: true });
        minutiae = runMindtctExtractor({
            pixels: enhanced.data,
            width: enhanced.info.width,
            height: enhanced.info.height,
            ppi: 500
        }).minutiae;
        if (Number.isInteger(SKELETON_RADIUS) && SKELETON_RADIUS >= 0) {
            const skeleton = await sharp(Buffer.from(payload.thinnedImage, 'base64'))
                .greyscale()
                .raw()
                .toBuffer({ resolveWithObject: true });
            minutiae = minutiae.filter((item) => agreesWithSkeleton(
                item,
                skeleton.data,
                skeleton.info.width,
                skeleton.info.height,
                SKELETON_RADIUS
            ));
        }
    }
    return {
        key,
        minutiae,
        quality: payload.quality,
        width: payload.inputMetrics?.normalizedWidth || 500,
        height: payload.inputMetrics?.normalizedHeight || 500
    };
}

function score(probe, reference) {
    const result = runBozorth3Matcher({
        probeMinutiae: probe.minutiae,
        referenceMinutiae: reference.minutiae,
        probeWidth: probe.width,
        probeHeight: probe.height,
        referenceWidth: reference.width,
        referenceHeight: reference.height,
        probeQuality: probe.quality,
        referenceQuality: reference.quality,
        threshold: 0,
        config: {
            executablePath: process.env.BOZORTH3_PATH || '/home/mendi/nbis/bozorth3/bin/bozorth3',
            cygwinBashPath: process.env.CYGWIN_BASH || 'C:\\cygwin64\\bin\\bash.exe',
            minimumMinutiae: 0,
            minimumImageQuality: 0,
            borderlineBand: 0,
            maximumPoints: 200,
            borderMargin: 0,
            minimumMinutiaQuality: 0,
            duplicateRadius: 0
        }
    });
    if (result.status !== 'ok') throw new Error(result.error || 'Native Bozorth3 failed.');
    return result.rawScore;
}

async function main() {
    const child = spawn(process.execPath, ['fingerprint-service.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk).slice(-4000); });
    try {
        await waitForHealth(child);
        const [probe, genuine, impostor] = await Promise.all([
            extract('101_1'),
            extract('101_2'),
            extract('102_2')
        ]);
        const genuineScore = score(probe, genuine);
        const impostorScore = score(probe, impostor);
        const result = {
            extractor: EXTRACTOR,
            extractorImage: EXTRACTOR === 'mindtct' ? MINDTCT_IMAGE_FIELD : null,
            skeletonRadius: SKELETON_RADIUS,
            minutiae: Object.fromEntries([probe, genuine, impostor].map((item) => [item.key, item.minutiae.length])),
            minutiaeTypes: Object.fromEntries([probe, genuine, impostor].map((item) => [item.key, {
                endings: item.minutiae.filter((point) => point.type === 'ending').length,
                bifurcations: item.minutiae.filter((point) => point.type === 'bifurcation').length,
                uniqueDirections: new Set(item.minutiae.map((point) => Math.round(Number(point.angle) * 1000) / 1000)).size
            }])),
            genuine: { pair: '101_1/101_2', score: genuineScore },
            impostor: { pair: '101_1/102_2', score: impostorScore },
            separation: genuineScore - impostorScore
        };
        console.log(JSON.stringify(result, null, 2));
        assert.ok(
            [probe, genuine, impostor].some((item) => item.minutiae.length < 140),
            'False-minutiae regression: every template saturated the 140-point cap.'
        );
        assert.ok(
            genuineScore - impostorScore >= 20,
            `Score-separation regression: genuine/impostor margin was ${genuineScore - impostorScore}, expected at least 20.`
        );
    } finally {
        if (child.exitCode == null) child.kill();
    }
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
