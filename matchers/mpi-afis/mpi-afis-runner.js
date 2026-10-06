'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const SCORE_MINIMUM = 0;
const SCORE_MAXIMUM = 1;
const MIN_USABLE_MINUTIAE = 5;

function elapsedMilliseconds(startedAt) {
    return Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 100) / 100;
}

function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
}

function normalizeScore(score) {
    const value = Number(score);
    return Number.isFinite(value) ? Math.round(clamp(value, 0, 1) * 10000) / 100 : null;
}

function toMpiAfisXyt(minutiae) {
    if (!Array.isArray(minutiae)) throw new Error('Minutiae must be an array.');
    return minutiae.map((minutia, index) => {
        const x = Number(minutia?.x);
        const y = Number(minutia?.y);
        const angle = Number(minutia?.angle);
        if (![x, y, angle].every(Number.isFinite)) {
            throw new Error(`Invalid minutia at index ${index}; finite x, y, and angle values are required.`);
        }
        // SourceAFIS directions use top-left image coordinates and point along
        // the ending direction. mpi-afis' XYT reader doubles the half-degree
        // value, then getcrnT() converts it into the clockwise matcher frame and
        // reverses polarity by 180 degrees. Encode (180 - sourceDirection) so
        // the direction seen by MCC/Jiang equals the SourceAFIS direction.
        const clockwiseImageDegrees = ((((angle * 180) / Math.PI) % 360) + 360) % 360;
        const isoCounterclockwiseDegrees = ((180 - clockwiseImageDegrees) + 360) % 360;
        const halfDegreeDirection = Math.round(isoCounterclockwiseDegrees / 2) % 180;
        const quality = clamp(Math.round(Number.isFinite(Number(minutia.quality)) ? Number(minutia.quality) : 100), 0, 100);
        return `${Math.round(x)} ${Math.round(y)} ${halfDegreeDirection} ${quality}`;
    }).join(os.EOL) + os.EOL;
}

function toCygwinPath(filePath) {
    const normalized = path.resolve(filePath).replace(/\\/g, '/');
    const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
    return match ? `/cygdrive/${match[1].toLowerCase()}/${match[2]}` : normalized;
}

