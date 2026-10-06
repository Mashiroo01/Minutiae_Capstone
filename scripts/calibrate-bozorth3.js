'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const { runBozorth3Matcher } = require('../matchers/bozorth3/bozorth3-runner');

const ROOT = path.join(__dirname, '..');
const DATASET_ROOT = process.env.FVC_DATASET_ROOT
    || path.join(ROOT, 'temp', 'matcher-build', 'openafis', 'data', 'valid', 'fvc2004', 'DB4_B');
const SERVICE_BASE = process.env.FINGERPRINT_SERVICE_BASE || 'http://localhost:9000';
const SOURCEAFIS_CLASSES = path.join(ROOT, 'matchers', 'sourceafis', 'target', 'classes');
const SOURCEAFIS_LIBS = path.join(ROOT, 'matchers', 'sourceafis', 'lib', '*');
const BOZORTH3 = process.env.BOZORTH3_PATH || '/home/mendi/nbis/bozorth3/bin/bozorth3';
const CYGWIN_BASH = process.env.CYGWIN_BASH || 'C:\\cygwin64\\bin\\bash.exe';

function shouldIncludeLegacy(environment = process.env) {
    return /^(1|true|yes|on)$/i.test(String(environment.CALIBRATE_LEGACY || '').trim());
}

const INCLUDE_LEGACY = shouldIncludeLegacy();

async function assertLegacyServiceAvailable(serviceBase = SERVICE_BASE, fetchImpl = fetch) {
    try {
        const response = await fetchImpl(`${serviceBase}/health`, {
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
        throw new Error(
            `CALIBRATE_LEGACY=1 requires the fingerprint service. Start the fingerprint service at ${serviceBase} `
            + `or unset CALIBRATE_LEGACY to run the standalone SourceAFIS-to-Bozorth3 calibration. `
            + `Service check failed: ${error.message}`
        );
    }
}

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
            return match ? { key: name.replace(/\.tif$/i, ''), subject: match[1], impression: Number(match[2]), filePath: path.join(DATASET_ROOT, name) } : null;
        })
        .filter(Boolean)
        .sort((left, right) => left.subject.localeCompare(right.subject) || left.impression - right.impression);
}

function extractSourceAfis(samples) {
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

async function processLegacySample(sample) {
    const response = await fetch(`${SERVICE_BASE}/afis/process`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: fs.readFileSync(sample.filePath).toString('base64') })
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.error || `HTTP ${response.status}`);
    return [sample.key, {
        width: payload.inputMetrics?.normalizedWidth,
        height: payload.inputMetrics?.normalizedHeight,
        quality: payload.quality,
        minutiae: payload.minutiae
    }];
}

