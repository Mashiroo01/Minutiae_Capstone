'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runMccMatcher, runJiangMatcher } = require('../matchers/mpi-afis/mpi-afis-runner');

const SERVICE_BASE = process.env.FINGERPRINT_SERVICE_BASE || 'http://localhost:9000';
const ROOT = path.join(__dirname, '..');
const DATASET_ROOT = process.env.FVC_DATASET_ROOT
    || path.join(ROOT, 'temp', 'matcher-build', 'openafis', 'data', 'valid', 'fvc2004', 'DB4_B');
const OPENAFIS = path.join(ROOT, 'matchers', 'openafis', 'openafis-match.exe');
const BOZORTH3 = process.env.BOZORTH3_PATH || '/home/mendi/nbis/bozorth3/bin/bozorth3';
const MCC = path.join(ROOT, 'matchers', 'mpi-afis', 'mcc-match.exe');
const JIANG = path.join(ROOT, 'matchers', 'mpi-afis', 'jiang-match.exe');
const CYGWIN_BASH = process.env.CYGWIN_BASH || 'C:\\cygwin64\\bin\\bash.exe';
const SOURCEAFIS_CLASSES = path.join(ROOT, 'matchers', 'sourceafis', 'target', 'classes');
const SOURCEAFIS_LIBS = path.join(ROOT, 'matchers', 'sourceafis', 'lib', '*');

function toCygwinPath(filePath) {
    const normalized = path.resolve(filePath).replace(/\\/g, '/');
    const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
    return match ? `/cygdrive/${match[1].toLowerCase()}/${match[2]}` : normalized;
}

async function processImage(filePath) {
    const response = await fetch(`${SERVICE_BASE}/afis/process`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: fs.readFileSync(filePath).toString('base64') })
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error || `HTTP ${response.status}`);
    return payload;
}

function extractSourceAfisMinutiae(filePath) {
    return extractSourceAfis(['SourceAfisMinutiaeCli', filePath, '500']);
}

function extractSourceAfisTemplateMinutiae(filePath) {
    return extractSourceAfis(['SourceAfisMinutiaeCli', '--template', filePath]);
}

