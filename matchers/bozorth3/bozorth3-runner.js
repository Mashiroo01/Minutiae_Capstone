'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function elapsedMilliseconds(startedAt) {
    return Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 100) / 100;
}

function toCygwinPath(filePath) {
    if (String(filePath).startsWith('/')) return String(filePath).replace(/\\/g, '/');
    const normalized = path.resolve(filePath).replace(/\\/g, '/');
    const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
    return match ? `/cygdrive/${match[1].toLowerCase()}/${match[2]}` : normalized;
}

function quoteBash(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function prepareBozorthMinutiae(minutiae, options = {}) {
    const source = Array.isArray(minutiae) ? minutiae : [];
    const width = Number(options.width);
    const height = Number(options.height);
    const hasBounds = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
    const borderMargin = Math.max(0, Number(options.borderMargin) || 0);
    const minimumQuality = clamp(Number.isFinite(Number(options.minimumQuality)) ? Number(options.minimumQuality) : 0, 0, 100);
    const duplicateRadius = Math.max(0, Number(options.duplicateRadius) || 0);
    const maximumPoints = Math.max(1, Math.floor(Number(options.maximumPoints) || 200));

    const finite = source
        .map((item, sourceIndex) => ({
            ...item,
            x: Number(item?.x),
            y: Number(item?.y),
            angle: Number(item?.angle),
            quality: Number.isFinite(Number(item?.quality)) ? clamp(Number(item.quality), 0, 100) : 100,
            sourceIndex
        }))
        .filter((item) => [item.x, item.y, item.angle].every(Number.isFinite));
    const insideRoi = finite.filter((item) => !hasBounds || (
        item.x >= borderMargin
        && item.y >= borderMargin
        && item.x < width - borderMargin
        && item.y < height - borderMargin
    ));
    const qualityAccepted = insideRoi
        .filter((item) => item.quality >= minimumQuality)
        .sort((left, right) => right.quality - left.quality || left.sourceIndex - right.sourceIndex);
    const deduplicated = [];
    const duplicateRadiusSquared = duplicateRadius * duplicateRadius;
    for (const candidate of qualityAccepted) {
        if (deduplicated.some((existing) => {
            const dx = existing.x - candidate.x;
            const dy = existing.y - candidate.y;
            return dx * dx + dy * dy <= duplicateRadiusSquared;
        })) continue;
        deduplicated.push(candidate);
    }
    const used = deduplicated.slice(0, maximumPoints).map(({ sourceIndex, ...item }) => item);

    return {
        minutiae: used,
        counts: {
            extracted: source.length,
            finite: finite.length,
            insideRoi: insideRoi.length,
            qualityAccepted: qualityAccepted.length,
            deduplicated: deduplicated.length,
            used: used.length
        },
        rules: {
            width: hasBounds ? width : null,
            height: hasBounds ? height : null,
            borderMargin,
            minimumQuality,
            duplicateRadius,
            maximumPoints
        }
    };
}

function toBozorthXyt(minutiae) {
    if (!Array.isArray(minutiae)) throw new Error('Minutiae must be an array.');
    return minutiae.map((minutia, index) => {
        const x = Number(minutia?.x);
        const y = Number(minutia?.y);
        const angle = Number(minutia?.angle);
        if (![x, y, angle].every(Number.isFinite)) {
            throw new Error(`Invalid minutia at index ${index}; finite x, y, and angle values are required.`);
        }
        const clockwiseDegrees = Math.round(((((angle * 180) / Math.PI) % 360) + 360) % 360) % 360;
        return `${Math.round(x)} ${Math.round(y)} ${clockwiseDegrees}`;
    }).join('\n') + '\n';
}

function classifyBozorthDecision({ score, threshold, borderlineBand = 3, qualityPassed }) {
    if (!qualityPassed) {
        return {
            result: 'INSUFFICIENT QUALITY',
            isMatch: null,
            decisionState: 'insufficient-quality',
            reviewRecommended: false
        };
    }
    const distance = Number(score) - Number(threshold);
    if (distance >= 0) {
        return {
            result: 'MATCH',
            isMatch: true,
            decisionState: 'match',
            reviewRecommended: false
        };
    }
    if (distance >= -Math.max(0, Number(borderlineBand) || 0)) {
        return {
            result: 'BORDERLINE',
            isMatch: null,
            decisionState: 'borderline-no-match',
            reviewRecommended: true
        };
    }
    return {
        result: 'NO MATCH',
        isMatch: false,
        decisionState: 'no-match',
        reviewRecommended: false
    };
}

function parseScore(stdout, stderr) {
    const output = `${stdout || ''}\n${stderr || ''}`.trim();
    const scoreLine = output.split(/\r?\n/).find((line) => /^\s*\d+\s*$/.test(line));
    if (!scoreLine) throw new Error('Bozorth3 returned no numeric native score.');
    return Number(scoreLine.trim());
}

function templateDiagnostics(filePath, content) {
    return {
        filePath,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        lineCount: content.trim() ? content.trim().split(/\r?\n/).length : 0,
        sample: content.trim().split(/\r?\n/).slice(0, 8),
        deletedAfterRun: true
    };
}

function defaultExecute({ executablePath, cygwinBashPath, probePath, referencePath, timeoutMs }) {
    if (cygwinBashPath && fs.existsSync(cygwinBashPath)) {
        const command = [executablePath, probePath, referencePath]
            .map((value) => quoteBash(toCygwinPath(value)))
            .join(' ');
        const run = spawnSync(cygwinBashPath, ['-lc', command], {
            encoding: 'utf8',
            timeout: timeoutMs,
            windowsHide: true
        });
        return { ...run, command: `${cygwinBashPath} -lc ${command}` };
    }
    const run = spawnSync(executablePath, [probePath, referencePath], {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true
    });
    return { ...run, command: `${executablePath} "${probePath}" "${referencePath}"` };
}

function runBozorth3Matcher(options) {
    const startedAt = process.hrtime.bigint();
    const config = {
        executablePath: '',
        cygwinBashPath: '',
        tempDir: path.join(os.tmpdir(), 'Minutiae', 'bozorth3'),
        timeoutMs: 10000,
        minimumMinutiae: 18,
        minimumImageQuality: 35,
        borderlineBand: 3,
        borderMargin: 0,
        minimumMinutiaQuality: 0,
        duplicateRadius: 0,
        maximumPoints: 200,
        ...(options.config || {})
    };
    const threshold = Number(options.threshold);
    const execute = typeof options.execute === 'function' ? options.execute : defaultExecute;
    const log = typeof options.log === 'function' ? options.log : () => {};
    const probePrepared = prepareBozorthMinutiae(options.probeMinutiae, {
        width: options.probeWidth,
        height: options.probeHeight,
        borderMargin: config.borderMargin,
        minimumQuality: config.minimumMinutiaQuality,
        duplicateRadius: config.duplicateRadius,
        maximumPoints: config.maximumPoints
    });
    const referencePrepared = prepareBozorthMinutiae(options.referenceMinutiae, {
        width: options.referenceWidth,
        height: options.referenceHeight,
        borderMargin: config.borderMargin,
        minimumQuality: config.minimumMinutiaQuality,
        duplicateRadius: config.duplicateRadius,
        maximumPoints: config.maximumPoints
    });
    const probeQuality = Number(options.probeQuality);
    const referenceQuality = Number(options.referenceQuality);
    const minimumImageQuality = Number(config.minimumImageQuality);
    const countPassed = probePrepared.counts.used >= config.minimumMinutiae
        && referencePrepared.counts.used >= config.minimumMinutiae;
    const imageQualityPassed = (!Number.isFinite(probeQuality) || probeQuality >= minimumImageQuality)
        && (!Number.isFinite(referenceQuality) || referenceQuality >= minimumImageQuality);
    const qualityPassed = countPassed && imageQualityPassed;

    fs.mkdirSync(config.tempDir, { recursive: true });
    const nonce = crypto.randomUUID();
    const probePath = path.join(config.tempDir, `bozorth3_${nonce}_probe.xyt`);
    const referencePath = path.join(config.tempDir, `bozorth3_${nonce}_reference.xyt`);
    const probeXyt = toBozorthXyt(probePrepared.minutiae);
    const referenceXyt = toBozorthXyt(referencePrepared.minutiae);
    const templates = {
        probe: templateDiagnostics(probePath, probeXyt),
        reference: templateDiagnostics(referencePath, referenceXyt)
    };

    let execution = {
        command: null,
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false
    };
    try {
        if (!options.execute && (!config.executablePath || (!fs.existsSync(config.executablePath)
            && !(config.cygwinBashPath && fs.existsSync(config.cygwinBashPath))))) {
            throw new Error('Bozorth3 executable is not available.');
        }
        fs.writeFileSync(probePath, probeXyt, 'utf8');
        fs.writeFileSync(referencePath, referenceXyt, 'utf8');
        const commandPreview = `${config.executablePath} "${probePath}" "${referencePath}"`;
        const run = execute({
            command: commandPreview,
            executablePath: config.executablePath,
            cygwinBashPath: config.cygwinBashPath,
            probePath,
            referencePath,
            timeoutMs: config.timeoutMs
        });
        execution = {
            command: run.command || commandPreview,
            exitCode: run.status ?? null,
            stdout: String(run.stdout || '').trim(),
            stderr: String(run.stderr || '').trim(),
            timedOut: run.signal === 'SIGTERM' || run.error?.code === 'ETIMEDOUT'
        };
        if (run.error) throw run.error;
        if (run.status !== 0) throw new Error(execution.stderr || execution.stdout || `Bozorth3 exited with status ${run.status}.`);
        const score = parseScore(run.stdout, run.stderr);
        const decision = classifyBozorthDecision({
            score,
            threshold,
            borderlineBand: config.borderlineBand,
            qualityPassed
        });
        const result = {
            algorithm: 'Bozorth3',
            engineName: 'NIST NBIS Bozorth3',
            status: 'ok',
            score,
            rawScore: score,
            normalizedSimilarity: null,
            scoreScale: 'Native Bozorth3 score',
            scoreDirection: 'higher-is-more-similar',
            threshold,
            ...decision,
            processingTimeMs: elapsedMilliseconds(startedAt),
            qualityGate: {
                passed: qualityPassed,
                minimumMinutiae: config.minimumMinutiae,
                minimumImageQuality,
                countPassed,
                imageQualityPassed,
                probeQuality: Number.isFinite(probeQuality) ? probeQuality : null,
                referenceQuality: Number.isFinite(referenceQuality) ? referenceQuality : null,
                message: qualityPassed
                    ? 'Input quality is sufficient for a Bozorth3 decision.'
                    : 'Capture again: too few usable minutiae or image quality is below the configured floor.'
            },
            inputMinutiae: {
                probeExtracted: probePrepared.counts.extracted,
                probeUsed: probePrepared.counts.used,
                referenceExtracted: referencePrepared.counts.extracted,
                referenceUsed: referencePrepared.counts.used,
                probeFiltering: probePrepared.counts,
                referenceFiltering: referencePrepared.counts,
                filteringRules: probePrepared.rules,
                format: 'Bozorth3 XYT: x y clockwise-image-direction-degrees',
                coordinateConvention: 'top-left origin; +X right; +Y down; pixel coordinates',
                angleConvention: 'SourceAFIS radians clockwise converted to degrees modulo 360'
            },
            templates,
            execution,
            matchedMinutiae: {
                available: false,
                message: 'Bozorth3 returns a score, not a verified minutia-correspondence list.'
            },
            warnings: decision.reviewRecommended ? ['Score is inside the configured borderline band; manual review is recommended.'] : []
        };
        log('bozorth3_complete', 'Bozorth3 native comparison completed.', result);
        return result;
    } catch (error) {
        const result = {
            algorithm: 'Bozorth3',
            engineName: 'NIST NBIS Bozorth3',
            status: 'error',
            score: null,
            rawScore: null,
            normalizedSimilarity: null,
            scoreScale: 'Native Bozorth3 score',
            scoreDirection: 'higher-is-more-similar',
            threshold,
            result: 'UNAVAILABLE',
            isMatch: null,
            decisionState: 'error',
            reviewRecommended: false,
            processingTimeMs: elapsedMilliseconds(startedAt),
            error: error.message,
            statusMessage: error.message,
            qualityGate: { passed: qualityPassed, countPassed, imageQualityPassed },
            inputMinutiae: {
                probeExtracted: probePrepared.counts.extracted,
                probeUsed: probePrepared.counts.used,
                referenceExtracted: referencePrepared.counts.extracted,
                referenceUsed: referencePrepared.counts.used
            },
            templates,
            execution,
            matchedMinutiae: {
                available: false,
                message: 'Bozorth3 did not return a usable native score.'
            }
        };
        log('bozorth3_failed', 'Bozorth3 native comparison failed.', result, 'error');
        return result;
    } finally {
        for (const filePath of [probePath, referencePath]) {
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            } catch (_) {
                // Cleanup failure must not hide the matcher result.
            }
        }
    }
}

module.exports = {
    classifyBozorthDecision,
    prepareBozorthMinutiae,
    runBozorth3Matcher,
    toCygwinPath,
    toBozorthXyt
};