async function extractLegacy(samples, concurrency = 4) {
    const results = [];
    let cursor = 0;
    async function worker() {
        while (cursor < samples.length) {
            const index = cursor++;
            results[index] = await processLegacySample(samples[index]);
            if ((index + 1) % 10 === 0) process.stderr.write(`legacy extraction ${index + 1}/${samples.length}\n`);
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    return new Map(results);
}

function buildPairs(samples) {
    const subjects = [...new Set(samples.map((sample) => sample.subject))].sort();
    const bySubject = new Map(subjects.map((subject) => [subject, samples.filter((sample) => sample.subject === subject)]));
    const genuine = [];
    const impostor = [];
    for (let subjectIndex = 0; subjectIndex < subjects.length; subjectIndex++) {
        const subject = subjects[subjectIndex];
        const nextSubject = subjects[(subjectIndex + 1) % subjects.length];
        const current = bySubject.get(subject);
        const nextByImpression = new Map(bySubject.get(nextSubject).map((sample) => [sample.impression, sample]));
        for (let leftIndex = 0; leftIndex < current.length; leftIndex++) {
            for (let rightIndex = leftIndex + 1; rightIndex < current.length; rightIndex++) {
                const probe = current[leftIndex];
                const reference = current[rightIndex];
                genuine.push({ label: 'genuine', subject, probe, reference });
                impostor.push({
                    label: 'impostor',
                    subject,
                    probe,
                    reference: nextByImpression.get(reference.impression)
                });
            }
        }
    }
    return [...genuine, ...impostor];
}

function scorePair(feedName, templates, pair) {
    const probe = templates.get(pair.probe.key);
    const reference = templates.get(pair.reference.key);
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
            executablePath: BOZORTH3,
            cygwinBashPath: CYGWIN_BASH,
            minimumMinutiae: 0,
            minimumImageQuality: 0,
            borderlineBand: 0,
            maximumPoints: 200,
            borderMargin: 0,
            minimumMinutiaQuality: 0,
            duplicateRadius: 0
        }
    });
    if (result.status !== 'ok') throw new Error(`${feedName} ${pair.probe.key}/${pair.reference.key}: ${result.error}`);
    return {
        feed: feedName,
        split: Number(pair.subject) <= 105 ? 'train' : 'validation',
        label: pair.label,
        subject: pair.subject,
        probe: pair.probe.key,
        reference: pair.reference.key,
        probeMinutiae: probe.minutiae.length,
        referenceMinutiae: reference.minutiae.length,
        probeQuality: Number.isFinite(Number(probe.quality)) ? Number(probe.quality) : '',
        referenceQuality: Number.isFinite(Number(reference.quality)) ? Number(reference.quality) : '',
        score: result.rawScore,
        durationMs: result.processingTimeMs,
        probeTemplateHash: result.templates.probe.sha256,
        referenceTemplateHash: result.templates.reference.sha256
    };
}

function confusion(rows, threshold) {
    const genuine = rows.filter((row) => row.label === 'genuine');
    const impostor = rows.filter((row) => row.label === 'impostor');
    const tp = genuine.filter((row) => row.score >= threshold).length;
    const fn = genuine.length - tp;
    const fp = impostor.filter((row) => row.score >= threshold).length;
    const tn = impostor.length - fp;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const far = fp + tn ? fp / (fp + tn) : 0;
    const frr = fn + tp ? fn / (fn + tp) : 0;
    return {
        threshold, tp, fn, fp, tn,
        accuracy: (tp + tn) / Math.max(1, rows.length),
        precision,
        recall,
        f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
        far,
        frr,
        balancedAccuracy: ((tp / Math.max(1, tp + fn)) + (tn / Math.max(1, tn + fp))) / 2
    };
}

function sweep(rows) {
    const maximum = Math.max(...rows.map((row) => row.score), 1);
    return Array.from({ length: maximum + 2 }, (_, threshold) => confusion(rows, threshold));
}

function chooseThreshold(trainSweep) {
    return [...trainSweep].sort((left, right) => {
        const leftErrors = left.fp + left.fn;
        const rightErrors = right.fp + right.fn;
        return leftErrors - rightErrors || left.fp - right.fp || Math.abs(left.far - left.frr) - Math.abs(right.far - right.frr) || left.threshold - right.threshold;
    })[0];
}

function summarizeScores(rows) {
    const values = rows.map((row) => row.score).sort((a, b) => a - b);
    const percentile = (fraction) => values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))];
    return {
        count: values.length,
        minimum: values[0],
        p25: percentile(0.25),
        median: percentile(0.5),
        p75: percentile(0.75),
        p95: percentile(0.95),
        maximum: values[values.length - 1],
        mean: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100
    };
}

function percent(value) {
    return `${(value * 100).toFixed(2)}%`;
}