function extractSourceAfisImages(filePaths) {
    const run = spawnSync('java', [
        '-cp', `${SOURCEAFIS_CLASSES};${SOURCEAFIS_LIBS}`,
        'SourceAfisMinutiaeCli', '--images', '500', ...filePaths
    ], { encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (run.error || run.status !== 0) throw run.error || new Error(run.stderr || run.stdout);
    return JSON.parse(String(run.stdout).trim().split(/\r?\n/).pop()).map((payload) => ({
        width: payload.width,
        height: payload.height,
        minutiae: payload.positionsX.map((x, index) => ({
            x,
            y: payload.positionsY[index],
            angle: payload.directions[index],
            quality: 100,
            type: payload.types[index] === 'B' ? 'bifurcation' : 'ending'
        }))
    }));
}

function extractSourceAfis(argumentsList) {
    const run = spawnSync('java', [
        '-cp', `${SOURCEAFIS_CLASSES};${SOURCEAFIS_LIBS}`,
        ...argumentsList
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (run.error || run.status !== 0) throw run.error || new Error(run.stderr || run.stdout);
    const payload = JSON.parse(String(run.stdout).trim().split(/\r?\n/).pop());
    return {
        width: payload.width,
        height: payload.height,
        minutiae: payload.positionsX.map((x, index) => ({
            x,
            y: payload.positionsY[index],
            angle: payload.directions[index],
            quality: 100,
            type: payload.types[index] === 'B' ? 'bifurcation' : 'ending'
        }))
    };
}

function transformAngles(minutiae, angleVariant) {
    return minutiae.map((minutia) => {
        const angle = Number(minutia.angle);
        if (angleVariant === 'negate') return { ...minutia, angle: -angle };
        if (angleVariant === 'plusPi') return { ...minutia, angle: angle + Math.PI };
        if (angleVariant === 'negatePlusPi') return { ...minutia, angle: -angle + Math.PI };
        return { ...minutia };
    });
}

function toOpenAfisCsv(minutiae, width, height) {
    return [
        `${width},${height}`,
        ...minutiae.map((minutia) => `${minutia.type === 'bifurcation' ? 2 : 1},${Math.round(minutia.x)},${Math.round(minutia.y)},${minutia.angle}`)
    ].join('\n') + '\n';
}

function runOpenAfis(probe, reference, width, height, tempDir) {
    const probePath = path.join(tempDir, 'probe.csv');
    const referencePath = path.join(tempDir, 'reference.csv');
    fs.writeFileSync(probePath, toOpenAfisCsv(probe, width, height), 'utf8');
    fs.writeFileSync(referencePath, toOpenAfisCsv(reference, width, height), 'utf8');
    const command = `"${toCygwinPath(OPENAFIS)}" "${toCygwinPath(probePath)}" "${toCygwinPath(referencePath)}"`;
    const run = spawnSync(CYGWIN_BASH, ['-lc', command], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (run.error || run.status !== 0) {
        return { score: null, error: String(run.error?.message || run.stderr || run.stdout || `exit ${run.status}`).trim() };
    }
    const line = String(run.stdout).trim().split(/\r?\n/).pop();
    return { score: Number(JSON.parse(line).score), error: null };
}

function toBozorthXyt(minutiae) {
    return minutiae.map((minutia) => {
        const theta = Math.round(((Number(minutia.angle) * 180) / Math.PI + 360) % 360);
        return `${Math.round(Number(minutia.x))} ${Math.round(Number(minutia.y))} ${theta}`;
    }).join('\n') + '\n';
}

function runBozorth3(probe, reference, tempDir) {
    const probePath = path.join(tempDir, 'bozorth-probe.xyt');
    const referencePath = path.join(tempDir, 'bozorth-reference.xyt');
    fs.writeFileSync(probePath, toBozorthXyt(probe), 'utf8');
    fs.writeFileSync(referencePath, toBozorthXyt(reference), 'utf8');
    const command = `${BOZORTH3} "${toCygwinPath(probePath)}" "${toCygwinPath(referencePath)}"`;
    const run = spawnSync(CYGWIN_BASH, ['-lc', command], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const output = `${run.stdout || ''}\n${run.stderr || ''}`.trim();
    const scoreLine = output.split(/\r?\n/).find((line) => /^\s*\d+\s*$/.test(line));
    if (run.error || run.status !== 0 || !scoreLine) {
        return { score: null, error: String(run.error?.message || output || `exit ${run.status}`).trim() };
    }
    return { score: Number(scoreLine.trim()), error: null };
}

function nativeScores(probe, reference, width, height, tempDir) {
    const config = { cygwinBashPath: CYGWIN_BASH };
    const bozorthResult = runBozorth3(probe, reference, tempDir);
    const openafisResult = runOpenAfis(probe, reference, width, height, tempDir);
    const mcc = runMccMatcher({ probeMinutiae: probe, referenceMinutiae: reference, threshold: 0.4, config: { ...config, executablePath: MCC } });
    const jiang = runJiangMatcher({ probeMinutiae: probe, referenceMinutiae: reference, threshold: 0.4, config: { ...config, executablePath: JIANG } });
    return {
        bozorth3: bozorthResult.score,
        bozorth3Error: bozorthResult.error,
        openafis: openafisResult.score,
        openafisError: openafisResult.error,
        mcc: mcc.rawScore,
        jiang: jiang.rawScore
    };
}

function bestThreshold(genuineScores, impostorScores) {
    const candidates = [...new Set([...genuineScores, ...impostorScores])].sort((a, b) => a - b);
    const thresholds = [0, ...candidates.map((value, index) => index + 1 < candidates.length ? (value + candidates[index + 1]) / 2 : value)];
    return thresholds.map((threshold) => {
        const falseRejects = genuineScores.filter((score) => score < threshold).length;
        const falseAccepts = impostorScores.filter((score) => score >= threshold).length;
        return { threshold, falseRejects, falseAccepts, errors: falseRejects + falseAccepts };
    }).sort((left, right) => left.errors - right.errors || left.falseAccepts - right.falseAccepts || right.threshold - left.threshold)[0];
}

function calibrateOfficialIso() {
    const identities = Array.from({ length: 10 }, (_, index) => String(101 + index));
    const cache = new Map();
    const useImages = String(process.env.CALIBRATION_FEED || '').toLowerCase() === 'image';
    if (useImages) {
        const keys = identities.flatMap((identity) => [`${identity}_1`, `${identity}_2`]);
        const extracted = extractSourceAfisImages(keys.map((key) => path.join(DATASET_ROOT, `${key}.tif`)));
        keys.forEach((key, index) => cache.set(key, extracted[index]));
    }
    const load = (identity, impression) => {
        const key = `${identity}_${impression}`;
        if (!cache.has(key)) {
            const extension = useImages ? 'tif' : 'iso';
            const loaded = useImages
                ? extractSourceAfisImages([path.join(DATASET_ROOT, `${key}.${extension}`)])[0]
                : extractSourceAfisTemplateMinutiae(path.join(DATASET_ROOT, `${key}.${extension}`));
            cache.set(key, loaded);
        }
        return cache.get(key);
    };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minutiae-calibrate-'));
    const rows = [];
    try {
        for (let index = 0; index < identities.length; index++) {
            const identity = identities[index];
            const nextIdentity = identities[(index + 1) % identities.length];
            const probe = load(identity, '1');
            const genuine = load(identity, '2');
            const impostor = load(nextIdentity, '1');
            rows.push({
                identity,
                genuine: nativeScores(probe.minutiae, genuine.minutiae, probe.width, probe.height, tempDir),
                impostor: nativeScores(probe.minutiae, impostor.minutiae, probe.width, probe.height, tempDir)
            });
        }
    } finally {
        for (const name of ['probe.csv', 'reference.csv', 'bozorth-probe.xyt', 'bozorth-reference.xyt']) {
            const filePath = path.join(tempDir, name);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        fs.rmdirSync(tempDir);
    }
    const calibration = {};
    for (const matcher of ['bozorth3', 'openafis', 'mcc', 'jiang']) {
        const genuineScores = rows.map((row) => row.genuine[matcher]).filter(Number.isFinite);
        const impostorScores = rows.map((row) => row.impostor[matcher]).filter(Number.isFinite);
        calibration[matcher] = {
            genuineScores,
            impostorScores,
            minimumGenuine: Math.min(...genuineScores),
            maximumImpostor: Math.max(...impostorScores),
            bestObservedThreshold: bestThreshold(genuineScores, impostorScores)
        };
    }
    console.log(JSON.stringify({ dataset: path.basename(DATASET_ROOT), feed: useImages ? 'SourceAFIS image extraction' : 'official ISO templates', identities: identities.length, rows, calibration }, null, 2));
}

async function main() {
    if (/^(1|true|yes)$/i.test(process.env.CALIBRATE_OFFICIAL_ISO || '')) {
        calibrateOfficialIso();
        return;
    }
    const probe = await processImage(path.join(DATASET_ROOT, '101_1.tif'));
    const genuine = await processImage(path.join(DATASET_ROOT, '101_2.tif'));
    const impostor = await processImage(path.join(DATASET_ROOT, '102_1.tif'));
    const sourceProbe = extractSourceAfisMinutiae(path.join(DATASET_ROOT, '101_1.tif'));
    const sourceGenuine = extractSourceAfisMinutiae(path.join(DATASET_ROOT, '101_2.tif'));
    const sourceImpostor = extractSourceAfisMinutiae(path.join(DATASET_ROOT, '102_1.tif'));
    const isoProbePath = path.join(DATASET_ROOT, '101_1.iso');
    const officialIsoAvailable = fs.existsSync(isoProbePath);
    const isoProbe = officialIsoAvailable ? extractSourceAfisTemplateMinutiae(isoProbePath) : null;
    const isoGenuine = officialIsoAvailable ? extractSourceAfisTemplateMinutiae(path.join(DATASET_ROOT, '101_2.iso')) : null;
    const isoImpostor = officialIsoAvailable ? extractSourceAfisTemplateMinutiae(path.join(DATASET_ROOT, '102_1.iso')) : null;
    const feeds = {
        academicMinutiae: { probe: probe.academicMinutiae, genuine: genuine.academicMinutiae, impostor: impostor.academicMinutiae, width: probe.inputMetrics.normalizedWidth, height: probe.inputMetrics.normalizedHeight },
        minutiae: { probe: probe.minutiae, genuine: genuine.minutiae, impostor: impostor.minutiae, width: probe.inputMetrics.normalizedWidth, height: probe.inputMetrics.normalizedHeight },
        sourceAfis: { probe: sourceProbe.minutiae, genuine: sourceGenuine.minutiae, impostor: sourceImpostor.minutiae, width: sourceProbe.width, height: sourceProbe.height },
        ...(officialIsoAvailable ? { officialIso: { probe: isoProbe.minutiae, genuine: isoGenuine.minutiae, impostor: isoImpostor.minutiae, width: isoProbe.width, height: isoProbe.height } } : {})
    };
    const selectedFeeds = new Set(String(process.env.DIAG_FEEDS || 'academicMinutiae,minutiae,sourceAfis').split(',').map((item) => item.trim()).filter(Boolean));
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minutiae-diagnose-'));
    const rows = [];
    try {
        for (const feed of Object.keys(feeds).filter((name) => selectedFeeds.has(name))) {
            const feedData = feeds[feed];
            for (const count of [20, 40, 60, 80, 100]) {
                for (const angleVariant of ['identity', 'negate', 'plusPi', 'negatePlusPi']) {
                    const probeMinutiae = transformAngles(feedData.probe.slice(0, count), angleVariant);
                    const genuineMinutiae = transformAngles(feedData.genuine.slice(0, count), angleVariant);
                    const impostorMinutiae = transformAngles(feedData.impostor.slice(0, count), angleVariant);
                    rows.push({
                        feed,
                        count,
                        angleVariant,
                        genuine: nativeScores(probeMinutiae, genuineMinutiae, feedData.width, feedData.height, tempDir),
                        impostor: nativeScores(probeMinutiae, impostorMinutiae, feedData.width, feedData.height, tempDir)
                    });
                }
            }
        }
    } finally {
        for (const name of ['probe.csv', 'reference.csv', 'bozorth-probe.xyt', 'bozorth-reference.xyt']) {
            const filePath = path.join(tempDir, name);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
        fs.rmdirSync(tempDir);
    }
    rows.sort((left, right) => {
        const leftGap = ((left.genuine.openafis || 0) - (left.impostor.openafis || 0)) + ((left.genuine.mcc - left.impostor.mcc) * 100) + ((left.genuine.jiang - left.impostor.jiang) * 100);
        const rightGap = ((right.genuine.openafis || 0) - (right.impostor.openafis || 0)) + ((right.genuine.mcc - right.impostor.mcc) * 100) + ((right.genuine.jiang - right.impostor.jiang) * 100);
        return rightGap - leftGap;
    });
    console.log(JSON.stringify({ probeCounts: { academic: probe.academicMinutiae.length, legacy: probe.minutiae.length, sourceAfis: sourceProbe.minutiae.length, officialIso: isoProbe?.minutiae.length || null }, rows }, null, 2));
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