function quoteBash(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function parseNativeScore(output, matcherName) {
    const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const scoreLine = [...lines].reverse().find((line) => /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(line));
    if (!scoreLine) throw new Error(`${matcherName} returned no numeric score.`);
    const score = Number(scoreLine);
    if (!Number.isFinite(score) || score < SCORE_MINIMUM || score > SCORE_MAXIMUM) {
        throw new Error(`${matcherName} returned an invalid native score: ${scoreLine}`);
    }
    return Math.round(score * 1000000) / 1000000;
}

function parseNativeDiagnostics(output, spec) {
    const text = String(output || '');
    if (spec.eventPrefix === 'mcc') {
        const match = text.match(/MCC_DIAGNOSTIC\s+probeCylinders=(\d+)\s+referenceCylinders=(\d+)/);
        return {
            descriptor: 'Minutia Cylinder-Code',
            probeCylinderCount: match ? Number(match[1]) : null,
            referenceCylinderCount: match ? Number(match[2]) : null,
            cylinderCountsAvailable: !!match
        };
    }
    const match = text.match(/JIANG_DIAGNOSTIC\s+probeLocalStructures=(\d+)\s+referenceLocalStructures=(\d+)\s+alignment=([^\s]+)/);
    return {
        descriptor: 'Jiang local/global structure',
        probeLocalStructureCount: match ? Number(match[1]) : null,
        referenceLocalStructureCount: match ? Number(match[2]) : null,
        geometricAlignmentStatus: match ? match[3] : 'not-reported',
        localStructureCountsAvailable: !!match
    };
}

function unavailableResult(spec, threshold, startedAt, detail, errorType = 'matcher_unavailable') {
    return {
        algorithm: spec.algorithm,
        engineName: spec.algorithm,
        status: 'unavailable',
        score: null,
        rawScore: null,
        normalizedSimilarity: null,
        scoreScale: spec.scoreScale,
        scoreDirection: 'higher-is-more-similar',
        threshold,
        result: 'UNAVAILABLE',
        isMatch: null,
        processingTimeMs: elapsedMilliseconds(startedAt),
        minutiaeCount: { probe: 0, reference: 0 },
        inputMinutiae: { probeUsed: 0, referenceUsed: 0 },
        error: spec.unavailableMessage,
        errorType,
        statusMessage: detail,
        matchedMinutiae: {
            available: false,
            message: 'Detailed correspondence visualization unavailable for this matcher.'
        },
        warnings: [detail]
    };
}

function errorResult(spec, threshold, startedAt, detail, probeCount, referenceCount, errorType) {
    return {
        ...unavailableResult(spec, threshold, startedAt, detail, errorType),
        status: 'error',
        minutiaeCount: { probe: probeCount, reference: referenceCount },
        inputMinutiae: { probeUsed: probeCount, referenceUsed: referenceCount },
        error: detail
    };
}

function defaultConfig(projectRoot = path.resolve(__dirname, '..', '..')) {
    return {
        cygwinBashPath: process.env.CYGWIN_BASH || 'C:\\cygwin64\\bin\\bash.exe',
        tempDir: path.join(os.tmpdir(), 'Minutiae', 'mpi-afis'),
        timeoutMs: Number(process.env.MPI_AFIS_TIMEOUT_MS || 30000)
    };
}

function normalizeTranslationForLocalMatcher(minutiae, margin = 80) {
    const source = Array.isArray(minutiae) ? minutiae : [];
    if (!source.length) return { minutiae: [], shift: { x: 0, y: 0 } };
    const minimumX = Math.min(...source.map((minutia) => Number(minutia.x)));
    const minimumY = Math.min(...source.map((minutia) => Number(minutia.y)));
    if (!Number.isFinite(minimumX) || !Number.isFinite(minimumY)) {
        return { minutiae: source.map((minutia) => ({ ...minutia })), shift: { x: 0, y: 0 } };
    }
    const shift = { x: margin - minimumX, y: margin - minimumY };
    return {
        shift,
        minutiae: source.map((minutia) => ({
            ...minutia,
            x: Number(minutia.x) + shift.x,
            y: Number(minutia.y) + shift.y
        }))
    };
}

function runReferenceMatcher(spec, options) {
    const startedAt = process.hrtime.bigint();
    const threshold = Number(options.threshold);
    const config = { ...defaultConfig(), ...(options.config || {}) };
    const log = typeof options.log === 'function' ? options.log : () => {};
    const probeCount = Array.isArray(options.probeMinutiae) ? options.probeMinutiae.length : 0;
    const referenceCount = Array.isArray(options.referenceMinutiae) ? options.referenceMinutiae.length : 0;
    const probeNormalization = spec.normalizeTranslation
        ? normalizeTranslationForLocalMatcher(options.probeMinutiae)
        : { minutiae: Array.isArray(options.probeMinutiae) ? options.probeMinutiae : [], shift: { x: 0, y: 0 } };
    const referenceNormalization = spec.normalizeTranslation
        ? normalizeTranslationForLocalMatcher(options.referenceMinutiae)
        : { minutiae: Array.isArray(options.referenceMinutiae) ? options.referenceMinutiae : [], shift: { x: 0, y: 0 } };
    const conversionSamples = probeNormalization.minutiae
        .slice(0, 5)
        .map((minutia, index) => {
            const clockwiseDegrees = ((((Number(minutia.angle) * 180) / Math.PI) % 360) + 360) % 360;
            const counterclockwiseDegrees = ((180 - clockwiseDegrees) + 360) % 360;
            return {
                index,
                input: { x: Number(minutia.x), y: Number(minutia.y), angleRadClockwise: Number(minutia.angle), angleDegClockwise: clockwiseDegrees },
                output: { x: Math.round(Number(minutia.x)), y: Math.round(Number(minutia.y)), angleDegCounterclockwise: counterclockwiseDegrees, halfDegreeDirection: Math.round(counterclockwiseDegrees / 2) % 180 }
            };
        });

    if (config.disabled) {
        const detail = `${spec.disableVariable} is enabled; ${spec.algorithm} was not executed.`;
        log(`${spec.eventPrefix}_unavailable`, spec.unavailableMessage, { dependency: detail }, 'warn');
        return unavailableResult(spec, threshold, startedAt, detail, 'disabled');
    }
    if (!config.executablePath || !fs.existsSync(config.executablePath)) {
        const detail = `${spec.algorithm} executable is unavailable at ${config.executablePath || '(not configured)'}. Run npm run matchers:setup.`;
        log(`${spec.eventPrefix}_unavailable`, spec.unavailableMessage, { dependency: detail }, 'warn');
        return unavailableResult(spec, threshold, startedAt, detail, 'executable_unavailable');
    }
    if (probeCount < MIN_USABLE_MINUTIAE || referenceCount < MIN_USABLE_MINUTIAE) {
        const detail = `${spec.algorithm} requires at least ${MIN_USABLE_MINUTIAE} usable minutiae per fingerprint; received ${probeCount} and ${referenceCount}.`;
        log(`${spec.eventPrefix}_matching_failed`, detail, { probeCount, referenceCount }, 'error');
        return errorResult(spec, threshold, startedAt, detail, probeCount, referenceCount, 'no_usable_minutiae');
    }

    const tempRoot = config.tempDir || os.tmpdir();
    fs.mkdirSync(tempRoot, { recursive: true });
    const nonce = `${spec.eventPrefix}_${crypto.randomUUID()}`;
    const probePath = path.join(tempRoot, `${nonce}_probe.xyt`);
    const referencePath = path.join(tempRoot, `${nonce}_reference.xyt`);

    try {
        fs.writeFileSync(probePath, toMpiAfisXyt(probeNormalization.minutiae), 'utf8');
        fs.writeFileSync(referencePath, toMpiAfisXyt(referenceNormalization.minutiae), 'utf8');

        log(`${spec.eventPrefix}_initialized`, `${spec.algorithm} initialized.`, { implementation: 'mpi-afis' });
        log(`${spec.eventPrefix}_probe_minutiae_loaded`, 'Probe minutiae loaded.', { count: probeCount });
        log(`${spec.eventPrefix}_reference_minutiae_loaded`, 'Candidate minutiae loaded.', { count: referenceCount });
        log(`${spec.eventPrefix}_minutiae_counts`, 'Matcher minutiae counts recorded.', { probeCount, referenceCount });
        log(`${spec.eventPrefix}_coordinate_conversion`, 'Converted image-coordinate minutiae to mpi-afis ISO XYT.', {
            coordinateConvention: 'top-left origin; +X right; +Y down; pixels',
            inputAngleConvention: 'radians; clockwise; normalized modulo 2π',
            outputAngleConvention: 'ISO half-degrees encoded as (180° - SourceAFIS clockwise direction); mpi-afis doubles then converts to its clockwise matcher frame',
            samples: conversionSamples
        });

        let run;
        if (config.cygwinBashPath && fs.existsSync(config.cygwinBashPath)) {
            const executableAndInputs = [config.executablePath, probePath, referencePath]
                .map((value) => quoteBash(toCygwinPath(value)));
            const matcherArguments = (spec.arguments || []).map(quoteBash);
            const argumentsText = [...executableAndInputs, ...matcherArguments].join(' ');
            run = spawnSync(config.cygwinBashPath, ['-lc', argumentsText], {
                encoding: 'utf8', timeout: config.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024
            });
        } else {
            run = spawnSync(config.executablePath, [probePath, referencePath, ...(spec.arguments || [])], {
                encoding: 'utf8', timeout: config.timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024
            });
        }
        if (run.error) throw run.error;
        if (run.status !== 0) {
            throw new Error(String(run.stderr || run.stdout || `${spec.algorithm} exited with status ${run.status}.`).trim());
        }

        const score = parseNativeScore(run.stdout, spec.algorithm);
        const matcherDiagnostics = parseNativeDiagnostics(run.stdout, spec);
        const decision = score >= threshold ? 'MATCH' : 'NO MATCH';
        const result = {
            algorithm: spec.algorithm,
            engineName: spec.algorithm,
            implementation: 'mpi-afis Apache-2.0 reference implementation',
            status: 'ok',
            score,
            rawScore: score,
            normalizedSimilarity: normalizeScore(score),
            normalization: 'Native [0,1] score multiplied by 100.',
            scoreScale: spec.scoreScale,
            scoreDirection: 'higher-is-more-similar',
            threshold,
            result: decision,
            isMatch: decision === 'MATCH',
            processingTimeMs: elapsedMilliseconds(startedAt),
            minutiaeCount: { probe: probeCount, reference: referenceCount },
            inputMinutiae: {
                probeExtracted: probeCount,
                probeUsed: probeCount,
                referenceExtracted: referenceCount,
                referenceUsed: referenceCount,
                format: 'mpi-afis XYT: x y ISO-counterclockwise-half-degree-direction quality',
                coordinateConvention: 'top-left origin; +X right; +Y down; pixel coordinates',
                angleConvention: 'input radians clockwise; polarity-corrected to ISO half-degrees; mpi-afis doubles then converts to its clockwise matcher frame',
                translationNormalization: spec.normalizeTranslation ? {
                    method: 'independent origin normalization for local descriptors; relative minutia geometry is unchanged',
                    marginPx: 80,
                    probeShift: probeNormalization.shift,
                    referenceShift: referenceNormalization.shift
                } : null,
                conversionSamples
            },
            statusMessage: `${spec.algorithm} executed its own mpi-afis matching implementation.`,
            matchedMinutiae: {
                available: false,
                message: 'Detailed correspondence visualization unavailable for this matcher.'
            },
            matcherDiagnostics,
            warnings: probeCount < 12 || referenceCount < 12
                ? [`Too few minutiae for a robust ${spec.algorithm} decision.`]
                : []
        };
        result.matcherDiagnostics.alignment = spec.eventPrefix === 'mcc'
            ? {
                available: false,
                method: 'MCC local Minutia Cylinder-Code descriptors with LSSR global consolidation',
                message: 'The native mpi-afis MCC score API does not expose a single rigid transform or selected minutia correspondences.'
            }
            : {
                available: false,
                method: 'Jiang nearest-neighbour local structures with reference-minutia global consolidation',
                status: matcherDiagnostics.geometricAlignmentStatus,
                message: 'The native mpi-afis Jiang score API reports alignment completion but does not expose its selected transform or correspondences.'
            };
        if (spec.eventPrefix === 'mcc') {
            log('mcc_cylinders_generated', 'MCC cylinders generated.', matcherDiagnostics,
                matcherDiagnostics.cylinderCountsAvailable ? 'info' : 'warn');
        } else {
            log('jiang_alignment_complete', 'Jiang local structures and geometric alignment completed.', matcherDiagnostics,
                matcherDiagnostics.localStructureCountsAvailable ? 'info' : 'warn');
        }
        log(`${spec.eventPrefix}_matching_executed`, `${spec.algorithm} matching executed.`, {});
        log(`${spec.eventPrefix}_raw_score`, `${spec.algorithm} raw score returned.`, { rawScore: score });
        log(`${spec.eventPrefix}_threshold`, `${spec.algorithm} threshold used.`, { threshold });
        log(`${spec.eventPrefix}_decision`, `${spec.algorithm} decision produced.`, { decision });
        log(`${spec.eventPrefix}_processing_time`, `${spec.algorithm} processing time recorded.`, { processingTimeMs: result.processingTimeMs });
        return result;
    } catch (error) {
        const detail = `${spec.algorithm} matching failed: ${error.message}`;
        log(`${spec.eventPrefix}_matching_failed`, detail, { error: error.message }, 'error');
        return errorResult(spec, threshold, startedAt, detail, probeCount, referenceCount, 'matching_failure');
    } finally {
        for (const filePath of [probePath, referencePath]) {
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            } catch (_) {
                // Temporary cleanup must never replace the matcher result.
            }
        }
    }
}