function createSvg(feedRows, threshold, filePath) {
    const width = 1100;
    const height = 620;
    const margin = { left: 75, right: 35, top: 55, bottom: 65 };
    const plotWidth = width - margin.left - margin.right;
    const topHeight = 270;
    const curveTop = 385;
    const curveHeight = 155;
    const maximumScore = Math.max(...feedRows.map((row) => row.score), threshold + 1);
    const binCount = 32;
    const binWidth = Math.max(1, Math.ceil((maximumScore + 1) / binCount));
    const histogram = (label) => Array.from({ length: binCount }, (_, index) => feedRows.filter((row) => row.label === label && Math.min(binCount - 1, Math.floor(row.score / binWidth)) === index).length);
    const genuine = histogram('genuine');
    const impostor = histogram('impostor');
    const maximumBin = Math.max(...genuine, ...impostor, 1);
    const scaleX = (score) => margin.left + (score / maximumScore) * plotWidth;
    const barWidth = plotWidth / binCount;
    const sweepRows = sweep(feedRows);
    const curveX = (row) => margin.left + row.far * plotWidth;
    const curveY = (row) => curveTop + curveHeight - row.recall * curveHeight;
    const roc = sweepRows.map((row) => `${curveX(row).toFixed(1)},${curveY(row).toFixed(1)}`).join(' ');
    const thresholdX = scaleX(threshold);
    const scoreTicks = Array.from({ length: 6 }, (_, index) => {
        const value = (maximumScore * index) / 5;
        const x = scaleX(value);
        return `<line x1="${x.toFixed(1)}" y1="${margin.top + topHeight}" x2="${x.toFixed(1)}" y2="${margin.top + topHeight + 6}" stroke="#778"/><text x="${x.toFixed(1)}" y="${margin.top + topHeight + 22}" text-anchor="middle" font-family="system-ui" font-size="11" fill="#475569">${Math.round(value)}</text>`;
    }).join('');
    const countTicks = Array.from({ length: 4 }, (_, index) => {
        const value = (maximumBin * index) / 3;
        const y = margin.top + topHeight - (value / maximumBin) * topHeight;
        return `<line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${width - margin.right}" y2="${y.toFixed(1)}" stroke="#dbe2ea"/><text x="${margin.left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="system-ui" font-size="11" fill="#475569">${Math.round(value)}</text>`;
    }).join('');
    const rocTicks = Array.from({ length: 6 }, (_, index) => {
        const value = index / 5;
        const x = margin.left + value * plotWidth;
        const y = curveTop + curveHeight - value * curveHeight;
        return `<line x1="${x.toFixed(1)}" y1="${curveTop}" x2="${x.toFixed(1)}" y2="${curveTop + curveHeight}" stroke="#edf0f4"/><line x1="${margin.left}" y1="${y.toFixed(1)}" x2="${width - margin.right}" y2="${y.toFixed(1)}" stroke="#edf0f4"/><text x="${x.toFixed(1)}" y="${curveTop + curveHeight + 18}" text-anchor="middle" font-family="system-ui" font-size="11" fill="#475569">${value.toFixed(1)}</text><text x="${margin.left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="system-ui" font-size="11" fill="#475569">${value.toFixed(1)}</text>`;
    }).join('');
    const bars = genuine.map((count, index) => {
        const x = margin.left + index * barWidth;
        const genuineHeight = (count / maximumBin) * topHeight;
        const impostorHeight = (impostor[index] / maximumBin) * topHeight;
        return `<rect x="${x.toFixed(1)}" y="${(margin.top + topHeight - genuineHeight).toFixed(1)}" width="${Math.max(1, barWidth - 1).toFixed(1)}" height="${genuineHeight.toFixed(1)}" fill="#2478d4" opacity="0.62"/><rect x="${x.toFixed(1)}" y="${(margin.top + topHeight - impostorHeight).toFixed(1)}" width="${Math.max(1, barWidth - 1).toFixed(1)}" height="${impostorHeight.toFixed(1)}" fill="#e05252" opacity="0.58"/>`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="#fbfcfe"/>
${countTicks}
<line x1="${margin.left}" y1="${margin.top + topHeight}" x2="${width - margin.right}" y2="${margin.top + topHeight}" stroke="#778"/>
${bars}
${scoreTicks}
<line x1="${thresholdX.toFixed(1)}" y1="${margin.top}" x2="${thresholdX.toFixed(1)}" y2="${margin.top + topHeight}" stroke="#111827" stroke-width="2" stroke-dasharray="7 5"/>
<text x="${Math.min(width - 190, thresholdX + 8).toFixed(1)}" y="${margin.top + 18}" font-family="system-ui" font-size="13" fill="#111827">chosen threshold ${threshold}</text>
<rect x="${margin.left}" y="345" width="14" height="14" fill="#2478d4" opacity="0.62"/><text x="${margin.left + 20}" y="357" font-family="system-ui" font-size="13">genuine</text>
<rect x="${margin.left + 105}" y="345" width="14" height="14" fill="#e05252" opacity="0.58"/><text x="${margin.left + 125}" y="357" font-family="system-ui" font-size="13">impostor</text>
<text x="${width / 2}" y="375" text-anchor="middle" font-family="system-ui" font-size="13">Native Bozorth3 score (higher means more similar)</text>
${rocTicks}
<line x1="${margin.left}" y1="${curveTop + curveHeight}" x2="${width - margin.right}" y2="${curveTop + curveHeight}" stroke="#778"/>
<line x1="${margin.left}" y1="${curveTop}" x2="${margin.left}" y2="${curveTop + curveHeight}" stroke="#778"/>
<polyline points="${roc}" fill="none" stroke="#6f42c1" stroke-width="3"/>
<text x="${margin.left}" y="${curveTop - 12}" font-family="system-ui" font-size="15" font-weight="650">ROC (all labeled pairs)</text>
<text x="${width / 2}" y="${height - 22}" text-anchor="middle" font-family="system-ui" font-size="13">False accept rate</text>
<text x="22" y="${curveTop + curveHeight / 2}" transform="rotate(-90 22 ${curveTop + curveHeight / 2})" text-anchor="middle" font-family="system-ui" font-size="13">True accept rate</text>
<text x="${margin.left}" y="30" font-family="system-ui" font-size="20" font-weight="700" fill="#172033">Bozorth3 score distributions and ROC — SourceAFIS minutiae</text>
</svg>`;
    fs.writeFileSync(filePath, svg, 'utf8');
}

async function main() {
    const samples = listSamples();
    if (!samples.length) throw new Error(`No FVC TIFF samples found at ${DATASET_ROOT}`);
    const pairs = buildPairs(samples);
    process.stderr.write(`dataset=${path.basename(DATASET_ROOT)} samples=${samples.length} pairs=${pairs.length}\n`);
    const feeds = [['sourceafis', extractSourceAfis(samples)]];
    if (INCLUDE_LEGACY) {
        await assertLegacyServiceAvailable();
        feeds.push(['legacy', await extractLegacy(samples)]);
    }

    const scoreRows = [];
    for (const [feedName, templates] of feeds) {
        process.stderr.write(`scoring ${feedName} ${pairs.length} pairs\n`);
        for (let index = 0; index < pairs.length; index++) {
            scoreRows.push(scorePair(feedName, templates, pairs[index]));
            if ((index + 1) % 50 === 0) process.stderr.write(`${feedName} ${index + 1}/${pairs.length}\n`);
        }
    }

    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const outputDir = path.join(ROOT, 'reports', `bozorth3-calibration-${timestamp}`);
    fs.mkdirSync(outputDir, { recursive: true });
    writeCsv(path.join(outputDir, 'scores.csv'), scoreRows);

    const reportFeeds = {};
    const thresholdRows = [];
    for (const [feedName] of feeds) {
        const rows = scoreRows.filter((row) => row.feed === feedName);
        const trainRows = rows.filter((row) => row.split === 'train');
        const validationRows = rows.filter((row) => row.split === 'validation');
        const chosen = chooseThreshold(sweep(trainRows));
        const allSweep = sweep(rows);
        const validation = confusion(validationRows, chosen.threshold);
        const all = confusion(rows, chosen.threshold);
        thresholdRows.push(...allSweep.map((row) => ({ feed: feedName, ...row })));
        reportFeeds[feedName] = {
            chosenThreshold: chosen.threshold,
            selectionRule: 'minimum train errors; then fewer false accepts; then closest FAR/FRR; then lowest threshold on an equivalent plateau',
            train: chosen,
            validation,
            all,
            genuine: summarizeScores(rows.filter((row) => row.label === 'genuine')),
            impostor: summarizeScores(rows.filter((row) => row.label === 'impostor'))
        };
    }
    writeCsv(path.join(outputDir, 'threshold-sweep.csv'), thresholdRows);
    const chartSvgPath = path.join(outputDir, 'score-distributions-and-roc.svg');
    createSvg(scoreRows.filter((row) => row.feed === 'sourceafis'), reportFeeds.sourceafis.chosenThreshold, chartSvgPath);
    await sharp(chartSvgPath).png().toFile(path.join(outputDir, 'score-distributions-and-roc.png'));

    const summary = {
        generatedAt: new Date().toISOString(),
        dataset: DATASET_ROOT,
        groundTruth: 'FVC filename subject prefix; impressions sharing a prefix are genuine; adjacent subject prefixes are impostors',
        samples: samples.length,
        subjects: new Set(samples.map((sample) => sample.subject)).size,
        pairs: {
            total: pairs.length,
            genuine: pairs.filter((pair) => pair.label === 'genuine').length,
            impostor: pairs.filter((pair) => pair.label === 'impostor').length
        },
        split: 'Subjects 101-105 train; 106-110 held-out validation',
        feeds: reportFeeds
    };
    fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
    const section = (name, result) => `### ${name}\n\n- Chosen threshold: **${result.chosenThreshold}**\n- Train: FAR ${percent(result.train.far)}, FRR ${percent(result.train.frr)}, F1 ${percent(result.train.f1)} (${result.train.fp} FP, ${result.train.fn} FN)\n- Held-out validation: FAR ${percent(result.validation.far)}, FRR ${percent(result.validation.frr)}, F1 ${percent(result.validation.f1)} (${result.validation.fp} FP, ${result.validation.fn} FN)\n- All pairs: FAR ${percent(result.all.far)}, FRR ${percent(result.all.frr)}, accuracy ${percent(result.all.accuracy)}, precision ${percent(result.all.precision)}, recall ${percent(result.all.recall)}, F1 ${percent(result.all.f1)}\n- Genuine scores: ${JSON.stringify(result.genuine)}\n- Impostor scores: ${JSON.stringify(result.impostor)}\n`;
    const markdown = `# Bozorth3 calibration report\n\nGenerated ${summary.generatedAt}.\n\n## Ground truth and protocol\n\n- Dataset: \`${DATASET_ROOT}\`\n- ${summary.samples} images, ${summary.subjects} FVC subjects, ${summary.pairs.genuine} genuine and ${summary.pairs.impostor} balanced impostor pairs.\n- Labels come only from the FVC filename subject prefix, never from matcher output or application criminal IDs.\n- ${summary.split}.\n- Native scores are preserved. Higher scores mean more similar.\n- Threshold selection: minimum training errors, then fewer false accepts, then closest FAR/FRR, then the lowest threshold on an equivalent plateau.\n\n## Results\n\n${Object.entries(reportFeeds).map(([name, result]) => section(name === 'sourceafis' ? 'After: SourceAFIS minutiae → Bozorth3' : 'Before: legacy application minutiae → Bozorth3', result)).join('\n')}\n## Artifacts\n\n- \`scores.csv\`: every labeled comparison and native score.\n- \`threshold-sweep.csv\`: confusion matrix and metrics for every integer threshold.\n- \`score-distributions-and-roc.svg\`: genuine/impostor score distributions and ROC curve for the selected feed.\n- \`summary.json\`: machine-readable protocol and metrics.\n`;
    fs.writeFileSync(path.join(outputDir, 'REPORT.md'), markdown, 'utf8');
    console.log(JSON.stringify({ outputDir, summary }, null, 2));
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    assertLegacyServiceAvailable,
    buildPairs,
    chooseThreshold,
    confusion,
    createSvg,
    shouldIncludeLegacy,
    sweep
};
