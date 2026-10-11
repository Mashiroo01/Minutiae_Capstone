'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { buildPairs } = require('./calibrate-bozorth3');
const {
    buildCalibrationProfile,
    confusion,
    selectThreshold,
    summarizeScores
} = require('../matchers/calibration/calibration-statistics');
const { createIsotropicCanvas, toOpenAfisCsv } = require('../matchers/openafis/openafis-adapter');
const { runJiangMatcher, runMccMatcher } = require('../matchers/mpi-afis/mpi-afis-runner');

const ROOT = path.join(__dirname, '..');
const DATASET_ROOT = process.env.FVC_DATASET_ROOT
    || path.join(ROOT, 'temp', 'matcher-build', 'openafis', 'data', 'valid', 'fvc2004', 'DB4_B');
const SOURCEAFIS_CLASSES = path.join(ROOT, 'matchers', 'sourceafis', 'target', 'classes');
const SOURCEAFIS_LIBS = path.join(ROOT, 'matchers', 'sourceafis', 'lib', '*');
const OPENAFIS = process.env.OPENAFIS_PATH || path.join(ROOT, 'matchers', 'openafis', 'openafis-match.exe');
const MCC = process.env.MCC_EXECUTABLE || path.join(ROOT, 'matchers', 'mpi-afis', 'mcc-match.exe');
const JIANG = process.env.JIANG_EXECUTABLE || path.join(ROOT, 'matchers', 'mpi-afis', 'jiang-match.exe');
const CYGWIN_BASH = process.env.CYGWIN_BASH || 'C:\\cygwin64\\bin\\bash.exe';
const TEMP_ROOT = path.join(os.tmpdir(), 'Minutiae', 'supporting-calibration');

const MATCHERS = [
    ['SourceAFIS', 'SourceAFIS 3.18.1 clean image templates'],
    ['OpenAFIS', 'OpenAFIS with SourceAFIS 3.18.1 score-independent minutiae'],
    ['MCC', 'mpi-afis MCC with SourceAFIS 3.18.1 score-independent minutiae'],
    ['Jiang Matcher', 'mpi-afis Jiang with SourceAFIS 3.18.1 score-independent minutiae']
];

function csvEscape(value) {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, rows) {
    if (!rows.length) return fs.writeFileSync(filePath, '', 'utf8');
    const headers = Object.keys(rows[0]);
    const text = [headers.join(','), ...rows.map((row) => headers.map((key) => csvEscape(row[key])).join(','))].join('\n') + '\n';
    fs.writeFileSync(filePath, text, 'utf8');
}

function listSamples() {
    const pattern = /^(\d+)_(\d+)\.tif$/i;
    return fs.readdirSync(DATASET_ROOT)
        .map((name) => {
            const match = name.match(pattern);
            return match ? {
                key: name.replace(/\.tif$/i, ''),
                subject: match[1],
                impression: Number(match[2]),
                filePath: path.join(DATASET_ROOT, name)
            } : null;
        })
        .filter(Boolean)
        .sort((left, right) => left.subject.localeCompare(right.subject) || left.impression - right.impression);
}

function selectBalancedPairs(pairs, perLabelLimit) {
    if (!Number.isFinite(Number(perLabelLimit)) || Number(perLabelLimit) <= 0) return [...pairs];
    const limit = Math.floor(Number(perLabelLimit));
    return ['genuine', 'impostor'].flatMap((label) => {
        const labeled = pairs.filter((pair) => pair.label === label);
        if (limit >= labeled.length) return labeled;
        const subjects = [...new Set(labeled.map((pair) => String(pair.subject)))].sort();
        const groups = subjects.map((subject) => labeled.filter((pair) => String(pair.subject) === subject));
        const selected = [];
        let round = 0;
        while (selected.length < limit) {
            let added = false;
            for (const group of groups) {
                if (group[round] && selected.length < limit) {
                    selected.push(group[round]);
                    added = true;
                }
            }
            if (!added) break;
            round += 1;
        }
        return selected;
    });
}