const MCC_SPEC = {
    algorithm: 'MCC',
    unavailableMessage: 'MCC unavailable',
    disableVariable: 'MCC_DISABLED',
    eventPrefix: 'mcc',
    scoreScale: 'mpi-afis MCC LSSR native similarity (0-1)',
    normalizeTranslation: true,
    // The upstream convex-hull cell mask performs float-to-int orientation
    // tests in absolute image coordinates. Its rounding changes when every
    // minutia receives the same translation, which can collapse an otherwise
    // identical comparison to zero. -H disables only that optional mask; the
    // real Ns=8 cylinders and LSSR consolidation remain unchanged.
    arguments: ['-N', '8', '-C', 'LSSR', '-H']
};

const JIANG_SPEC = {
    algorithm: 'Jiang Matcher',
    unavailableMessage: 'Jiang Matcher unavailable',
    disableVariable: 'JIANG_DISABLED',
    eventPrefix: 'jiang',
    scoreScale: 'mpi-afis Jiang local/global-structure similarity (0-1)',
    arguments: []
};

function runMccMatcher(options) {
    const config = {
        disabled: /^(1|true|yes)$/i.test(process.env.MCC_DISABLED || ''),
        executablePath: process.env.MCC_EXECUTABLE || path.join(__dirname, 'mcc-match.exe'),
        ...(options.config || {})
    };
    return runReferenceMatcher(MCC_SPEC, { ...options, config });
}

function runJiangMatcher(options) {
    const config = {
        disabled: /^(1|true|yes)$/i.test(process.env.JIANG_DISABLED || ''),
        executablePath: process.env.JIANG_EXECUTABLE || path.join(__dirname, 'jiang-match.exe'),
        ...(options.config || {})
    };
    return runReferenceMatcher(JIANG_SPEC, { ...options, config });
}

module.exports = {
    MIN_USABLE_MINUTIAE,
    normalizeScore,
    normalizeTranslationForLocalMatcher,
    runJiangMatcher,
    runMccMatcher,
    toMpiAfisXyt
};