function extractSourceAfisMinutiae(samples) {
    const run = spawnSync('java', [
        '-cp', `${SOURCEAFIS_CLASSES};${SOURCEAFIS_LIBS}`,
        'SourceAfisMinutiaeCli', '--images', '500', ...samples.map((sample) => sample.filePath)
    ], { encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (run.error || run.status !== 0) throw run.error || new Error(run.stderr || run.stdout);
    const payloads = JSON.parse(String(run.stdout).trim().split(/\r?\n/).pop());
    return new Map(samples.map((sample, index) => {
        const payload = payloads[index];
        return [sample.key, {
            width: payload.width,
            height: payload.height,
            minutiae: payload.positionsX.map((x, minutiaIndex) => ({
                x,
                y: payload.positionsY[minutiaIndex],
                angle: payload.directions[minutiaIndex],
                quality: 100,
                type: payload.types[minutiaIndex] === 'B' ? 'bifurcation' : 'ending'
            }))
        }];
    }));
}

function sourceAfisScoreMatrix(samples) {
    const run = spawnSync('java', [
        '-cp', `${SOURCEAFIS_CLASSES};${SOURCEAFIS_LIBS}`,
        'SourceAfisBatchCli', '500', ...samples.map((sample) => sample.filePath)
    ], { encoding: 'utf8', timeout: 600000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (run.error || run.status !== 0) throw run.error || new Error(run.stderr || run.stdout);
    const payload = JSON.parse(String(run.stdout).trim().split(/\r?\n/).pop());
    if (!Array.isArray(payload.scores) || payload.scores.length !== samples.length) {
        throw new Error('SourceAFIS batch scorer returned an invalid matrix.');
    }
    return payload.scores;
}

function toCygwinPath(filePath) {
    const normalized = path.resolve(filePath).replace(/\\/g, '/');
    const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
    return match ? `/cygdrive/${match[1].toLowerCase()}/${match[2]}` : normalized;
}

function quoteBash(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function runOpenAfis(probe, reference) {
    const nonce = `openafis_calibration_${crypto.randomUUID()}`;
    const probeFile = path.join(TEMP_ROOT, `${nonce}_probe.csv`);
    const referenceFile = path.join(TEMP_ROOT, `${nonce}_reference.csv`);
    const canvas = createIsotropicCanvas(probe, reference);
    try {
        fs.writeFileSync(probeFile, toOpenAfisCsv(probe.minutiae.slice(0, 100), canvas), 'utf8');
        fs.writeFileSync(referenceFile, toOpenAfisCsv(reference.minutiae.slice(0, 100), canvas), 'utf8');
        const command = [OPENAFIS, probeFile, referenceFile].map((item) => quoteBash(toCygwinPath(item))).join(' ');
        const run = spawnSync(CYGWIN_BASH, ['-lc', command], {
            encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 16 * 1024 * 1024
        });
        if (run.error || run.status !== 0) throw run.error || new Error(run.stderr || run.stdout);
        const payload = JSON.parse(String(run.stdout).trim().split(/\r?\n/).filter(Boolean).pop());
        if (!Number.isFinite(Number(payload.score))) throw new Error('OpenAFIS returned a non-finite score.');
        return Number(payload.score);
    } finally {
        for (const file of [probeFile, referenceFile]) {
            try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) { /* best effort */ }
        }
    }
}

function rowFor(pair, algorithm, score, durationMs, probeMinutiae, referenceMinutiae) {
    return {
        algorithm,
        split: Number(pair.subject) <= 105 ? 'train' : 'validation',
        label: pair.label,
        subject: pair.subject,
        probe: pair.probe.key,
        reference: pair.reference.key,
        probeMinutiae,
        referenceMinutiae,
        score,
        durationMs
    };
}

async function main() {
    for (const required of [DATASET_ROOT, OPENAFIS, MCC, JIANG, CYGWIN_BASH]) {
        if (!fs.existsSync(required)) throw new Error(`Required calibration dependency is missing: ${required}`);
    }
    fs.mkdirSync(TEMP_ROOT, { recursive: true });
    const samples = listSamples();
    if (samples.length < 40) throw new Error(`Expected a representative dataset; found only ${samples.length} images.`);
    const sampleIndex = new Map(samples.map((sample, index) => [sample.key, index]));
    const pairs = buildPairs(samples);
    const limit = Number(process.env.CALIBRATION_PAIR_LIMIT || 0);
    const selectedPairs = selectBalancedPairs(pairs, limit);
    const generatedAt = new Date().toISOString();
    const timestamp = generatedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const outputDir = path.join(ROOT, 'reports', `supporting-matchers-calibration-${timestamp}`);
    fs.mkdirSync(outputDir, { recursive: true });

    process.stderr.write(`extracting SourceAFIS minutiae for ${samples.length} images\n`);
    const templates = extractSourceAfisMinutiae(samples);
    process.stderr.write('building SourceAFIS native score matrix\n');
    const sourceScores = sourceAfisScoreMatrix(samples);
    const scoreRows = [];

    for (let index = 0; index < selectedPairs.length; index += 1) {
        const pair = selectedPairs[index];
        const probe = templates.get(pair.probe.key);
        const reference = templates.get(pair.reference.key);
        const sourceStarted = process.hrtime.bigint();
        const sourceScore = Number(sourceScores[sampleIndex.get(pair.probe.key)][sampleIndex.get(pair.reference.key)]);
        scoreRows.push(rowFor(pair, 'SourceAFIS', sourceScore, Number(process.hrtime.bigint() - sourceStarted) / 1e6, probe.minutiae.length, reference.minutiae.length));

        const openStarted = process.hrtime.bigint();
        const openScore = runOpenAfis(probe, reference);
        scoreRows.push(rowFor(pair, 'OpenAFIS', openScore, Number(process.hrtime.bigint() - openStarted) / 1e6, probe.minutiae.length, reference.minutiae.length));

        const mcc = runMccMatcher({
            probeMinutiae: probe.minutiae,
            referenceMinutiae: reference.minutiae,
            threshold: 0,
            config: { executablePath: MCC, cygwinBashPath: CYGWIN_BASH, tempDir: TEMP_ROOT }
        });
        if (mcc.status !== 'ok') throw new Error(`${pair.probe.key}/${pair.reference.key}: ${mcc.error}`);
        scoreRows.push(rowFor(pair, 'MCC', mcc.rawScore, mcc.processingTimeMs, probe.minutiae.length, reference.minutiae.length));

        const jiang = runJiangMatcher({
            probeMinutiae: probe.minutiae,
            referenceMinutiae: reference.minutiae,
            threshold: 0,
            config: { executablePath: JIANG, cygwinBashPath: CYGWIN_BASH, tempDir: TEMP_ROOT }
        });
        if (jiang.status !== 'ok') throw new Error(`${pair.probe.key}/${pair.reference.key}: ${jiang.error}`);
        scoreRows.push(rowFor(pair, 'Jiang Matcher', jiang.rawScore, jiang.processingTimeMs, probe.minutiae.length, reference.minutiae.length));

        if ((index + 1) % 10 === 0 || index + 1 === selectedPairs.length) {
            process.stderr.write(`scored ${index + 1}/${selectedPairs.length} labeled pairs across four matchers\n`);
            writeCsv(path.join(outputDir, 'scores.csv'), scoreRows);
        }
    }

    const relativeSummaryPath = path.relative(ROOT, path.join(outputDir, 'summary.json')).replace(/\\/g, '/');
    const summaries = {};
    const profiles = {};
    for (const [algorithm, matcherFeed] of MATCHERS) {
        const rows = scoreRows.filter((row) => row.algorithm === algorithm);
        const trainRows = rows.filter((row) => row.split === 'train');
        const validationRows = rows.filter((row) => row.split === 'validation');
        const selected = selectThreshold(trainRows);
        const validation = confusion(validationRows, selected.threshold);
        const genuine = summarizeScores(rows.filter((row) => row.label === 'genuine'));
        const impostor = summarizeScores(rows.filter((row) => row.label === 'impostor'));
        summaries[algorithm] = {
            chosenThreshold: selected.threshold,
            selectionRule: 'minimum training errors; then fewer false accepts; then closest FAR/FRR; midpoint between adjacent observed scores',
            train: selected,
            validation,
            all: confusion(rows, selected.threshold),
            genuine,
            impostor
        };
        profiles[algorithm] = buildCalibrationProfile({
            matcher: algorithm,
            matcherFeed,
            dataset: path.basename(DATASET_ROOT),
            report: relativeSummaryPath,
            generatedAt,
            threshold: selected.threshold,
            genuine,
            impostor,
            validation
        });
    }
    const summary = {
        generatedAt,
        dataset: DATASET_ROOT,
        groundTruth: 'FVC filename subject prefix; same prefix is genuine; adjacent subject prefix is impostor',
        samples: samples.length,
        pairs: {
            total: selectedPairs.length,
            genuine: selectedPairs.filter((pair) => pair.label === 'genuine').length,
            impostor: selectedPairs.filter((pair) => pair.label === 'impostor').length
        },
        split: 'Subjects 101-105 train; 106-110 held-out validation',
        matchers: summaries
    };
    fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(outputDir, 'match-percentage-profiles.json'), JSON.stringify({ profiles }, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ outputDir, summary, profiles }, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    listSamples,
    runOpenAfis,
    selectBalancedPairs,
    sourceAfisScoreMatrix
};
