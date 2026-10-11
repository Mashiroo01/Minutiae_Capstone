/**
 * MINUTIAE Fingerprint Scanner Service
 * ZKTeco ZK9500 Optical Fingerprint Scanner Integration
 * 
 * This service captures ZK9500 optical fingerprint images through the
 * ZKTeco SDK adapter and converts them to Minutiae AFIS/ISO templates.
 * 
 * Setup:
 * 1. Install Node.js from https://nodejs.org/
 * 2. npm install express cors
 * 3. Install the ZKTeco ZKFinger SDK and build scripts/zkteco-zk9500-capture.exe
 * 4. Connect the ZK9500 scanner via USB
 * 5. Run: node fingerprint-service.js
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const sharp = require('sharp');
const HID = require('node-hid');  // Real USB HID communication
const { runScannerCommand } = require('./scanner-command-runner');
const { runMccMatcher, runJiangMatcher } = require('./matchers/mpi-afis/mpi-afis-runner');
const { runBozorth3Matcher } = require('./matchers/bozorth3/bozorth3-runner');
const { filterMindtctMinutiaeBySkeleton, runMindtctExtractor } = require('./matchers/mindtct/mindtct-runner');
const { extractMinutiaePair } = require('./matchers/sourceafis/sourceafis-minutiae-runner');
const { classifyMinutiaByCrossingNumber, ridgeNeighborRing } = require('./matchers/minutiae-conventions');
const { createIsotropicCanvas, estimateAlignmentFromPairs, toOpenAfisCsv } = require('./matchers/openafis/openafis-adapter');
const { attachMatchPercentage } = require('./matchers/calibration/match-percentage');
const { buildSupportingMatcherArbiter } = require('./matchers/calibration/supporting-arbiter');
const { buildFingerprintComparisonResult } = require('./fingerprint-comparison-result');
const app = express();
const port = Number(process.env.PORT || 9000);

app.use(cors());
app.use(express.json({ limit: '15mb' }));

// ============================================================================
// ZKTECO ZK9500 OPTICAL FINGERPRINT SCANNER INTEGRATION
// ============================================================================

let scannerAvailable = false;
let scannerBinding = {
    path: process.env.SCANNER_PATH || null
};

const DEFAULT_ZKTECO_CAPTURE_COMMAND = path.join(__dirname, 'scripts', 'zkteco-zk9500-capture.exe');
const ZKTECO_CAPTURE_COMMAND = (process.env.ZKTECO_CAPTURE_COMMAND || '').trim();
const DEFAULT_CAPTURE_COMMAND = (process.env.SCANNER_CAPTURE_COMMAND || ZKTECO_CAPTURE_COMMAND || '').trim()
    || (fs.existsSync(DEFAULT_ZKTECO_CAPTURE_COMMAND) ? DEFAULT_ZKTECO_CAPTURE_COMMAND : '');
const DEFAULT_APP_TEMP_DIR = path.join(os.tmpdir(), 'Minutiae', 'work');
const DEFAULT_SCANNER_CAPTURE_TEMP_DIR = path.join(os.tmpdir(), 'Minutiae', 'scanner');

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const SCANNER_RUNTIME_CONFIG = {
    timeout: positiveInteger(process.env.SCANNER_CAPTURE_TIMEOUT_MS, 30000),
    processGraceMs: positiveInteger(process.env.SCANNER_CAPTURE_GRACE_MS, 15000),
    qualityThreshold: 70,
    tempDir: (process.env.MINUTIAE_TEMP_DIR || DEFAULT_APP_TEMP_DIR).trim(),
    scannerTempDir: (process.env.SCANNER_CAPTURE_TEMP_DIR || DEFAULT_SCANNER_CAPTURE_TEMP_DIR).trim()
};
const SCANNER_CONFIG = {
    provider: (process.env.SCANNER_PROVIDER || '').trim().toLowerCase(),
    captureCommand: DEFAULT_CAPTURE_COMMAND,
    captureArgs: (process.env.SCANNER_CAPTURE_ARGS || '--output {output} --type {type} --timeout {timeout}').trim(),
    statusArgs: (process.env.SCANNER_STATUS_ARGS || '--status').trim(),
    outputExtension: (process.env.SCANNER_CAPTURE_OUTPUT_EXTENSION || 'raw').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'raw',
    dpi: Number(process.env.SCANNER_DPI || 500),
    allowSimulation: ['1', 'true', 'yes', 'on'].includes(String(process.env.SCANNER_ALLOW_SIMULATION || '').toLowerCase())
};

if (!SCANNER_CONFIG.provider) {
    SCANNER_CONFIG.provider = 'zkteco-zk9500';
}

function isCommandScannerProvider(provider = SCANNER_CONFIG.provider) {
    return provider === 'zkteco-zk9500' || provider === 'command';
}

// AFIS pipeline settings for enhancement, minutiae extraction and matching.
const AFIS_CONFIG = {
    enhancement: {
        clahe: true,
        claheWindow: 24,
        claheMaxSlope: 4,
        medianSize: 3,
        sharpenSigma: 1.2,
        normalize: true,
        inputSize: 500,
        trimThreshold: 12,
        blockSize: 16,
        foregroundStdThreshold: 18,
        gaborRadius: 4,
        gaborGain: 1.35,
        thinningIterations: 12
    },
    minutiae: {
        maxPoints: 140,
        minDistance: 7,
        minRequiredForMatch: 18,
        minQuality: 24,
        borderMargin: 18,
        neighborRadius: 32,
        endingMinTraceLength: 10,
        bifurcationMinTraceLength: 7,
        traceMaxSteps: 18,
        descriptorNeighbors: 5
    },
    mindtct: {
        executablePath: process.env.MINDTCT_RAW_PATH || path.join(__dirname, 'matchers', 'mindtct', 'mindtct-raw.exe'),
        skeletonRadius: positiveInteger(process.env.MINDTCT_SKELETON_RADIUS, 6)
    },
    bozorth3Path: process.env.BOZORTH3_PATH || '/home/mendi/nbis/bozorth3/bin/bozorth3',
    cygwinBashPath: process.env.CYGWIN_BASH || 'C:\\cygwin64\\bin\\bash.exe',
    matchThreshold: 68,
    consistency: {
        enabled: true,
        minScore: 12,
        minDirectionalScore: 6,
        distancePx: 16,
        angleDeg: 24,
        requireType: true,
        useCentroidShift: true
    },
    alignment: {
        enabled: true,
        topCandidates: 18,
        maxAngleDeg: 35,
        distancePx: 16,
        angleDeg: 24
    },
    graph: {
        distanceBinSize: 20,
        distanceBins: 12,
        angleBinSize: 20,
        angleBins: 9
    },
    localStructure: {
        enabled: true,
        descriptorNeighbors: 5,
        distancePx: 18,
        angleDeg: 28,
        minScore: 52
    },
    bozorthEnhancement: {
        enabled: true,
        distancePx: 18,
        angleDeg: 26,
        pairMinScore: 54,
        edgeDistanceTolerance: 22,
        edgeAngleDeg: 24,
        edgeOrientationDeg: 28,
        rawWeight: 0.52,
        pairWeight: 0.18,
        coverageWeight: 0.14,
        graphWeight: 0.16
    },
    thresholding: {
        minThreshold: 60,
        maxThreshold: 84,
        lowQualityPenalty: 10,
        lowOverlapPenalty: 8,
        lowMinutiaePenalty: 6,
        highQualityBonus: 4
    },
    decision: {
        structuralOrientationMin: 76,
        structuralGraphMin: 80,
        partialOverlapMin: 0.26,
        partialQualityMin: 68,
        localStructureRescueMin: 42,
        partialLocalStructureMin: 34,
        bozorthFloor: 44,
        bozorthThresholdAllowance: 20
    },
    fusion: {
        bozorth: 0.06,
        consistency: 0.10,
        orientation: 0.50,
        graph: 0.20,
        localStructure: 0.12,
        quality: 0.02
    },
    academicMatchers: {
        // Calibrated on 280 genuine and 280 impostor FVC2004 DB4_B pairs
        // using score-independent SourceAFIS minutiae and held-out subjects.
        bozorth3Threshold: Number(process.env.BOZORTH3_MATCH_THRESHOLD || 16),
        bozorth3BorderlineBand: Number(process.env.BOZORTH3_BORDERLINE_BAND || 3),
        bozorth3MinimumMinutiae: Number(process.env.BOZORTH3_MINIMUM_MINUTIAE || 18),
        bozorth3MinimumImageQuality: Number(process.env.BOZORTH3_MINIMUM_IMAGE_QUALITY || 35),
        // Calibrated on balanced FVC2004 DB4_B genuine/impostor pairs using
        // each matcher's exact production feed and held-out subjects.
        sourceAfisThreshold: Number(process.env.SOURCEAFIS_MATCH_THRESHOLD || 18.074729666),
        openAfisThreshold: Number(process.env.OPENAFIS_MATCH_THRESHOLD || 3.5),
        mccThreshold: Number(process.env.MCC_MATCH_THRESHOLD || 0.030879),
        jiangThreshold: Number(process.env.JIANG_MATCH_THRESHOLD || 0.2020075),
        sourceAfisDpi: Number(process.env.SOURCEAFIS_DPI || 500),
        javaPath: process.env.JAVA_PATH || 'java',
        sourceAfisClassPath: process.env.SOURCEAFIS_CLASSPATH || [
            path.join(__dirname, 'matchers', 'sourceafis', 'target', 'classes'),
            path.join(__dirname, 'matchers', 'sourceafis', 'lib', '*')
        ].join(path.delimiter),
        openAfisPath: process.env.OPENAFIS_PATH || path.join(__dirname, 'matchers', 'openafis', 'openafis-match.exe'),
        mccPath: process.env.MCC_EXECUTABLE || path.join(__dirname, 'matchers', 'mpi-afis', 'mcc-match.exe'),
        jiangPath: process.env.JIANG_EXECUTABLE || path.join(__dirname, 'matchers', 'mpi-afis', 'jiang-match.exe')
    }
};

function isBozorth3Ready() {
    if (fs.existsSync(AFIS_CONFIG.bozorth3Path)) {
        return true;
    }
    if (!AFIS_CONFIG.bozorth3Path.startsWith('/') || !fs.existsSync(AFIS_CONFIG.cygwinBashPath)) {
        return false;
    }

    const quotedPath = `'${AFIS_CONFIG.bozorth3Path.replace(/'/g, `'"'"'`)}'`;
    const result = spawnSync(AFIS_CONFIG.cygwinBashPath, ['-lc', `test -x ${quotedPath}`], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true
    });
    return result.status === 0;
}

const DEBUG_TRACE_LIMIT = 500;
const serviceDebugEvents = [];
let debugSequence = 0;

function createTraceContext(operation, metadata = {}) {
    debugSequence += 1;
    return {
        traceId: `${operation}_${Date.now()}_${debugSequence.toString(16)}`,
        operation,
        metadata
    };
}

function logServiceEvent(traceContext, stage, message, data = {}, level = 'info') {
    if (!traceContext || !traceContext.traceId) {
        return null;
    }

    const event = {
        id: `${traceContext.traceId}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        traceId: traceContext.traceId,
        operation: traceContext.operation || null,
        stage,
        level,
        message,
        timestamp: new Date().toISOString(),
        data
    };

    serviceDebugEvents.push(event);
    if (serviceDebugEvents.length > DEBUG_TRACE_LIMIT) {
        serviceDebugEvents.splice(0, serviceDebugEvents.length - DEBUG_TRACE_LIMIT);
    }

    return event;
}

function sha256Hex(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sanitizeDiagnosticText(value, fallback = 'unspecified') {
    const text = String(value || '').trim();
    return text ? text.slice(0, 240) : fallback;
}

function matcherPairDiagnostics(probeBuffer, referenceBuffer, probe, reference, probeInfo = {}, referenceInfo = {}) {
    const defaultDpi = AFIS_CONFIG.academicMatchers.sourceAfisDpi;
    const describe = (role, buffer, processed, supplied) => ({
        role,
        fingerprintId: sanitizeDiagnosticText(supplied.fingerprintId, `${role}-${sha256Hex(buffer).slice(0, 16)}`),
        filePath: sanitizeDiagnosticText(supplied.filePath || supplied.fileName, 'not available (browser/scanner buffer)'),
        fingerPosition: sanitizeDiagnosticText(supplied.fingerPosition),
        imageWidth: Number(processed.inputMetrics?.originalWidth) || 0,
        imageHeight: Number(processed.inputMetrics?.originalHeight) || 0,
        normalizedWidth: Number(processed.inputMetrics?.normalizedWidth) || 0,
        normalizedHeight: Number(processed.inputMetrics?.normalizedHeight) || 0,
        dpi: toFiniteNumber(supplied.dpi, toFiniteNumber(processed.inputMetrics?.dpi, defaultDpi)),
        dpiSource: sanitizeDiagnosticText(supplied.dpiSource || processed.inputMetrics?.dpiSource, 'configured SourceAFIS fallback'),
        imageHash: sha256Hex(buffer),
        normalizedImageHash: sha256Hex(Buffer.from(processed.normalizedImage || processed.image, 'base64')),
        imageBytes: buffer.length
    });
    return {
        probe: describe('probe', probeBuffer, probe, probeInfo),
        candidate: describe('candidate', referenceBuffer, reference, referenceInfo),
        sameSourceImage: sha256Hex(probeBuffer) === sha256Hex(referenceBuffer)
    };
}

function toFiniteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeMatcherSection(defaults, overrides = {}) {
    const sanitized = { ...defaults };
    if (!overrides || typeof overrides !== 'object') {
        return sanitized;
    }

    for (const [key, defaultValue] of Object.entries(defaults)) {
        if (!(key in overrides)) {
            continue;
        }
        if (typeof defaultValue === 'boolean') {
            sanitized[key] = !!overrides[key];
        } else if (typeof defaultValue === 'number') {
            sanitized[key] = toFiniteNumber(overrides[key], defaultValue);
        } else {
            sanitized[key] = overrides[key];
        }
    }

    return sanitized;
}

function buildRuntimeMatcherConfig(tuningOverrides = {}) {
    const overrides = tuningOverrides && typeof tuningOverrides === 'object' ? tuningOverrides : {};
    return {
        ...AFIS_CONFIG,
        matchThreshold: toFiniteNumber(overrides.matchThreshold, AFIS_CONFIG.matchThreshold),
        minutiae: sanitizeMatcherSection(AFIS_CONFIG.minutiae, overrides.minutiae),
        consistency: sanitizeMatcherSection(AFIS_CONFIG.consistency, overrides.consistency),
        alignment: sanitizeMatcherSection(AFIS_CONFIG.alignment, overrides.alignment),
        thresholding: sanitizeMatcherSection(AFIS_CONFIG.thresholding, overrides.thresholding),
        localStructure: sanitizeMatcherSection(AFIS_CONFIG.localStructure, overrides.localStructure),
        bozorthEnhancement: sanitizeMatcherSection(AFIS_CONFIG.bozorthEnhancement, overrides.bozorthEnhancement),
        decision: sanitizeMatcherSection(AFIS_CONFIG.decision, overrides.decision),
        fusion: sanitizeMatcherSection(AFIS_CONFIG.fusion, overrides.fusion)
    };
}

function initializeScanner() {
    try {
        console.log('[INFO] Initializing fingerprint scanner service...');
        
        // Ensure temp directories exist
        if (!fs.existsSync(SCANNER_RUNTIME_CONFIG.tempDir)) {
            fs.mkdirSync(SCANNER_RUNTIME_CONFIG.tempDir, { recursive: true });
        }
        if (!fs.existsSync(SCANNER_RUNTIME_CONFIG.scannerTempDir)) {
            fs.mkdirSync(SCANNER_RUNTIME_CONFIG.scannerTempDir, { recursive: true });
        }
        
        checkScannerStatus();
        return true;
    } catch (error) {
        console.error('[ERROR] Failed to initialize:', error.message);
        console.log('[INFO] Ready for fingerprint scanning');
        return true;
    }
}

function checkScannerStatus() {
    if (isCommandScannerProvider()) {
        scannerAvailable = checkScannerCommandStatus();
        if (scannerAvailable) {
            console.log(`[SUCCESS] ${getScannerDisplayName()} is ready through SDK adapter: ${SCANNER_CONFIG.captureCommand}`);
        } else {
            console.log(`[WARN] ${getScannerDisplayName()} is not ready. Build/configure the ZKTeco SDK adapter and connect the scanner.`);
        }
        return;
    }

    if (SCANNER_CONFIG.provider === 'simulation') {
        scannerAvailable = SCANNER_CONFIG.allowSimulation;
        console.log(scannerAvailable
            ? '[WARN] Simulation provider enabled for development.'
            : '[WARN] Simulation provider requested but SCANNER_ALLOW_SIMULATION is not enabled.');
        return;
    }

    scannerAvailable = false;
    console.log(`[WARN] Unknown scanner provider: ${SCANNER_CONFIG.provider}`);
}

function getScannerDisplayName() {
    if (SCANNER_CONFIG.provider === 'zkteco-zk9500') {
        return 'ZKTeco ZK9500 Optical Fingerprint Scanner';
    }
    if (SCANNER_CONFIG.provider === 'simulation') {
        return 'Simulated Fingerprint Scanner';
    }
    return 'Configured Optical Fingerprint Scanner';
}

function checkScannerCommandStatus() {
    if (!SCANNER_CONFIG.captureCommand) {
        console.log(`[WARN] Missing ZK9500 capture adapter. Expected ${DEFAULT_ZKTECO_CAPTURE_COMMAND} or set SCANNER_CAPTURE_COMMAND.`);
        return false;
    }

    if (SCANNER_CONFIG.provider === 'command') {
        return true;
    }

    const args = splitCommandArgs(SCANNER_CONFIG.statusArgs);
    const result = spawnSync(SCANNER_CONFIG.captureCommand, args, {
        cwd: __dirname,
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
    });

    if (result.error) {
        console.log(`[WARN] ZK9500 status check failed: ${result.error.message}`);
        return false;
    }

    const parsed = parseScannerCommandJson(result.stdout);
    if (parsed && parsed.available !== undefined) {
        return !!parsed.available;
    }

    return result.status === 0;
}

async function captureFingerprint(type, traceContext = null) {
    try {
        console.log(`[SCAN] Capturing ${type} fingerprint using ${SCANNER_CONFIG.provider} provider...`);
        logServiceEvent(traceContext, 'scan_requested', 'Fingerprint capture requested.', {
            type,
            provider: SCANNER_CONFIG.provider,
            simulationAllowed: SCANNER_CONFIG.allowSimulation
        });

        if (isCommandScannerProvider()) {
            try {
                return await captureFromScannerCommand(type, traceContext);
            } catch (error) {
                if (!SCANNER_CONFIG.allowSimulation) {
                    throw error;
                }

                console.log(`[SCAN] ${error.message} Using simulation because SCANNER_ALLOW_SIMULATION=1.`);
                logServiceEvent(traceContext, 'scanner_fallback', 'Scanner capture failed; using the enabled simulation fallback.', {
                    type,
                    error: error.message
                }, 'warning');
                return await captureFromSimulation(type, traceContext);
            }
        }

        if (SCANNER_CONFIG.provider === 'simulation') {
            if (!SCANNER_CONFIG.allowSimulation) {
                throw new Error('Simulation provider requested, but SCANNER_ALLOW_SIMULATION is not enabled.');
            }
            return await captureFromSimulation(type, traceContext);
        }

        throw new Error(`Unsupported scanner provider: ${SCANNER_CONFIG.provider}`);
    } catch (error) {
        logServiceEvent(traceContext, 'scan_failed', 'Fingerprint capture failed.', {
            type,
            error: error.message
        }, 'error');
        throw new Error('Fingerprint capture failed: ' + error.message);
    }
}

function splitCommandArgs(commandLine) {
    if (!commandLine) {
        return [];
    }

    const args = [];
    let current = '';
    let quote = null;

    for (let i = 0; i < commandLine.length; i++) {
        const char = commandLine[i];
        if ((char === '"' || char === "'") && commandLine[i - 1] !== '\\') {
            if (quote === char) {
                quote = null;
            } else if (!quote) {
                quote = char;
            } else {
                current += char;
            }
            continue;
        }

        if (/\s/.test(char) && !quote) {
            if (current !== '') {
                args.push(current.replace(/\\(["'])/g, '$1'));
                current = '';
            }
            continue;
        }

        current += char;
    }

    if (current !== '') {
        args.push(current.replace(/\\(["'])/g, '$1'));
    }

    return args;
}

function applyScannerArgPlaceholders(arg, values) {
    return String(arg)
        .replace(/\{output\}/g, values.output)
        .replace(/\{type\}/g, values.type)
        .replace(/\{timeout\}/g, String(values.timeout))
        .replace(/\{format\}/g, values.format);
}

function parseScannerCommandJson(stdout) {
    const text = String(stdout || '').trim();
    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace <= firstBrace) {
            return null;
        }

        try {
            return JSON.parse(text.slice(firstBrace, lastBrace + 1));
        } catch (innerError) {
            return null;
        }
    }
}

function resolveScannerOutputPath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') {
        return null;
    }

    return path.isAbsolute(rawPath)
        ? rawPath
        : path.resolve(SCANNER_RUNTIME_CONFIG.tempDir, rawPath);
}

function loadScannerCommandImage(stdout, defaultOutputPath) {
    const parsed = parseScannerCommandJson(stdout);
    if (parsed) {
        const imageBase64 = parsed.imageBase64 || parsed.image || parsed.fingerprintImage || parsed.fingerprint_image;
        if (imageBase64) {
            return {
                imageBuffer: Buffer.from(parseFingerprintImageInput(imageBase64), 'base64'),
                metadata: parsed
            };
        }

        const imagePath = resolveScannerOutputPath(parsed.imagePath || parsed.image_path || parsed.outputPath || parsed.output);
        if (imagePath && fs.existsSync(imagePath)) {
            return {
                imageBuffer: fs.readFileSync(imagePath),
                metadata: parsed
            };
        }
    }

    if (defaultOutputPath && fs.existsSync(defaultOutputPath)) {
        return {
            imageBuffer: fs.readFileSync(defaultOutputPath),
            metadata: parsed || {}
        };
    }

    throw new Error('Scanner command completed but did not return or write a fingerprint image.');
}

async function buildCaptureResponseFromImageBuffer(imageBuffer, source, scanned, traceContext, type, label = 'scanner_capture') {
    const afisData = await processFingerprintForAfis(imageBuffer, {
        ...traceContext,
        label
    }, { inputDpi: SCANNER_CONFIG.dpi });
    const normalizedBuffer = Buffer.from(afisData.image, 'base64');
    const enhancedBuffer = Buffer.from(afisData.enhancedImage, 'base64');
    const template = buildTemplateFromMinutiae(afisData.minutiae, enhancedBuffer, normalizedBuffer);

    logServiceEvent(traceContext, scanned ? 'scanner_capture_complete' : 'simulation_complete', `${source} capture processed successfully.`, {
        type,
        scanned,
        minutiaeCount: afisData.minutiae.length,
        quality: afisData.quality
    });

    return {
        fingerprintId: `${type || 'fingerprint'}-${sha256Hex(imageBuffer).slice(0, 16)}`,
        fingerPosition: 'unspecified',
        dpi: SCANNER_CONFIG.dpi,
        dpiSource: 'scanner configuration (ZKTeco ZK9500)',
        template: template,
        image: afisData.image,
        originalImage: afisData.originalImage,
        normalizedImage: afisData.normalizedImage,
        denoisedImage: afisData.denoisedImage,
        format: 'ISO',
        quality: afisData.quality,
        source,
        imageFormat: 'PNG',
        scanned,
        enhancedImage: afisData.enhancedImage,
        gaborEnhancedImage: afisData.gaborEnhancedImage,
        binarizedImage: afisData.binarizedImage,
        thinnedImage: afisData.thinnedImage,
        minutiaeOverlayImage: afisData.minutiaeOverlayImage,
        minutiae: afisData.minutiae,
        academicMinutiae: afisData.academicMinutiae,
        afisQuality: afisData.quality,
        qualityMetrics: afisData.qualityMetrics,
        blockMetrics: afisData.blockMetrics,
        orientationField: afisData.orientationField,
        frequencyField: afisData.frequencyField,
        coherenceField: afisData.coherenceField,
        blocksX: afisData.blocksX,
        blocksY: afisData.blocksY,
        preprocessing: afisData.preprocessing,
        inputMetrics: afisData.inputMetrics
    };
}

async function prepareScannerCommandImageBuffer(loaded, traceContext = null) {
    const metadata = loaded.metadata || {};
    const width = Number(metadata.width || metadata.imageWidth || metadata.image_width || 0);
    const height = Number(metadata.height || metadata.imageHeight || metadata.image_height || 0);
    const imagePath = String(metadata.imagePath || metadata.image_path || metadata.outputPath || metadata.output || '');
    const format = String(metadata.format || metadata.imageFormat || path.extname(imagePath).slice(1)).toLowerCase();
    const isRawGrayscale = width > 0
        && height > 0
        && (format === 'raw' || imagePath.toLowerCase().endsWith('.raw') || loaded.imageBuffer.length === width * height);

    if (!isRawGrayscale) {
        return loaded.imageBuffer;
    }

    logServiceEvent(traceContext, 'scanner_raw_decode', 'Converting raw ZK9500 grayscale pixels to PNG for AFIS.', {
        width,
        height,
        bytes: loaded.imageBuffer.length
    });

    return sharp(loaded.imageBuffer, {
        raw: {
            width,
            height,
            channels: 1
        }
    })
        .png()
        .toBuffer();
}

async function captureFromScannerCommand(type, traceContext = null) {
    if (!SCANNER_CONFIG.captureCommand) {
        throw new Error(`ZK9500 capture adapter is not configured. Build ${DEFAULT_ZKTECO_CAPTURE_COMMAND} from scripts/zkteco-zk9500-capture.cs or set SCANNER_CAPTURE_COMMAND.`);
    }

    const outputPath = path.join(
        SCANNER_RUNTIME_CONFIG.scannerTempDir,
        `scanner-capture-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${SCANNER_CONFIG.outputExtension}`
    );
    const placeholderValues = {
        output: outputPath,
        type,
        timeout: SCANNER_RUNTIME_CONFIG.timeout,
        format: SCANNER_CONFIG.outputExtension
    };
    const args = splitCommandArgs(SCANNER_CONFIG.captureArgs)
        .map((arg) => applyScannerArgPlaceholders(arg, placeholderValues));

    logServiceEvent(traceContext, 'scanner_command_start', 'Starting configured scanner SDK command.', {
        command: SCANNER_CONFIG.captureCommand,
        args,
        outputPath
    });

    const startedAt = Date.now();
    let result;
    try {
        result = await runScannerCommand(SCANNER_CONFIG.captureCommand, args, {
            cwd: __dirname,
            input: JSON.stringify({
                type,
                output: outputPath,
                timeout: SCANNER_RUNTIME_CONFIG.timeout,
                format: SCANNER_CONFIG.outputExtension
            }),
            timeoutMs: SCANNER_RUNTIME_CONFIG.timeout + SCANNER_RUNTIME_CONFIG.processGraceMs,
            maxBuffer: 1024 * 1024 * 20
        });
    } catch (error) {
        logServiceEvent(traceContext, 'scanner_command_error', 'Scanner SDK command failed to start or timed out.', {
            error: error.message,
            code: error.code || null,
            durationMs: Date.now() - startedAt
        }, 'error');
        if (error.code === 'SCANNER_CAPTURE_TIMEOUT') {
            throw new Error('ZKTeco ZK9500 capture timed out while the SDK was finishing. Lift your finger, place it flat on the scanner, and try again.');
        }
        throw error;
    }

    if (result.status !== 0) {
        const details = String(result.stderr || result.stdout || '').trim();
        const parsedError = parseScannerCommandJson(result.stdout) || parseScannerCommandJson(result.stderr);
        logServiceEvent(traceContext, 'scanner_command_error', 'Scanner SDK command exited unsuccessfully.', {
            status: result.status,
            stderr: String(result.stderr || '').slice(0, 2000),
            stdout: String(result.stdout || '').slice(0, 2000),
            durationMs: Date.now() - startedAt
        }, 'error');
        if (parsedError && parsedError.error) {
            throw new Error(parsedError.error);
        }
        throw new Error(`Scanner command failed${details ? `: ${details}` : ''}`);
    }

    const loaded = loadScannerCommandImage(result.stdout, outputPath);
    const source = loaded.metadata?.source || loaded.metadata?.device || 'Optical scanner';
    logServiceEvent(traceContext, 'scanner_command_complete', 'Scanner SDK command returned a fingerprint image.', {
        durationMs: Date.now() - startedAt,
        imageBytes: loaded.imageBuffer.length,
        source
    });

    const imageBuffer = await prepareScannerCommandImageBuffer(loaded, traceContext);

    return buildCaptureResponseFromImageBuffer(
        imageBuffer,
        source,
        true,
        traceContext,
        type,
        'scanner_command_capture'
    );
}

function fallbackToSimulationOrReject(resolve, reject, type, traceContext, reason) {
    if (!SCANNER_CONFIG.allowSimulation) {
        logServiceEvent(traceContext, 'scanner_unavailable', reason, {
            type,
            simulationAllowed: false
        }, 'error');
        reject(new Error(`${reason} Build/configure the ZKTeco ZK9500 SDK adapter or enable SCANNER_ALLOW_SIMULATION=1 for lab testing.`));
        return;
    }

    console.log(`[SCAN] ${reason} Using simulation because SCANNER_ALLOW_SIMULATION=1.`);
    logServiceEvent(traceContext, 'scanner_fallback', `${reason} Switching to explicit simulation fallback.`, {
        type
    }, 'warning');
    captureFromScannerSimulation(resolve, traceContext);
}

function captureFromSimulation(type, traceContext = null) {
    return new Promise((resolve) => {
        captureFromScannerSimulation(resolve, traceContext);
    });
}

// Fallback simulation when device unavailable
function captureFromScannerSimulation(resolve, traceContext = null) {
    setTimeout(async () => {
        try {
            console.log('[SIMULATION] Generating simulated fingerprint...');
            logServiceEvent(traceContext, 'simulation_start', 'Generating simulated fingerprint sample.');
            const imageData = generateFingerprintImage();
            
            const pngBuffer = await sharp(
                imageData.data,
                {
                    raw: {
                        width: imageData.width,
                        height: imageData.height,
                        channels: 1
                    }
                }
            )
            .png()
            .toBuffer();
            
            const afisData = await processFingerprintForAfis(pngBuffer, {
                ...traceContext,
                label: 'simulation_capture'
            });
            const normalizedBuffer = Buffer.from(afisData.image, 'base64');
            const enhancedBuffer = Buffer.from(afisData.enhancedImage, 'base64');
            const template = buildTemplateFromMinutiae(afisData.minutiae, enhancedBuffer, normalizedBuffer);
            
            console.log(`[SIMULATION] Simulated fingerprint generated`);
            logServiceEvent(traceContext, 'simulation_complete', 'Simulation capture processed successfully.', {
                scanned: false,
                minutiaeCount: afisData.minutiae.length,
                quality: afisData.quality
            });
            
            resolve({
                template: template,
                image: afisData.image,
                originalImage: afisData.originalImage,
                normalizedImage: afisData.normalizedImage,
                denoisedImage: afisData.denoisedImage,
                format: 'ISO',
                quality: 90,
                source: 'Simulated (ZK9500 not available)',
                imageFormat: 'PNG',
                scanned: false,
                enhancedImage: afisData.enhancedImage,
                gaborEnhancedImage: afisData.gaborEnhancedImage,
                binarizedImage: afisData.binarizedImage,
                thinnedImage: afisData.thinnedImage,
                minutiaeOverlayImage: afisData.minutiaeOverlayImage,
                minutiae: afisData.minutiae,
                afisQuality: afisData.quality,
                qualityMetrics: afisData.qualityMetrics,
                blockMetrics: afisData.blockMetrics,
                orientationField: afisData.orientationField,
                frequencyField: afisData.frequencyField,
                coherenceField: afisData.coherenceField,
                blocksX: afisData.blocksX,
                blocksY: afisData.blocksY,
                preprocessing: afisData.preprocessing,
                inputMetrics: afisData.inputMetrics
            });
        } catch (err) {
            console.error('[SIMULATION] Error:', err.message);
            logServiceEvent(traceContext, 'simulation_error', 'Simulation capture failed.', {
                error: err.message
            }, 'error');
            resolve({
                template: generateRandomTemplate(),
                image: '',
                format: 'ISO',
                quality: 0,
                source: 'Error',
                imageFormat: 'NONE',
                scanned: false,
                error: err.message
            });
        }
    }, 3000);
}// Generate realistic fingerprint image with proper ridge patterns (500x500 grayscale)
function generateFingerprintImage() {
    const width = 500;
    const height = 500;
    const pixelCount = width * height;
    const imageData = Buffer.alloc(pixelCount);
    
    // Start with white background
    for (let i = 0; i < pixelCount; i++) {
        imageData[i] = 255;
    }
    
    // Create fingerprint ridge pattern using Perlin-like noise
    const scale = 0.04;
    const ridgeWidth = 12;
    const valleyWidth = 8;
    
    const centerX = width / 2;
    const centerY = height / 2;
    const fingerRadius = 160;
    
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            
            // Distance from center
            const dx = x - centerX;
            const dy = y - centerY;
            const distFromCenter = Math.sqrt(dx * dx + dy * dy);
            
            // Skip area outside fingerprint
            if (distFromCenter > fingerRadius) {
                imageData[idx] = 255;
                continue;
            }
            
            // Calculate angle (polar coordinate)
            const angle = Math.atan2(dy, dx);
            
            // Create ridge pattern using multiple sine waves
            // This creates the characteristic ridge lines
            const ridge1 = Math.sin((distFromCenter * 0.15) - (angle * 2)) * 25;
            const ridge2 = Math.sin((distFromCenter * 0.12) + (angle * 3)) * 20;
            const ridge3 = Math.sin((x * 0.02) + (y * 0.01)) * 15;
            
            let value = 128 + ridge1 + ridge2 + ridge3;
            
            // Create actual ridge lines (binary-like, not gradual)
            const ridgePattern = Math.sin(distFromCenter * 0.15 - angle * 2);
            
            if (ridgePattern > 0.3) {
                // Dark ridge area
                value = 40 + Math.random() * 50;
            } else if (ridgePattern > -0.3) {
                // Transition zone
                value = 120 + Math.random() * 40;
            } else {
                // Light valley area
                value = 200 + Math.random() * 40;
            }
            
            // Add ridge texture (pores and scratches)
            if (ridgePattern > 0.2) {
                if (Math.random() > 0.92) {
                    value = Math.min(255, value + 60); // Pore highlight
                }
                if (Math.random() > 0.95) {
                    value = Math.max(0, value - 40); // Ridge detail
                }
            }
            
            // Add fingerprint center focus area (loop pattern core)
            const distFromCenterNorm = distFromCenter / fingerRadius;
            if (distFromCenterNorm < 0.4) {
                // Stronger ridges near center
                value = Math.max(0, value - 20);
            }
            
            // Clamp to 0-255
            imageData[idx] = Math.max(0, Math.min(255, value));
        }
    }
    
    // Post-process: Enhance contrast
    enhanceContrast(imageData);
    
    // Add visible minutiae points
    const minutiae = generateMinutiaePoints(centerX, centerY, fingerRadius);
    drawMinutiaePoints(imageData, width, height, minutiae);
    
    return {
        data: imageData,
        width: width,
        height: height,
        quality: 94
    };
}

function buildTemplateFromMinutiae(minutiae, enhancedImageBuffer, sourceImageBuffer = null) {
    // Build a stable pseudo-template from minutiae + image digest so uploads/scans can be matched consistently.
    const header = Buffer.from([0x46, 0x49, 0x52, 0x00]); // "FIR\0"
    const minutiaeText = minutiae
        .map((m) => `${m.x},${m.y},${Math.round((m.angle * 180) / Math.PI)},${m.type}`)
        .join('|');
    const hasher = crypto.createHash('sha256')
        .update(minutiaeText)
        .update(enhancedImageBuffer);
    if (Buffer.isBuffer(sourceImageBuffer) && sourceImageBuffer.length > 0) {
        hasher.update(sourceImageBuffer);
    }
    const digest = hasher.digest();

    const template = Buffer.alloc(128, 0);
    header.copy(template, 0);
    // Repeat digest bytes to fill template body.
    for (let i = 8; i < 128; i++) {
        template[i] = digest[(i - 8) % digest.length];
    }
    return template;
}

function angleDiffDeg(a, b) {
    let diff = Math.abs((((a - b) * 180) / Math.PI));
    while (diff > 360) diff -= 360;
    if (diff > 180) diff = 360 - diff;
    return diff;
}

function normalizeAngleRad(angle) {
    let normalized = angle;
    while (normalized <= -Math.PI) normalized += Math.PI * 2;
    while (normalized > Math.PI) normalized -= Math.PI * 2;
    return normalized;
}

function angleDiffRad(a, b) {
    return normalizeAngleRad(a - b);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function createEmptyBlockMap(blocksX, blocksY, fill = 0) {
    return new Array(blocksX * blocksY).fill(fill);
}

function getBlockIndex(blocksX, x, y) {
    return y * blocksX + x;
}

function getBlockCoordinates(width, height, blockSize, x, y) {
    const blocksX = Math.ceil(width / blockSize);
    const blocksY = Math.ceil(height / blockSize);
    return {
        blocksX,
        blocksY,
        bx: clamp(Math.floor(x / blockSize), 0, blocksX - 1),
        by: clamp(Math.floor(y / blockSize), 0, blocksY - 1)
    };
}

function sampleGrayBilinear(pixels, width, height, x, y) {
    const fx = clamp(x, 0, width - 1);
    const fy = clamp(y, 0, height - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const dx = fx - x0;
    const dy = fy - y0;

    const p00 = pixels[y0 * width + x0];
    const p10 = pixels[y0 * width + x1];
    const p01 = pixels[y1 * width + x0];
    const p11 = pixels[y1 * width + x1];

    const top = p00 * (1 - dx) + p10 * dx;
    const bottom = p01 * (1 - dx) + p11 * dx;
    return top * (1 - dy) + bottom * dy;
}

function parseFingerprintImageInput(image) {
    if (!image) {
        throw new Error('Missing image (base64 content)');
    }

    const value = String(image).trim();
    if (!value) {
        throw new Error('Missing image (base64 content)');
    }

    return value.includes(',')
        ? value.split(',')[1]
        : value;
}

async function createOriginalFingerprintPreview(imageBuffer) {
    return sharp(imageBuffer)
        .rotate()
        .removeAlpha()
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .greyscale()
        .png()
        .toBuffer();
}

async function prepareFingerprintInput(imageBuffer, traceContext = null, label = 'fingerprint', options = {}) {
    const originalPreview = await createOriginalFingerprintPreview(imageBuffer);
    const baseMetadata = await sharp(originalPreview).metadata();
    const sourceMetadata = await sharp(imageBuffer).metadata();
    const suppliedDpi = Number(options.inputDpi);
    const metadataDpi = Number(sourceMetadata.density);
    const dpi = Number.isFinite(suppliedDpi) && suppliedDpi > 0
        ? suppliedDpi
        : Number.isFinite(metadataDpi) && metadataDpi > 0
            ? metadataDpi
            : AFIS_CONFIG.academicMatchers.sourceAfisDpi;
    const dpiSource = Number.isFinite(suppliedDpi) && suppliedDpi > 0
        ? 'request metadata'
        : Number.isFinite(metadataDpi) && metadataDpi > 0
            ? 'image metadata'
            : 'configured SourceAFIS fallback';
    const trimmedAttempt = await sharp(originalPreview)
        .trim({
            background: { r: 255, g: 255, b: 255 },
            threshold: AFIS_CONFIG.enhancement.trimThreshold
        })
        .png()
        .toBuffer({ resolveWithObject: true });

    const trimmedIsUsable = trimmedAttempt.info.width >= 96 && trimmedAttempt.info.height >= 96;
    const cropBuffer = trimmedIsUsable ? trimmedAttempt.data : originalPreview;
    const inputSize = AFIS_CONFIG.enhancement.inputSize;

    let basicPreparationPipeline = sharp(cropBuffer)
        .resize(inputSize, inputSize, {
            fit: 'contain',
            position: 'centre',
            background: { r: 255, g: 255, b: 255 }
        });

    if (AFIS_CONFIG.enhancement.normalize) {
        basicPreparationPipeline = basicPreparationPipeline.normalize();
    }

    if (AFIS_CONFIG.enhancement.clahe) {
        basicPreparationPipeline = basicPreparationPipeline.clahe({
            width: AFIS_CONFIG.enhancement.claheWindow,
            height: AFIS_CONFIG.enhancement.claheWindow,
            maxSlope: AFIS_CONFIG.enhancement.claheMaxSlope
        });
    }

    if (AFIS_CONFIG.enhancement.sharpenSigma > 0) {
        basicPreparationPipeline = basicPreparationPipeline.sharpen({ sigma: AFIS_CONFIG.enhancement.sharpenSigma });
    }

    const normalizedPng = await basicPreparationPipeline
        .png()
        .toBuffer();

    // Median filtering is the authoritative denoising stage. It is deliberately
    // materialized as its own image so the exact bytes passed to ridge
    // enhancement can also be displayed and audited.
    const denoisedPng = AFIS_CONFIG.enhancement.medianSize > 1
        ? await sharp(normalizedPng).median(AFIS_CONFIG.enhancement.medianSize).png().toBuffer()
        : Buffer.from(normalizedPng);

    const normalizedInfo = await sharp(denoisedPng).metadata();
    logServiceEvent(traceContext, 'input_prepared', 'Prepared canonical fingerprint input for AFIS.', {
        label,
        originalWidth: baseMetadata.width || 0,
        originalHeight: baseMetadata.height || 0,
        croppedWidth: trimmedIsUsable ? trimmedAttempt.info.width : (baseMetadata.width || 0),
        croppedHeight: trimmedIsUsable ? trimmedAttempt.info.height : (baseMetadata.height || 0),
        normalizedWidth: normalizedInfo.width || inputSize,
        normalizedHeight: normalizedInfo.height || inputSize,
        trimmed: trimmedIsUsable,
        resizeFit: 'contain',
        claheApplied: !!AFIS_CONFIG.enhancement.clahe,
        medianSize: AFIS_CONFIG.enhancement.medianSize,
        dpi,
        dpiSource
    });

    return {
        originalPreview,
        normalizedPng: denoisedPng,
        denoisedPng,
        metadata: {
            originalWidth: baseMetadata.width || 0,
            originalHeight: baseMetadata.height || 0,
            croppedWidth: trimmedIsUsable ? trimmedAttempt.info.width : (baseMetadata.width || 0),
            croppedHeight: trimmedIsUsable ? trimmedAttempt.info.height : (baseMetadata.height || 0),
            normalizedWidth: normalizedInfo.width || inputSize,
            normalizedHeight: normalizedInfo.height || inputSize,
            trimmed: trimmedIsUsable,
            dpi,
            dpiSource
        },
        preprocessing: {
            originalPreviewPng: true,
            exifAutoRotate: true,
            alphaFlattened: true,
            grayscale: true,
            resizedToSquare: true,
            resizeFit: 'contain',
            trimApplied: trimmedIsUsable,
            trimThreshold: AFIS_CONFIG.enhancement.trimThreshold,
            medianFiltered: AFIS_CONFIG.enhancement.medianSize > 1,
            medianSize: AFIS_CONFIG.enhancement.medianSize,
            denoisingAlgorithm: AFIS_CONFIG.enhancement.medianSize > 1
                ? `${AFIS_CONFIG.enhancement.medianSize}x${AFIS_CONFIG.enhancement.medianSize} median filter`
                : 'disabled',
            normalizedContrast: !!AFIS_CONFIG.enhancement.normalize,
            claheApplied: !!AFIS_CONFIG.enhancement.clahe,
            claheWindow: AFIS_CONFIG.enhancement.claheWindow,
            claheMaxSlope: AFIS_CONFIG.enhancement.claheMaxSlope,
            sharpened: AFIS_CONFIG.enhancement.sharpenSigma > 0,
            inputSize
        }
    };
}

async function grayscaleFingerprintImage(imageBuffer) {
    const raw = await sharp(imageBuffer)
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

    return {
        width: raw.info.width,
        height: raw.info.height,
        pixels: Uint8Array.from(raw.data)
    };
}

function estimateBlockFrequency(pixels, width, height, centerX, centerY, orientation, halfSpan = 8) {
    const nx = -Math.sin(orientation);
    const ny = Math.cos(orientation);
    const profile = [];

    for (let i = -halfSpan; i <= halfSpan; i++) {
        profile.push(sampleGrayBilinear(pixels, width, height, centerX + nx * i, centerY + ny * i));
    }

    const mean = profile.reduce((sum, value) => sum + value, 0) / Math.max(1, profile.length);
    const centered = profile.map((value) => value - mean);
    let extrema = 0;
    for (let i = 1; i < centered.length - 1; i++) {
        const left = centered[i] - centered[i - 1];
        const right = centered[i] - centered[i + 1];
        if (left * right > 10) {
            extrema++;
        }
    }

    const cycles = extrema / 2;
    if (cycles <= 0) {
        return 0.12;
    }

    return clamp(cycles / Math.max(8, profile.length - 1), 0.06, 0.22);
}

function computeBlockFeatures(pixels, width, height) {
    const blockSize = AFIS_CONFIG.enhancement.blockSize;
    const blocksX = Math.ceil(width / blockSize);
    const blocksY = Math.ceil(height / blockSize);
    const orientation = createEmptyBlockMap(blocksX, blocksY, 0);
    const coherence = createEmptyBlockMap(blocksX, blocksY, 0);
    const frequency = createEmptyBlockMap(blocksX, blocksY, 0.12);
    const quality = createEmptyBlockMap(blocksX, blocksY, 0);
    const foreground = createEmptyBlockMap(blocksX, blocksY, 0);
    const mean = createEmptyBlockMap(blocksX, blocksY, 255);
    let foregroundBlocks = 0;

    for (let by = 0; by < blocksY; by++) {
        for (let bx = 0; bx < blocksX; bx++) {
            const xStart = bx * blockSize;
            const yStart = by * blockSize;
            const xEnd = Math.min(width - 1, xStart + blockSize);
            const yEnd = Math.min(height - 1, yStart + blockSize);
            let sum = 0;
            let sumSq = 0;
            let gx2 = 0;
            let gy2 = 0;
            let gxy = 0;
            let count = 0;

            for (let y = Math.max(1, yStart); y < Math.min(height - 1, yEnd); y++) {
                for (let x = Math.max(1, xStart); x < Math.min(width - 1, xEnd); x++) {
                    const idx = y * width + x;
                    const value = pixels[idx];
                    const gx = pixels[y * width + (x + 1)] - pixels[y * width + (x - 1)];
                    const gy = pixels[(y + 1) * width + x] - pixels[(y - 1) * width + x];
                    sum += value;
                    sumSq += value * value;
                    gx2 += gx * gx;
                    gy2 += gy * gy;
                    gxy += gx * gy;
                    count++;
                }
            }

            const blockIdx = getBlockIndex(blocksX, bx, by);
            if (count <= 0) {
                continue;
            }

            const avg = sum / count;
            const variance = Math.max(0, (sumSq / count) - avg * avg);
            const std = Math.sqrt(variance);
            const energy = gx2 + gy2;
            const coherenceValue = energy > 0
                ? Math.sqrt(((gx2 - gy2) * (gx2 - gy2)) + (4 * gxy * gxy)) / Math.max(1, energy)
                : 0;
            const theta = 0.5 * Math.atan2(2 * gxy, gx2 - gy2 || 1);
            const isForeground = std >= AFIS_CONFIG.enhancement.foregroundStdThreshold && energy > 5000;
            const frequencyValue = estimateBlockFrequency(
                pixels,
                width,
                height,
                xStart + ((xEnd - xStart) / 2),
                yStart + ((yEnd - yStart) / 2),
                theta
            );
            const contrastScore = clamp(std / 48, 0, 1);
            const qualityValue = clamp(
                ((contrastScore * 0.38) + (coherenceValue * 0.42) + (clamp(frequencyValue / 0.18, 0, 1) * 0.20)) * 100,
                5,
                99
            );

            orientation[blockIdx] = theta;
            coherence[blockIdx] = coherenceValue;
            frequency[blockIdx] = frequencyValue;
            quality[blockIdx] = isForeground ? qualityValue : Math.round(qualityValue * 0.25);
            foreground[blockIdx] = isForeground ? 1 : 0;
            mean[blockIdx] = avg;
            if (isForeground) {
                foregroundBlocks++;
            }
        }
    }

    return {
        blockSize,
        blocksX,
        blocksY,
        orientation,
        coherence,
        frequency,
        quality,
        foreground,
        mean,
        foregroundBlocks,
        totalBlocks: blocksX * blocksY
    };
}

function getBlockFeatureForPixel(blockFeatures, width, height, x, y) {
    const coords = getBlockCoordinates(width, height, blockFeatures.blockSize, x, y);
    const idx = getBlockIndex(coords.blocksX, coords.bx, coords.by);
    return {
        orientation: blockFeatures.orientation[idx],
        coherence: blockFeatures.coherence[idx],
        frequency: blockFeatures.frequency[idx],
        quality: blockFeatures.quality[idx],
        foreground: blockFeatures.foreground[idx],
        mean: blockFeatures.mean[idx]
    };
}

function getInterpolatedBlockFeatureForPixel(blockFeatures, width, height, x, y) {
    const gridX = (x / blockFeatures.blockSize) - 0.5;
    const gridY = (y / blockFeatures.blockSize) - 0.5;
    const bx0 = clamp(Math.floor(gridX), 0, blockFeatures.blocksX - 1);
    const by0 = clamp(Math.floor(gridY), 0, blockFeatures.blocksY - 1);
    const bx1 = clamp(bx0 + 1, 0, blockFeatures.blocksX - 1);
    const by1 = clamp(by0 + 1, 0, blockFeatures.blocksY - 1);
    const tx = clamp(gridX - Math.floor(gridX), 0, 1);
    const ty = clamp(gridY - Math.floor(gridY), 0, 1);
    const samples = [
        [bx0, by0, (1 - tx) * (1 - ty)],
        [bx1, by0, tx * (1 - ty)],
        [bx0, by1, (1 - tx) * ty],
        [bx1, by1, tx * ty]
    ];
    let orientationX = 0;
    let orientationY = 0;
    let coherence = 0;
    let frequency = 0;
    let quality = 0;
    let foregroundScore = 0;
    let mean = 0;

    for (const [bx, by, weight] of samples) {
        const index = getBlockIndex(blockFeatures.blocksX, bx, by);
        const theta = blockFeatures.orientation[index];
        // Double-angle interpolation respects the 180-degree ridge-axis
        // symmetry and prevents discontinuities between adjacent blocks.
        orientationX += Math.cos(2 * theta) * weight;
        orientationY += Math.sin(2 * theta) * weight;
        coherence += blockFeatures.coherence[index] * weight;
        frequency += blockFeatures.frequency[index] * weight;
        quality += blockFeatures.quality[index] * weight;
        foregroundScore += blockFeatures.foreground[index] * weight;
        mean += blockFeatures.mean[index] * weight;
    }

    return {
        orientation: 0.5 * Math.atan2(orientationY, orientationX),
        coherence,
        frequency,
        quality,
        foreground: foregroundScore >= 0.35 ? 1 : 0,
        foregroundScore,
        mean
    };
}

function applyGaborRidgeEnhancement(pixels, width, height, blockFeatures) {
    const enhanced = new Uint8Array(pixels.length);
    const radiusBase = AFIS_CONFIG.enhancement.gaborRadius;
    const gain = AFIS_CONFIG.enhancement.gaborGain;
    const sigma = Math.max(1.5, radiusBase / 1.75);
    const gamma = 0.65;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            const feature = getInterpolatedBlockFeatureForPixel(blockFeatures, width, height, x, y);
            if (!feature.foreground) {
                enhanced[idx] = pixels[idx];
                continue;
            }

            // The local orientation describes the ridge direction. A Gabor
            // carrier must oscillate across the ridges, so xPrime is aligned
            // with the local ridge normal and yPrime follows the ridge.
            const normalTheta = feature.orientation + (Math.PI / 2);
            const cosTheta = Math.cos(normalTheta);
            const sinTheta = Math.sin(normalTheta);
            const frequency = clamp(feature.frequency, 0.075, 0.16);
            let response = 0;
            let absoluteWeight = 0;

            for (let oy = -radiusBase; oy <= radiusBase; oy++) {
                for (let ox = -radiusBase; ox <= radiusBase; ox++) {
                    const xPrime = (ox * cosTheta) + (oy * sinTheta);
                    const yPrime = (-ox * sinTheta) + (oy * cosTheta);
                    const gaussian = Math.exp(-((xPrime * xPrime) + (gamma * gamma * yPrime * yPrime)) / (2 * sigma * sigma));
                    const weight = gaussian * Math.cos(2 * Math.PI * frequency * xPrime);
                    const sample = sampleGrayBilinear(pixels, width, height, x + ox, y + oy) - feature.mean;
                    response += sample * weight;
                    absoluteWeight += Math.abs(weight);
                }
            }

            const normalizedResponse = absoluteWeight > 0 ? response / absoluteWeight : 0;
            const coherenceGain = 0.65 + (feature.coherence * 0.55);
            const filteredValue = feature.mean + (normalizedResponse * gain * coherenceGain * 1.8);
            // Preserve weak real ridges while still letting the Gabor response
            // improve continuity. This avoids inventing block-shaped ridges.
            const blend = clamp(0.28 + (feature.coherence * 0.30), 0.28, 0.58);
            const value = (pixels[idx] * (1 - blend)) + (filteredValue * blend);
            enhanced[idx] = clamp(Math.round(value), 0, 255);
        }
    }

    return enhanced;
}

function adaptiveBinarize(pixels, width, height, blockFeatures) {
    const binary = new Uint8Array(pixels.length);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = y * width + x;
            const feature = getInterpolatedBlockFeatureForPixel(blockFeatures, width, height, x, y);
            if (!feature.foreground) {
                binary[idx] = 0;
                continue;
            }

            const threshold = feature.mean - (8 + (feature.coherence * 18) + (feature.quality * 0.05));
            binary[idx] = pixels[idx] < threshold ? 1 : 0;
        }
    }

    return binary;
}

function zhangSuenThin(binary, width, height) {
    const thinned = Uint8Array.from(binary);
    const maxIterations = AFIS_CONFIG.enhancement.thinningIterations;

    const transitions = (neighbors) => {
        let count = 0;
        for (let i = 0; i < neighbors.length; i++) {
            const curr = neighbors[i];
            const next = neighbors[(i + 1) % neighbors.length];
            if (curr === 0 && next === 1) {
                count++;
            }
        }
        return count;
    };

    const neighborSum = (neighbors) => neighbors.reduce((sum, value) => sum + value, 0);

    for (let iteration = 0; iteration < maxIterations; iteration++) {
        let changed = false;
        for (let phase = 0; phase < 2; phase++) {
            const toDelete = [];
            for (let y = 1; y < height - 1; y++) {
                for (let x = 1; x < width - 1; x++) {
                    const idx = y * width + x;
                    if (thinned[idx] !== 1) {
                        continue;
                    }

                    const p2 = thinned[(y - 1) * width + x];
                    const p3 = thinned[(y - 1) * width + (x + 1)];
                    const p4 = thinned[y * width + (x + 1)];
                    const p5 = thinned[(y + 1) * width + (x + 1)];
                    const p6 = thinned[(y + 1) * width + x];
                    const p7 = thinned[(y + 1) * width + (x - 1)];
                    const p8 = thinned[y * width + (x - 1)];
                    const p9 = thinned[(y - 1) * width + (x - 1)];
                    const neighbors = [p2, p3, p4, p5, p6, p7, p8, p9];
                    const count = neighborSum(neighbors);
                    const trans = transitions(neighbors);

                    if (count < 2 || count > 6 || trans !== 1) {
                        continue;
                    }

                    if (phase === 0) {
                        if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) {
                            continue;
                        }
                    } else {
                        if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) {
                            continue;
                        }
                    }

                    toDelete.push(idx);
                }
            }

            if (toDelete.length > 0) {
                changed = true;
                for (const idx of toDelete) {
                    thinned[idx] = 0;
                }
            }
        }

        if (!changed) {
            break;
        }
    }

    return thinned;
}

function ridgeNeighborPoints(binary, width, height, x, y) {
    const points = [];
    for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) {
                continue;
            }
            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
                continue;
            }
            if (binary[ny * width + nx] === 1) {
                points.push({ x: nx, y: ny });
            }
        }
    }
    return points;
}

function traceBranchLength(binary, width, height, originX, originY, nextX, nextY, maxSteps = 18) {
    let prevX = originX;
    let prevY = originY;
    let currentX = nextX;
    let currentY = nextY;
    let length = 1;
    const visited = new Set([`${originX},${originY}`, `${nextX},${nextY}`]);

    for (let step = 0; step < maxSteps; step++) {
        const nextPoints = ridgeNeighborPoints(binary, width, height, currentX, currentY)
            .filter((point) => !(point.x === prevX && point.y === prevY));

        if (nextPoints.length !== 1) {
            break;
        }

        const nextPoint = nextPoints[0];
        const key = `${nextPoint.x},${nextPoint.y}`;
        if (visited.has(key)) {
            break;
        }

        prevX = currentX;
        prevY = currentY;
        currentX = nextPoint.x;
        currentY = nextPoint.y;
        visited.add(key);
        length++;
    }

    return length;
}

function passesMinutiaBranchValidation(x, y, type, binary, width, height, config = AFIS_CONFIG.minutiae) {
    const neighbors = ridgeNeighborPoints(binary, width, height, x, y);
    if (type === 'ending') {
        if (neighbors.length < 1) {
            return false;
        }
        const branchLengths = neighbors.map((point) => traceBranchLength(
            binary,
            width,
            height,
            x,
            y,
            point.x,
            point.y,
            config.traceMaxSteps
        )).sort((a, b) => b - a);
        return branchLengths[0] >= config.endingMinTraceLength;
    }

    if (type === 'bifurcation') {
        if (neighbors.length < 3) {
            return false;
        }
        const branchLengths = neighbors.map((point) => traceBranchLength(
            binary,
            width,
            height,
            x,
            y,
            point.x,
            point.y,
            config.traceMaxSteps
        )).sort((a, b) => b - a);

        return branchLengths[0] >= config.bifurcationMinTraceLength
            && branchLengths[1] >= config.bifurcationMinTraceLength;
    }

    return false;
}

function countTransitions(neighbors) {
    let total = 0;
    for (let i = 0; i < neighbors.length; i++) {
        const current = neighbors[i];
        const next = neighbors[(i + 1) % neighbors.length];
        if (current === 0 && next === 1) {
            total++;
        }
    }
    return total;
}

function computeMinutiaOrientation(binary, width, height, x, y, type) {
    const branches = [];
    for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
            if (ox === 0 && oy === 0) {
                continue;
            }
            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
                continue;
            }
            if (binary[ny * width + nx] === 1) {
                branches.push(Math.atan2(oy, ox));
            }
        }
    }

    if (branches.length === 0) {
        return 0;
    }

    if (type === 'ending') {
        return branches[0];
    }

    let sx = 0;
    let sy = 0;
    for (const angle of branches) {
        sx += Math.cos(angle);
        sy += Math.sin(angle);
    }
    return Math.atan2(sy, sx);
}

function countRidgeSupport(binary, width, height, x, y, radius = 2) {
    let support = 0;
    for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
                continue;
            }
            support += binary[ny * width + nx];
        }
    }
    return support;
}

function computeMinutiaQuality(x, y, binary, width, height, blockFeatures) {
    const feature = getBlockFeatureForPixel(blockFeatures, width, height, x, y);
    const support = countRidgeSupport(binary, width, height, x, y);
    const borderDistance = Math.min(x, y, width - 1 - x, height - 1 - y);
    const borderScore = clamp(borderDistance / AFIS_CONFIG.minutiae.borderMargin, 0, 1) * 100;
    const supportScore = clamp((support - 3) / 12, 0, 1) * 100;
    return Math.round(clamp(
        (feature.quality * 0.50)
        + (feature.coherence * 100 * 0.25)
        + (supportScore * 0.15)
        + (borderScore * 0.10),
        0,
        100
    ));
}

function extractMinutiaePoints(thinnedBinary, width, height, blockFeatures, options = {}) {
    const points = [];
    const minDistSq = AFIS_CONFIG.minutiae.minDistance * AFIS_CONFIG.minutiae.minDistance;
    const minQuality = AFIS_CONFIG.minutiae.minQuality;
    const borderMargin = AFIS_CONFIG.minutiae.borderMargin;

    for (let y = borderMargin; y < height - borderMargin; y++) {
        for (let x = borderMargin; x < width - borderMargin; x++) {
            const idx = y * width + x;
            if (thinnedBinary[idx] !== 1) {
                continue;
            }

            const neighbors = ridgeNeighborRing(thinnedBinary, width, x, y);
            const ridgeCount = neighbors.reduce((sum, value) => sum + value, 0);
            if (ridgeCount < 1 || ridgeCount > 6) {
                continue;
            }

            // Preserve the historical Bozorth3 feed when requested. The legacy
            // path divided an already one-direction transition count by two.
            const crossingNumber = countTransitions(neighbors) / 2;
            const type = options.legacyCrossingNumber
                ? crossingNumber === 1
                    ? 'ending'
                    : crossingNumber === 3
                        ? 'bifurcation'
                        : null
                : classifyMinutiaByCrossingNumber(neighbors);
            if (!type) {
                continue;
            }

            const quality = computeMinutiaQuality(x, y, thinnedBinary, width, height, blockFeatures);
            if (quality < minQuality) {
                continue;
            }

            if (!passesMinutiaBranchValidation(x, y, type, thinnedBinary, width, height, AFIS_CONFIG.minutiae)) {
                continue;
            }

            let tooClose = false;
            for (let i = 0; i < points.length; i++) {
                const dx = points[i].x - x;
                const dy = points[i].y - y;
                if ((dx * dx + dy * dy) < minDistSq) {
                    if (points[i].quality < quality) {
                        points.splice(i, 1);
                    } else {
                        tooClose = true;
                    }
                    break;
                }
            }
            if (tooClose) {
                continue;
            }

            const feature = getBlockFeatureForPixel(blockFeatures, width, height, x, y);
            points.push({
                x,
                y,
                angle: computeMinutiaOrientation(thinnedBinary, width, height, x, y, type),
                type,
                quality,
                orientationCoherence: Math.round(feature.coherence * 100),
                localFrequency: Math.round(feature.frequency * 1000) / 1000
            });
        }
    }

    points.sort((a, b) => (b.quality - a.quality) || (b.orientationCoherence - a.orientationCoherence));
    return points.slice(0, AFIS_CONFIG.minutiae.maxPoints);
}

function buildPairwiseGeometryDescriptor(minutiae) {
    const distanceBins = AFIS_CONFIG.graph.distanceBins;
    const angleBins = AFIS_CONFIG.graph.angleBins;
    const distanceBinSize = AFIS_CONFIG.graph.distanceBinSize;
    const angleBinSize = AFIS_CONFIG.graph.angleBinSize;
    const distanceHist = new Array(distanceBins).fill(0);
    const angleHist = new Array(angleBins).fill(0);
    let totalWeight = 0;

    for (let i = 0; i < minutiae.length; i++) {
        for (let j = i + 1; j < minutiae.length; j++) {
            const a = minutiae[i];
            const b = minutiae[j];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const distance = Math.sqrt((dx * dx) + (dy * dy));
            const distanceBin = clamp(Math.floor(distance / distanceBinSize), 0, distanceBins - 1);
            const relativeAngle = Math.abs(angleDiffDeg(a.angle, b.angle));
            const angleBin = clamp(Math.floor(relativeAngle / angleBinSize), 0, angleBins - 1);
            const weight = Math.min(a.quality || 50, b.quality || 50) / 100;
            distanceHist[distanceBin] += weight;
            angleHist[angleBin] += weight;
            totalWeight += weight;
        }
    }

    return {
        distanceHist,
        angleHist,
        totalWeight
    };
}

function histogramIntersection(a, b) {
    const length = Math.min(a.length, b.length);
    let intersection = 0;
    let total = 0;
    for (let i = 0; i < length; i++) {
        intersection += Math.min(a[i], b[i]);
        total += Math.max(a[i], b[i]);
    }
    if (total <= 0) {
        return 0;
    }
    return Math.round((intersection / total) * 100);
}

function scoreSpatialRelationship(probeDescriptor, candidateDescriptor) {
    if (!probeDescriptor || !candidateDescriptor || probeDescriptor.totalWeight <= 0 || candidateDescriptor.totalWeight <= 0) {
        return 0;
    }

    const distanceScore = histogramIntersection(probeDescriptor.distanceHist, candidateDescriptor.distanceHist);
    const angleScore = histogramIntersection(probeDescriptor.angleHist, candidateDescriptor.angleHist);
    return Math.round((distanceScore * 0.58) + (angleScore * 0.42));
}

function estimateAfisQuality(minutiae, blockFeatures) {
    const minutiaeCount = Array.isArray(minutiae) ? minutiae.length : 0;
    const foregroundRatio = blockFeatures.totalBlocks > 0
        ? blockFeatures.foregroundBlocks / blockFeatures.totalBlocks
        : 0;
    let foregroundQualitySum = 0;
    let foregroundQualityCount = 0;
    for (let i = 0; i < blockFeatures.quality.length; i++) {
        if (blockFeatures.foreground[i]) {
            foregroundQualitySum += blockFeatures.quality[i];
            foregroundQualityCount++;
        }
    }
    const meanBlockQuality = foregroundQualityCount > 0 ? foregroundQualitySum / foregroundQualityCount : 0;
    const minutiaeQualityMean = minutiaeCount > 0
        ? minutiae.reduce((sum, minutia) => sum + (minutia.quality || 0), 0) / minutiaeCount
        : 0;
    const densityScore = clamp(minutiaeCount / 55, 0, 1) * 100;
    const quality = Math.round(clamp(
        (meanBlockQuality * 0.42)
        + (minutiaeQualityMean * 0.33)
        + (foregroundRatio * 100 * 0.15)
        + (densityScore * 0.10),
        20,
        99
    ));

    return {
        score: quality,
        meanBlockQuality: Math.round(meanBlockQuality),
        minutiaeQualityMean: Math.round(minutiaeQualityMean),
        foregroundRatio: Math.round(foregroundRatio * 100)
    };
}

async function rawToPngBuffer(pixels, width, height) {
    return sharp(Buffer.from(pixels), {
        raw: {
            width,
            height,
            channels: 1
        }
    }).png().toBuffer();
}

async function createMinutiaeOverlayBuffer(backgroundPng, minutiae, width, height) {
    const markers = minutiae.map((point) => {
        const color = point.type === 'bifurcation' ? '#2563eb' : '#dc2626';
        const imageX = Number.isFinite(Number(point.imageX)) ? Number(point.imageX) : point.x;
        const imageY = Number.isFinite(Number(point.imageY)) ? Number(point.imageY) : point.y;
        const imageAngle = Number.isFinite(Number(point.imageAngle)) ? Number(point.imageAngle) : (point.angle || 0);
        const directionX = imageX + (Math.cos(imageAngle) * 12);
        const directionY = imageY + (Math.sin(imageAngle) * 12);
        return `<g><circle cx="${imageX}" cy="${imageY}" r="4" fill="none" stroke="${color}" stroke-width="2"/><line x1="${imageX}" y1="${imageY}" x2="${directionX}" y2="${directionY}" stroke="${color}" stroke-width="2"/></g>`;
    }).join('');
    const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${markers}</svg>`);
    return sharp(backgroundPng).composite([{ input: overlay, blend: 'over' }]).png().toBuffer();
}

async function processFingerprintForAfis(imageBuffer, traceContext = null, options = {}) {
    const startedAt = Date.now();
    const label = traceContext?.label || 'fingerprint';
    logServiceEvent(traceContext, 'process_start', 'Starting AFIS preprocessing pipeline.', {
        label,
        inputBytes: imageBuffer?.length || 0
    });

    let preparedInput;
    if (options.skipPreparation) {
        const preparedMetadata = await sharp(imageBuffer).metadata();
        const suppliedDpi = Number(options.inputDpi);
        const metadataDpi = Number(preparedMetadata.density);
        const dpi = Number.isFinite(suppliedDpi) && suppliedDpi > 0
            ? suppliedDpi
            : Number.isFinite(metadataDpi) && metadataDpi > 0
                ? metadataDpi
                : AFIS_CONFIG.academicMatchers.sourceAfisDpi;
        preparedInput = {
            originalPreview: imageBuffer,
            normalizedPng: imageBuffer,
            denoisedPng: imageBuffer,
            metadata: {
                originalWidth: preparedMetadata.width || 0,
                originalHeight: preparedMetadata.height || 0,
                croppedWidth: preparedMetadata.width || 0,
                croppedHeight: preparedMetadata.height || 0,
                normalizedWidth: preparedMetadata.width || 0,
                normalizedHeight: preparedMetadata.height || 0,
                trimmed: false,
                dpi,
                dpiSource: Number.isFinite(suppliedDpi) && suppliedDpi > 0
                    ? 'request metadata'
                    : Number.isFinite(metadataDpi) && metadataDpi > 0
                        ? 'image metadata'
                        : 'configured SourceAFIS fallback'
            },
            preprocessing: {
                originalPreviewPng: true,
                grayscale: true,
                reusedPreparedInput: true,
                inputSize: preparedMetadata.width || AFIS_CONFIG.enhancement.inputSize
            }
        };
    } else {
        preparedInput = await prepareFingerprintInput(imageBuffer, traceContext, label, options);
    }

    if (options.modifiedBozorth3) {
        console.log(`[Modified Bozorth3] ${label} denoising started`);
    }
    const denoisedPng = preparedInput.denoisedPng || preparedInput.normalizedPng;
    if (options.modifiedBozorth3) {
        console.log(`[Modified Bozorth3] ${label} denoising completed`);
        console.log(`[Modified Bozorth3] ${label} denoising output image: in-memory PNG (${denoisedPng.length} bytes)`);
    }
    logServiceEvent(traceContext, 'denoising_complete', 'Median denoising completed and its output was selected for downstream processing.', {
        label,
        algorithm: preparedInput.preprocessing.denoisingAlgorithm || 'preprocessed input reused',
        outputField: 'denoisedImage',
        outputBytes: denoisedPng.length,
        durationMs: Date.now() - startedAt
    });

    const grayscale = await grayscaleFingerprintImage(denoisedPng);
    logServiceEvent(traceContext, 'grayscale_complete', 'Fingerprint converted to grayscale.', {
        label,
        width: grayscale.width,
        height: grayscale.height,
        durationMs: Date.now() - startedAt
    });

    const blockFeatures = computeBlockFeatures(grayscale.pixels, grayscale.width, grayscale.height);
    const foregroundBlocks = blockFeatures.foreground.reduce((sum, value) => sum + (value ? 1 : 0), 0);
    logServiceEvent(traceContext, 'block_analysis_complete', 'Computed block orientation, frequency, and foreground maps.', {
        label,
        blocksX: blockFeatures.blocksX,
        blocksY: blockFeatures.blocksY,
        foregroundBlocks,
        blockSize: blockFeatures.blockSize,
        durationMs: Date.now() - startedAt
    });

    if (options.modifiedBozorth3) {
        console.log(`[Modified Bozorth3] ${label} Gabor ridge enhancement started`);
    }
    const enhancedRaw = applyGaborRidgeEnhancement(grayscale.pixels, grayscale.width, grayscale.height, blockFeatures);
    if (options.modifiedBozorth3) {
        console.log(`[Modified Bozorth3] ${label} Gabor ridge enhancement completed`);
    }
    logServiceEvent(traceContext, 'gabor_enhancement_complete', 'Applied orientation- and frequency-adaptive Gabor ridge enhancement.', {
        label,
        gaborEnhanced: true,
        outputField: 'gaborEnhancedImage',
        durationMs: Date.now() - startedAt
    });

    const binary = adaptiveBinarize(enhancedRaw, grayscale.width, grayscale.height, blockFeatures);
    if (options.modifiedBozorth3) {
        console.log(`[Modified Bozorth3] ${label} binarization completed`);
    }
    logServiceEvent(traceContext, 'binarization_complete', 'Adaptive binarization completed.', {
        label,
        inputField: 'gaborEnhancedImage',
        outputField: 'binarizedImage',
        durationMs: Date.now() - startedAt
    });

    const thinned = zhangSuenThin(binary, grayscale.width, grayscale.height);
    if (options.modifiedBozorth3) {
        console.log(`[Modified Bozorth3] ${label} Zhang-Suen thinning completed`);
    }
    logServiceEvent(traceContext, 'thinning_complete', 'Zhang-Suen thinning completed.', {
        label,
        inputField: 'binarizedImage',
        outputField: 'thinnedImage',
        durationMs: Date.now() - startedAt
    });

    const crossingNumberMinutiae = extractMinutiaePoints(thinned, grayscale.width, grayscale.height, blockFeatures);
    let minutiae = crossingNumberMinutiae;
    let extractionDiagnostics = {
        engine: 'crossing-number',
        candidateCount: crossingNumberMinutiae.length,
        skeletonAccepted: crossingNumberMinutiae.length,
        skeletonRejected: 0,
        skeletonRadius: 0
    };
    if (options.modifiedBozorth3) {
        const mindtct = runMindtctExtractor({
            pixels: grayscale.pixels,
            width: grayscale.width,
            height: grayscale.height,
            ppi: preparedInput.metadata.dpi || 500,
            config: {
                executablePath: AFIS_CONFIG.mindtct.executablePath,
                cygwinBashPath: AFIS_CONFIG.cygwinBashPath,
                tempDir: SCANNER_RUNTIME_CONFIG.tempDir,
                timeoutMs: 30000
            }
        });
        const validated = filterMindtctMinutiaeBySkeleton(
            mindtct.minutiae,
            thinned,
            grayscale.width,
            grayscale.height,
            { radius: AFIS_CONFIG.mindtct.skeletonRadius }
        );
        minutiae = validated.accepted;
        extractionDiagnostics = {
            engine: mindtct.engineName,
            candidateCount: mindtct.minutiae.length,
            skeletonAccepted: validated.accepted.length,
            skeletonRejected: validated.rejected.length,
            skeletonRadius: validated.radius,
            execution: mindtct.execution
        };
    }
    const academicMinutiae = crossingNumberMinutiae;
    if (options.modifiedBozorth3) {
        console.log(`[Modified Bozorth3] ${label} minutiae extracted: ${minutiae.length}`);
    }
    logServiceEvent(traceContext, 'minutiae_extracted', 'Extracted and quality-scored minutiae.', {
        label,
        bozorth3CompatibleCount: minutiae.length,
        standardsCorrectedCount: academicMinutiae.length,
        extractionEngine: extractionDiagnostics.engine,
        candidateCount: extractionDiagnostics.candidateCount,
        skeletonAccepted: extractionDiagnostics.skeletonAccepted,
        skeletonRejected: extractionDiagnostics.skeletonRejected,
        skeletonRadius: extractionDiagnostics.skeletonRadius,
        topQuality: minutiae.length > 0 ? Math.max(...minutiae.map((item) => item.quality || 0)) : 0,
        durationMs: Date.now() - startedAt
    });

    const qualityMetrics = estimateAfisQuality(minutiae, blockFeatures);
    logServiceEvent(traceContext, 'quality_estimated', 'Estimated fingerprint quality metrics.', {
        label,
        quality: qualityMetrics.score,
        meanBlockQuality: qualityMetrics.meanBlockQuality,
        minutiaeQualityMean: qualityMetrics.minutiaeQualityMean,
        foregroundRatio: qualityMetrics.foregroundRatio,
        durationMs: Date.now() - startedAt
    });

    const enhancedPng = await rawToPngBuffer(enhancedRaw, grayscale.width, grayscale.height);
    const binaryForPng = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        binaryForPng[i] = binary[i] === 1 ? 0 : 255;
    }
    const binaryPng = await rawToPngBuffer(binaryForPng, grayscale.width, grayscale.height);
    const thinnedForPng = new Uint8Array(thinned.length);
    for (let i = 0; i < thinned.length; i++) {
        thinnedForPng[i] = thinned[i] === 1 ? 0 : 255;
    }
    const thinnedPng = await rawToPngBuffer(thinnedForPng, grayscale.width, grayscale.height);
    const minutiaeOverlayPng = await createMinutiaeOverlayBuffer(enhancedPng, minutiae, grayscale.width, grayscale.height);
    const geometryDescriptor = buildPairwiseGeometryDescriptor(minutiae);
    logServiceEvent(traceContext, 'process_complete', 'AFIS preprocessing pipeline completed.', {
        label,
        minutiaeCount: minutiae.length,
        quality: qualityMetrics.score,
        geometryPairs: geometryDescriptor.totalPairs,
        totalDurationMs: Date.now() - startedAt
    });

    return {
        width: grayscale.width,
        height: grayscale.height,
        image: preparedInput.normalizedPng.toString('base64'),
        originalImage: preparedInput.originalPreview.toString('base64'),
        normalizedImage: preparedInput.normalizedPng.toString('base64'),
        denoisedImage: denoisedPng.toString('base64'),
        enhancedImage: enhancedPng.toString('base64'),
        gaborEnhancedImage: enhancedPng.toString('base64'),
        binarizedImage: binaryPng.toString('base64'),
        thinnedImage: thinnedPng.toString('base64'),
        minutiaeOverlayImage: minutiaeOverlayPng.toString('base64'),
        minutiae,
        academicMinutiae,
        quality: qualityMetrics.score,
        qualityMetrics,
        blockMetrics: {
            blockSize: blockFeatures.blockSize,
            foregroundRatio: qualityMetrics.foregroundRatio,
            meanBlockQuality: qualityMetrics.meanBlockQuality
        },
        orientationField: blockFeatures.orientation,
        frequencyField: blockFeatures.frequency,
        coherenceField: blockFeatures.coherence,
        foregroundMap: blockFeatures.foreground,
        blocksX: blockFeatures.blocksX,
        blocksY: blockFeatures.blocksY,
        geometryDescriptor,
        preprocessing: {
            ...preparedInput.preprocessing,
            denoised: true,
            denoisingAlgorithm: preparedInput.preprocessing.denoisingAlgorithm || 'preprocessed input reused',
            gaborEnhanced: true,
            gaborImplementation: 'orientation- and frequency-adaptive spatial Gabor convolution',
            binarized: true,
            zhangSuenThinned: true,
            orientationFrequencyAnalysis: true,
            minutiaeQualityScored: true,
            falseMinutiaeFiltered: true,
            mindtctCandidatesExtracted: options.modifiedBozorth3 === true,
            skeletonValidated: options.modifiedBozorth3 === true,
            minutiaeExtractionEngine: extractionDiagnostics.engine,
            minutiaeExtractionDiagnostics: extractionDiagnostics,
            stages: [
                'grayscale',
                'denoising',
                'gabor-ridge-enhancement',
                'binarization',
                'zhang-suen-thinning',
                options.modifiedBozorth3 ? 'nist-mindtct-candidate-extraction' : 'crossing-number-minutiae-extraction',
                options.modifiedBozorth3 ? 'zhang-suen-skeleton-validation' : 'crossing-number-validation',
                'bozorth3-matching'
            ]
        },
        inputMetrics: preparedInput.metadata
    };
}

function toBozorthXyt(minutiae) {
    return minutiae.map((m) => {
        const theta = Math.round(((m.angle * 180) / Math.PI + 360) % 360);
        return `${m.x} ${m.y} ${theta}`;
    }).join(os.EOL) + os.EOL;
}

function matchMinutiaeFallback(probeMinutiae, candidateMinutiae) {
    let closeWeight = 0;
    let totalWeight = 0;
    for (const p of probeMinutiae) {
        const probeWeight = clamp((p.quality || 50) / 100, 0.2, 1);
        totalWeight += probeWeight;
        const found = candidateMinutiae.some((c) => {
            const dx = p.x - c.x;
            const dy = p.y - c.y;
            const da = angleDiffDeg(p.angle, c.angle);
            const qualityCompatible = Math.abs((p.quality || 50) - (c.quality || 50)) <= 35;
            return (dx * dx + dy * dy) <= 196 && da <= 25 && qualityCompatible;
        });
        if (found) {
            closeWeight += probeWeight;
        }
    }

    if (totalWeight <= 0) {
        return 0;
    }

    return Math.round((closeWeight / totalWeight) * 100);
}

function computeCentroid(minutiae) {
    if (!Array.isArray(minutiae) || minutiae.length === 0) {
        return { x: 0, y: 0 };
    }
    let sx = 0;
    let sy = 0;
    for (const m of minutiae) {
        sx += Number(m.x) || 0;
        sy += Number(m.y) || 0;
    }
    return { x: sx / minutiae.length, y: sy / minutiae.length };
}

function rotateAroundPoint(x, y, centerX, centerY, rotation) {
    const dx = x - centerX;
    const dy = y - centerY;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return {
        x: (dx * cos) - (dy * sin) + centerX,
        y: (dx * sin) + (dy * cos) + centerY
    };
}

function transformAlignedMinutia(minutia, transform) {
    if (!transform) {
        return {
            x: minutia.x,
            y: minutia.y,
            angle: minutia.angle
        };
    }

    const rotated = rotateAroundPoint(minutia.x, minutia.y, transform.center.x, transform.center.y, transform.rotation);
    return {
        x: rotated.x + transform.translation.x,
        y: rotated.y + transform.translation.y,
        angle: normalizeAngleRad(minutia.angle + transform.rotation)
    };
}

function buildMinutiaDescriptors(minutiae, neighborCount = AFIS_CONFIG.minutiae.descriptorNeighbors) {
    if (!Array.isArray(minutiae) || minutiae.length === 0) {
        return [];
    }

    return minutiae.map((minutia, index) => {
        const neighbors = [];
        for (let j = 0; j < minutiae.length; j++) {
            if (j === index) {
                continue;
            }
            const other = minutiae[j];
            const dx = other.x - minutia.x;
            const dy = other.y - minutia.y;
            const distance = Math.sqrt((dx * dx) + (dy * dy));
            neighbors.push({
                distance,
                relativeAngle: normalizeAngleRad(Math.atan2(dy, dx) - minutia.angle),
                orientationGap: angleDiffDeg(minutia.angle, other.angle),
                sameType: minutia.type === other.type ? 1 : 0
            });
        }

        neighbors.sort((a, b) => a.distance - b.distance);
        return neighbors.slice(0, neighborCount);
    });
}

function computeDescriptorSimilarity(probeDescriptor, candidateDescriptor) {
    if (!Array.isArray(probeDescriptor) || !Array.isArray(candidateDescriptor) || probeDescriptor.length === 0 || candidateDescriptor.length === 0) {
        return 0;
    }

    const count = Math.min(probeDescriptor.length, candidateDescriptor.length);
    let weightedScore = 0;
    let weightTotal = 0;

    for (let i = 0; i < count; i++) {
        const probeNeighbor = probeDescriptor[i];
        const candidateNeighbor = candidateDescriptor[i];
        const distScore = 1 - clamp(Math.abs(probeNeighbor.distance - candidateNeighbor.distance) / 40, 0, 1);
        const angleScore = 1 - clamp(Math.abs(angleDiffRad(probeNeighbor.relativeAngle, candidateNeighbor.relativeAngle)) / (Math.PI / 2), 0, 1);
        const orientationScore = 1 - clamp(Math.abs(probeNeighbor.orientationGap - candidateNeighbor.orientationGap) / 60, 0, 1);
        const typeScore = probeNeighbor.sameType === candidateNeighbor.sameType ? 1 : 0.5;
        const weight = Math.max(0.3, 1 - (i * 0.12));
        weightedScore += ((distScore * 0.38) + (angleScore * 0.32) + (orientationScore * 0.20) + (typeScore * 0.10)) * weight;
        weightTotal += weight;
    }

    if (weightTotal <= 0) {
        return 0;
    }

    return Math.round((weightedScore / weightTotal) * 100);
}

function scoreTransformSupport(probeMinutiae, candidateMinutiae, transform, options) {
    let totalWeight = 0;
    let matchedWeight = 0;
    const distanceSq = options.distancePx * options.distancePx;

    for (const probe of probeMinutiae) {
        const probeWeight = clamp((probe.quality || 50) / 100, 0.2, 1);
        totalWeight += probeWeight;
        const found = candidateMinutiae.some((candidate) => {
            if (options.requireType && probe.type && candidate.type && probe.type !== candidate.type) {
                return false;
            }
            const transformed = transformAlignedMinutia(candidate, transform);
            const dx = probe.x - transformed.x;
            const dy = probe.y - transformed.y;
            const da = angleDiffDeg(probe.angle, transformed.angle);
            const qualityGap = Math.abs((probe.quality || 50) - (candidate.quality || 50));
            return (dx * dx + dy * dy) <= distanceSq && da <= options.angleDeg && qualityGap <= 45;
        });
        if (found) {
            matchedWeight += probeWeight;
        }
    }

    if (totalWeight <= 0) {
        return 0;
    }

    return Math.round((matchedWeight / totalWeight) * 100);
}

function estimateAlignmentTransform(probeMinutiae, candidateMinutiae, options = AFIS_CONFIG.alignment) {
    if (!options?.enabled || !Array.isArray(probeMinutiae) || !Array.isArray(candidateMinutiae) || probeMinutiae.length === 0 || candidateMinutiae.length === 0) {
        return null;
    }

    const topLimit = Math.max(6, options.topCandidates || 18);
    const probeTop = [...probeMinutiae].sort((a, b) => (b.quality || 0) - (a.quality || 0)).slice(0, topLimit);
    const candidateTop = [...candidateMinutiae].sort((a, b) => (b.quality || 0) - (a.quality || 0)).slice(0, topLimit);
    const candidateCenter = computeCentroid(candidateTop);
    let bestTransform = null;
    let bestScore = -1;

    for (const probe of probeTop) {
        for (const candidate of candidateTop) {
            if (probe.type && candidate.type && probe.type !== candidate.type) {
                continue;
            }

            const rotation = normalizeAngleRad(probe.angle - candidate.angle);
            if (angleDiffDeg(rotation, 0) > options.maxAngleDeg) {
                continue;
            }

            const rotatedCandidate = rotateAroundPoint(candidate.x, candidate.y, candidateCenter.x, candidateCenter.y, rotation);
            const transform = {
                rotation,
                center: candidateCenter,
                translation: {
                    x: probe.x - rotatedCandidate.x,
                    y: probe.y - rotatedCandidate.y
                }
            };
            const score = scoreTransformSupport(probeMinutiae, candidateMinutiae, transform, {
                distancePx: options.distancePx,
                angleDeg: options.angleDeg,
                requireType: true
            });
            if (score > bestScore) {
                bestScore = score;
                bestTransform = {
                    ...transform,
                    score
                };
            }
        }
    }

    return bestTransform;
}

function scoreLocalStructureAgreement(probeMinutiae, candidateMinutiae, transform = null, options = AFIS_CONFIG.localStructure) {
    if (!options?.enabled || !Array.isArray(probeMinutiae) || !Array.isArray(candidateMinutiae) || probeMinutiae.length === 0 || candidateMinutiae.length === 0) {
        return 0;
    }

    const probeDescriptors = buildMinutiaDescriptors(probeMinutiae, options.descriptorNeighbors);
    const candidateDescriptors = buildMinutiaDescriptors(candidateMinutiae, options.descriptorNeighbors);
    const distanceSq = options.distancePx * options.distancePx;
    let totalWeight = 0;
    let matchedWeight = 0;

    for (let i = 0; i < probeMinutiae.length; i++) {
        const probe = probeMinutiae[i];
        const probeWeight = clamp((probe.quality || 50) / 100, 0.2, 1);
        totalWeight += probeWeight;
        let bestScore = 0;

        for (let j = 0; j < candidateMinutiae.length; j++) {
            const candidate = candidateMinutiae[j];
            if (probe.type && candidate.type && probe.type !== candidate.type) {
                continue;
            }
            const transformed = transformAlignedMinutia(candidate, transform);
            const dx = probe.x - transformed.x;
            const dy = probe.y - transformed.y;
            if ((dx * dx + dy * dy) > distanceSq) {
                continue;
            }
            if (angleDiffDeg(probe.angle, transformed.angle) > options.angleDeg) {
                continue;
            }

            const spatialDistanceScore = 1 - clamp(Math.sqrt((dx * dx) + (dy * dy)) / options.distancePx, 0, 1);
            const spatialAngleScore = 1 - clamp(angleDiffDeg(probe.angle, transformed.angle) / options.angleDeg, 0, 1);
            const descriptorScore = computeDescriptorSimilarity(probeDescriptors[i], candidateDescriptors[j]);
            const combinedScore = Math.round(
                ((descriptorScore * 0.68) + ((spatialDistanceScore * 100) * 0.20) + ((spatialAngleScore * 100) * 0.12))
            );
            if (combinedScore > bestScore) {
                bestScore = combinedScore;
            }
        }

        matchedWeight += probeWeight * (bestScore / 100);
    }

    if (totalWeight <= 0) {
        return 0;
    }

    return Math.round((matchedWeight / totalWeight) * 100);
}

function collectAlignedPairMatches(probeMinutiae, candidateMinutiae, transform = null, options = AFIS_CONFIG.bozorthEnhancement) {
    if (!options?.enabled || !Array.isArray(probeMinutiae) || !Array.isArray(candidateMinutiae) || probeMinutiae.length === 0 || candidateMinutiae.length === 0) {
        return {
            pairs: [],
            pairCount: 0,
            coverageScore: 0,
            pairScore: 0,
            descriptorScore: 0
        };
    }

    const probeDescriptors = buildMinutiaDescriptors(probeMinutiae, AFIS_CONFIG.minutiae.descriptorNeighbors);
    const candidateDescriptors = buildMinutiaDescriptors(candidateMinutiae, AFIS_CONFIG.minutiae.descriptorNeighbors);
    const pairCandidates = [];

    for (let i = 0; i < probeMinutiae.length; i++) {
        const probe = probeMinutiae[i];
        for (let j = 0; j < candidateMinutiae.length; j++) {
            const candidate = candidateMinutiae[j];
            if (probe.type && candidate.type && probe.type !== candidate.type) {
                continue;
            }

            const transformed = transformAlignedMinutia(candidate, transform);
            const dx = probe.x - transformed.x;
            const dy = probe.y - transformed.y;
            const distance = Math.sqrt((dx * dx) + (dy * dy));
            if (distance > options.distancePx) {
                continue;
            }

            const angleGap = angleDiffDeg(probe.angle, transformed.angle);
            if (angleGap > options.angleDeg) {
                continue;
            }

            const descriptorScore = computeDescriptorSimilarity(probeDescriptors[i], candidateDescriptors[j]);
            const distanceScore = 1 - clamp(distance / options.distancePx, 0, 1);
            const angleScore = 1 - clamp(angleGap / options.angleDeg, 0, 1);
            const qualityGap = Math.abs((probe.quality || 50) - (candidate.quality || 50));
            const qualityScore = 1 - clamp(qualityGap / 50, 0, 1);
            const pairScore = Math.round(
                (descriptorScore * 0.42)
                + ((distanceScore * 100) * 0.22)
                + ((angleScore * 100) * 0.16)
                + ((qualityScore * 100) * 0.10)
                + ((probe.type === candidate.type ? 100 : 70) * 0.10)
            );

            if (pairScore < options.pairMinScore) {
                continue;
            }

            pairCandidates.push({
                probeIndex: i,
                candidateIndex: j,
                score: pairScore,
                descriptorScore,
                probe,
                candidate,
                transformed
            });
        }
    }

    pairCandidates.sort((a, b) => b.score - a.score);
    const usedProbe = new Set();
    const usedCandidate = new Set();
    const pairs = [];

    for (const candidatePair of pairCandidates) {
        if (usedProbe.has(candidatePair.probeIndex) || usedCandidate.has(candidatePair.candidateIndex)) {
            continue;
        }
        usedProbe.add(candidatePair.probeIndex);
        usedCandidate.add(candidatePair.candidateIndex);
        pairs.push(candidatePair);
    }

    if (pairs.length === 0) {
        return {
            pairs: [],
            pairCount: 0,
            coverageScore: 0,
            pairScore: 0,
            descriptorScore: 0
        };
    }

    const pairScore = Math.round(pairs.reduce((total, pair) => total + pair.score, 0) / pairs.length);
    const descriptorScore = Math.round(pairs.reduce((total, pair) => total + pair.descriptorScore, 0) / pairs.length);
    const coverageScore = Math.round(clamp(
        (pairs.length / Math.max(1, Math.min(probeMinutiae.length, candidateMinutiae.length))) * 100,
        0,
        100
    ));

    return {
        pairs,
        pairCount: pairs.length,
        coverageScore,
        pairScore,
        descriptorScore
    };
}

function scorePairCompatibilityGraph(matchedPairs, options = AFIS_CONFIG.bozorthEnhancement) {
    if (!Array.isArray(matchedPairs) || matchedPairs.length < 2) {
        return 0;
    }

    const edgeDistanceTolerance = Math.max(8, options.edgeDistanceTolerance || 22);
    const edgeAngleRad = (Math.max(8, options.edgeAngleDeg || 24) * Math.PI) / 180;
    const edgeOrientationTolerance = Math.max(10, options.edgeOrientationDeg || 28);
    let weightTotal = 0;
    let compatibleWeight = 0;

    for (let i = 0; i < matchedPairs.length; i++) {
        for (let j = i + 1; j < matchedPairs.length; j++) {
            const a = matchedPairs[i];
            const b = matchedPairs[j];
            const probeDx = b.probe.x - a.probe.x;
            const probeDy = b.probe.y - a.probe.y;
            const candidateDx = b.transformed.x - a.transformed.x;
            const candidateDy = b.transformed.y - a.transformed.y;
            const probeDistance = Math.sqrt((probeDx * probeDx) + (probeDy * probeDy));
            const candidateDistance = Math.sqrt((candidateDx * candidateDx) + (candidateDy * candidateDy));
            const probeEdgeAngle = Math.atan2(probeDy, probeDx);
            const candidateEdgeAngle = Math.atan2(candidateDy, candidateDx);
            const probeOrientationGap = angleDiffDeg(a.probe.angle, b.probe.angle);
            const candidateOrientationGap = angleDiffDeg(a.transformed.angle, b.transformed.angle);
            const distanceScore = 1 - clamp(Math.abs(probeDistance - candidateDistance) / edgeDistanceTolerance, 0, 1);
            const edgeAngleScore = 1 - clamp(Math.abs(angleDiffRad(probeEdgeAngle, candidateEdgeAngle)) / edgeAngleRad, 0, 1);
            const orientationScore = 1 - clamp(Math.abs(probeOrientationGap - candidateOrientationGap) / edgeOrientationTolerance, 0, 1);
            const pairWeight = clamp(((a.score || 0) + (b.score || 0)) / 200, 0.2, 1);
            const compatibility = ((distanceScore * 0.40) + (edgeAngleScore * 0.35) + (orientationScore * 0.25)) * pairWeight;
            weightTotal += pairWeight;
            compatibleWeight += compatibility;
        }
    }

    if (weightTotal <= 0) {
        return 0;
    }

    return Math.round(clamp((compatibleWeight / weightTotal) * 100, 0, 100));
}

function computeEnhancedBozorthScore(baseScore, probeMinutiae, candidateMinutiae, transform = null, options = AFIS_CONFIG.bozorthEnhancement) {
    const rawNormalizedScore = clamp(Math.round(baseScore || 0), 0, 100);
    if (!options?.enabled) {
        return {
            rawNormalizedScore,
            score: rawNormalizedScore,
            pairCount: 0,
            coverageScore: 0,
            pairScore: 0,
            descriptorScore: 0,
            graphScore: 0
        };
    }

    const matchedPairs = collectAlignedPairMatches(probeMinutiae, candidateMinutiae, transform, options);
    const graphScore = scorePairCompatibilityGraph(matchedPairs.pairs, options);
    const weightTotal = Math.max(
        0.1,
        (options.rawWeight || 0)
        + (options.pairWeight || 0)
        + (options.coverageWeight || 0)
        + (options.graphWeight || 0)
    );
    const enhancedScore = Math.round(clamp(
        (
            (rawNormalizedScore * (options.rawWeight || 0))
            + (matchedPairs.pairScore * (options.pairWeight || 0))
            + (matchedPairs.coverageScore * (options.coverageWeight || 0))
            + (graphScore * (options.graphWeight || 0))
        ) / weightTotal,
        0,
        100
    ));

    return {
        rawNormalizedScore,
        score: enhancedScore,
        pairCount: matchedPairs.pairCount,
        coverageScore: matchedPairs.coverageScore,
        pairScore: matchedPairs.pairScore,
        descriptorScore: matchedPairs.descriptorScore,
        graphScore
    };
}

function oneWayConsistencyScore(probeMinutiae, candidateMinutiae, options, shift = { x: 0, y: 0 }) {
    let totalWeight = 0;
    let closeWeight = 0;
    const distanceSq = options.distancePx * options.distancePx;

    for (const p of probeMinutiae) {
        const probeWeight = clamp((p.quality || 50) / 100, 0.2, 1);
        totalWeight += probeWeight;
        const found = candidateMinutiae.some((c) => {
            if (options.requireType && p.type && c.type && p.type !== c.type) {
                return false;
            }
            const shiftedX = c.x + shift.x;
            const shiftedY = c.y + shift.y;
            const dx = p.x - shiftedX;
            const dy = p.y - shiftedY;
            const da = angleDiffDeg(p.angle, c.angle);
            const qualityGap = Math.abs((p.quality || 50) - (c.quality || 50));
            return (dx * dx + dy * dy) <= distanceSq && da <= options.angleDeg && qualityGap <= 40;
        });
        if (found) {
            closeWeight += probeWeight;
        }
    }

    if (totalWeight <= 0) {
        return 0;
    }

    return Math.round((closeWeight / totalWeight) * 100);
}

function computeMinutiaeConsistency(probeMinutiae, candidateMinutiae, options = AFIS_CONFIG.consistency) {
    if (!Array.isArray(probeMinutiae) || !Array.isArray(candidateMinutiae) || probeMinutiae.length === 0 || candidateMinutiae.length === 0) {
        return {
            score: 0,
            forward: 0,
            reverse: 0,
            forwardCentered: 0,
            reverseCentered: 0
        };
    }

    const forward = oneWayConsistencyScore(probeMinutiae, candidateMinutiae, options);
    const reverse = oneWayConsistencyScore(candidateMinutiae, probeMinutiae, options);

    let forwardCentered = forward;
    let reverseCentered = reverse;
    if (options.useCentroidShift) {
        const pc = computeCentroid(probeMinutiae);
        const cc = computeCentroid(candidateMinutiae);
        const shiftProbeFromCand = { x: pc.x - cc.x, y: pc.y - cc.y };
        const shiftCandFromProbe = { x: cc.x - pc.x, y: cc.y - pc.y };
        forwardCentered = oneWayConsistencyScore(probeMinutiae, candidateMinutiae, options, shiftProbeFromCand);
        reverseCentered = oneWayConsistencyScore(candidateMinutiae, probeMinutiae, options, shiftCandFromProbe);
    }

    const score = Math.max(
        Math.round((forward + reverse) / 2),
        Math.round((forwardCentered + reverseCentered) / 2)
    );

    return {
        score,
        forward,
        reverse,
        forwardCentered,
        reverseCentered
    };
}

function computeAlignedMinutiaeConsistency(probeMinutiae, candidateMinutiae, forwardTransform, reverseTransform = null, options = AFIS_CONFIG.consistency) {
    if (!forwardTransform) {
        return {
            score: 0,
            forward: 0,
            reverse: 0
        };
    }

    const forward = scoreTransformSupport(probeMinutiae, candidateMinutiae, forwardTransform, options);
    const reverse = reverseTransform
        ? scoreTransformSupport(candidateMinutiae, probeMinutiae, reverseTransform, options)
        : forward;
    return {
        score: Math.round((forward + reverse) / 2),
        forward,
        reverse
    };
}

function computeOrientationFrequencyAgreement(probe, candidate) {
    if (!probe || !candidate || probe.blocksX !== candidate.blocksX || probe.blocksY !== candidate.blocksY) {
        return {
            orientationScore: 0,
            frequencyScore: 0,
            overlapRatio: 0,
            combined: 0
        };
    }

    let overlap = 0;
    let probeForeground = 0;
    let candidateForeground = 0;
    let orientationWeighted = 0;
    let frequencyWeighted = 0;
    let weightTotal = 0;

    for (let i = 0; i < probe.foregroundMap.length; i++) {
        if (probe.foregroundMap[i]) probeForeground++;
        if (candidate.foregroundMap[i]) candidateForeground++;
        if (!probe.foregroundMap[i] || !candidate.foregroundMap[i]) {
            continue;
        }

        overlap++;
        const blockWeight = Math.min(
            clamp((probe.coherenceField[i] || 0), 0, 1),
            clamp((candidate.coherenceField[i] || 0), 0, 1)
        ) * Math.min(
            clamp((probe.blockMetrics.meanBlockQuality || 50) / 100, 0.2, 1),
            clamp((candidate.blockMetrics.meanBlockQuality || 50) / 100, 0.2, 1)
        );
        const orientationDelta = Math.min(90, angleDiffDeg(probe.orientationField[i] || 0, candidate.orientationField[i] || 0));
        const frequencyDelta = Math.abs((probe.frequencyField[i] || 0.12) - (candidate.frequencyField[i] || 0.12));
        orientationWeighted += blockWeight * (1 - (orientationDelta / 90));
        frequencyWeighted += blockWeight * (1 - clamp(frequencyDelta / 0.12, 0, 1));
        weightTotal += blockWeight;
    }

    const overlapRatio = Math.max(probeForeground, candidateForeground) > 0
        ? overlap / Math.max(probeForeground, candidateForeground)
        : 0;
    const orientationScore = weightTotal > 0 ? Math.round((orientationWeighted / weightTotal) * 100) : 0;
    const frequencyScore = weightTotal > 0 ? Math.round((frequencyWeighted / weightTotal) * 100) : 0;
    return {
        orientationScore,
        frequencyScore,
        overlapRatio: Math.round(overlapRatio * 100) / 100,
        combined: Math.round((orientationScore * 0.62) + (frequencyScore * 0.38))
    };
}

function computeAdaptiveMinutiaeRequirement(probe, candidate, overlapRatio, matcherConfig = AFIS_CONFIG) {
    const base = matcherConfig.minutiae.minRequiredForMatch;
    const qualityMean = ((probe.quality || 0) + (candidate.quality || 0)) / 2;
    let requirement = base;
    if (qualityMean >= 82 && overlapRatio <= 0.55) {
        requirement -= 6;
    } else if (qualityMean >= 72 && overlapRatio <= 0.68) {
        requirement -= 4;
    }
    if (qualityMean < 60) {
        requirement += 4;
    }
    return clamp(Math.round(requirement), 14, 30);
}

function computeAdaptiveThreshold(baseThreshold, probe, candidate, overlapRatio, minutiaeCountScore, matcherConfig = AFIS_CONFIG) {
    const cfg = matcherConfig.thresholding;
    const qualityMean = ((probe.quality || 0) + (candidate.quality || 0)) / 2;
    let threshold = baseThreshold;

    if (qualityMean < 72) {
        threshold += cfg.lowQualityPenalty * ((72 - qualityMean) / 32);
    } else if (qualityMean > 88) {
        threshold -= cfg.highQualityBonus * ((qualityMean - 88) / 12);
    }

    if (overlapRatio < 0.60) {
        threshold += cfg.lowOverlapPenalty * ((0.60 - overlapRatio) / 0.60);
    }

    if (minutiaeCountScore < 1) {
        threshold += cfg.lowMinutiaePenalty * (1 - minutiaeCountScore);
    }

    return Math.round(clamp(threshold, cfg.minThreshold, cfg.maxThreshold));
}

function computeQualityConfidence(probe, candidate) {
    const probeQuality = probe.qualityMetrics || {};
    const candidateQuality = candidate.qualityMetrics || {};
    const mean = ((probe.quality || 0) + (candidate.quality || 0)) / 2;
    const blockQuality = ((probeQuality.meanBlockQuality || 0) + (candidateQuality.meanBlockQuality || 0)) / 2;
    const minutiaeQuality = ((probeQuality.minutiaeQualityMean || 0) + (candidateQuality.minutiaeQualityMean || 0)) / 2;
    return Math.round(clamp((mean * 0.40) + (blockQuality * 0.30) + (minutiaeQuality * 0.30), 0, 100));
}

function compareWithBozorth3(probeMinutiae, candidateMinutiae) {
    try {
        const isLinuxPath = AFIS_CONFIG.bozorth3Path.startsWith('/');
        const canUseCygwin = isLinuxPath && fs.existsSync(AFIS_CONFIG.cygwinBashPath);
        const nativeExists = fs.existsSync(AFIS_CONFIG.bozorth3Path);
        if (!nativeExists && !canUseCygwin) {
            const fallbackScore = matchMinutiaeFallback(probeMinutiae, candidateMinutiae);
            return {
                score: fallbackScore,
                algorithm: 'fallback',
                rawOutput: 'bozorth3 executable not found'
            };
        }

        const probeFile = path.join(SCANNER_RUNTIME_CONFIG.tempDir, `probe_${Date.now()}_${Math.random().toString(16).slice(2)}.xyt`);
        const candidateFile = path.join(SCANNER_RUNTIME_CONFIG.tempDir, `cand_${Date.now()}_${Math.random().toString(16).slice(2)}.xyt`);
        fs.writeFileSync(probeFile, toBozorthXyt(probeMinutiae), 'utf8');
        fs.writeFileSync(candidateFile, toBozorthXyt(candidateMinutiae), 'utf8');

        let run;
        if (canUseCygwin) {
            const toCygwinPath = (p) => {
                const normalized = p.replace(/\\/g, '/');
                const m = normalized.match(/^([A-Za-z]):\/(.*)$/);
                return m ? `/cygdrive/${m[1].toLowerCase()}/${m[2]}` : normalized;
            };
            const cmd = `${AFIS_CONFIG.bozorth3Path} "${toCygwinPath(probeFile)}" "${toCygwinPath(candidateFile)}"`;
            run = spawnSync(AFIS_CONFIG.cygwinBashPath, ['-lc', cmd], {
                encoding: 'utf8',
                timeout: 10000
            });
        } else {
            run = spawnSync(AFIS_CONFIG.bozorth3Path, [probeFile, candidateFile], {
                encoding: 'utf8',
                timeout: 10000
            });
        }

        fs.unlinkSync(probeFile);
        fs.unlinkSync(candidateFile);

        const output = `${run.stdout || ''}\n${run.stderr || ''}`;
        const scoreLine = output.split(/\r?\n/).find((line) => /^\s*\d+\s*$/.test(line));
        if (!scoreLine || run.status !== 0 || /error/i.test(output)) {
            const fallbackScore = matchMinutiaeFallback(probeMinutiae, candidateMinutiae);
            return {
                score: fallbackScore,
                algorithm: 'fallback',
                rawOutput: output.trim()
            };
        }

        const score = parseInt(scoreLine.trim(), 10);
        return {
            score,
            algorithm: 'bozorth3',
            rawOutput: output.trim()
        };
    } catch (error) {
        const fallbackScore = matchMinutiaeFallback(probeMinutiae, candidateMinutiae);
        return {
            score: fallbackScore,
            algorithm: 'fallback',
            rawOutput: `bozorth3 error: ${error.message}`
        };
    }
}

function toCygwinPath(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
    return match ? `/cygdrive/${match[1].toLowerCase()}/${match[2]}` : normalized;
}

function elapsedMilliseconds(startedAt) {
    return Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 100) / 100;
}

function academicMatcherError(algorithm, threshold, startedAt, error) {
    return {
        algorithm,
        status: 'error',
        score: null,
        rawScore: null,
        normalizedSimilarity: null,
        threshold,
        result: 'UNAVAILABLE',
        isMatch: null,
        processingTimeMs: elapsedMilliseconds(startedAt),
        error: error instanceof Error ? error.message : String(error),
        statusMessage: error instanceof Error ? error.message : String(error),
        quality: null,
        matchedMinutiae: {
            available: false,
            message: 'Matched-minutiae visualization is not available for this matcher.'
        }
    };
}

function runAcademicBozorth3(probeMinutiae, referenceMinutiae, threshold, options = {}) {
    return runBozorth3Matcher({
        probeMinutiae,
        referenceMinutiae,
        probeWidth: options.probeWidth,
        probeHeight: options.probeHeight,
        referenceWidth: options.referenceWidth,
        referenceHeight: options.referenceHeight,
        probeQuality: options.probeQuality,
        referenceQuality: options.referenceQuality,
        threshold,
        log: options.log,
        config: {
            executablePath: AFIS_CONFIG.bozorth3Path,
            cygwinBashPath: AFIS_CONFIG.cygwinBashPath,
            tempDir: SCANNER_RUNTIME_CONFIG.tempDir,
            timeoutMs: 10000,
            minimumMinutiae: AFIS_CONFIG.academicMatchers.bozorth3MinimumMinutiae,
            minimumImageQuality: AFIS_CONFIG.academicMatchers.bozorth3MinimumImageQuality,
            borderlineBand: AFIS_CONFIG.academicMatchers.bozorth3BorderlineBand,
            maximumPoints: 200,
            borderMargin: 0,
            minimumMinutiaQuality: 0,
            duplicateRadius: 0
        }
    });
}

function runModifiedBozorth3Comparison(probe, reference, threshold, options = {}) {
    const log = typeof options.log === 'function' ? options.log : () => {};
    const requiredStages = [
        ['denoised', 'denoising'],
        ['gaborEnhanced', 'Gabor ridge enhancement'],
        ['binarized', 'binarization'],
        ['zhangSuenThinned', 'Zhang-Suen thinning'],
        ['mindtctCandidatesExtracted', 'NIST MINDTCT candidate extraction'],
        ['skeletonValidated', 'Zhang-Suen skeleton candidate validation'],
        ['minutiaeQualityScored', 'minutiae extraction and validation']
    ];
    const missingStages = requiredStages
        .filter(([flag]) => probe?.preprocessing?.[flag] !== true || reference?.preprocessing?.[flag] !== true)
        .map(([, label]) => label);

    log('modified_bozorth3_start', 'Starting Modified Bozorth3 comparison.', {
        baseMatcher: 'Bozorth3',
        probeMinutiaeCount: probe?.minutiae?.length || 0,
        referenceMinutiaeCount: reference?.minutiae?.length || 0
    });
    if (missingStages.length > 0) {
        const message = `Modified Bozorth3 preprocessing failed: missing ${missingStages.join(', ')}.`;
        log('modified_bozorth3_preprocessing_failed', message, { missingStages }, 'error');
        return {
            algorithm: 'Modified Bozorth3',
            engine: 'Modified Bozorth3',
            baseMatcher: 'Bozorth3',
            status: 'error',
            score: null,
            rawScore: null,
            threshold,
            result: 'UNAVAILABLE',
            isMatch: null,
            error: message,
            preprocessing: {
                denoising: probe?.preprocessing?.denoised === true && reference?.preprocessing?.denoised === true,
                gaborEnhancement: probe?.preprocessing?.gaborEnhanced === true && reference?.preprocessing?.gaborEnhanced === true,
                binarization: probe?.preprocessing?.binarized === true && reference?.preprocessing?.binarized === true,
                zhangSuenThinning: probe?.preprocessing?.zhangSuenThinned === true && reference?.preprocessing?.zhangSuenThinned === true,
                bothFingerprintsProcessed: true
            }
        };
    }

    log('modified_bozorth3_templates_generated', 'Generated Bozorth3-compatible XYT templates from the enhanced probe and reference minutiae.', {
        probeMinutiaeCount: probe.minutiae.length,
        referenceMinutiaeCount: reference.minutiae.length
    });
    const nativeResult = runAcademicBozorth3(probe.minutiae, reference.minutiae, threshold, {
        probeWidth: probe.width,
        probeHeight: probe.height,
        referenceWidth: reference.width,
        referenceHeight: reference.height,
        probeQuality: probe.quality,
        referenceQuality: reference.quality,
        log
    });
    const result = {
        ...nativeResult,
        algorithm: 'Modified Bozorth3',
        engine: 'Modified Bozorth3',
        baseMatcher: 'Bozorth3',
        implementation: 'NIST MINDTCT candidates validated by the enhanced Zhang-Suen skeleton and matched by NIST Bozorth3',
        calibrationStatus: 'calibrated',
        calibrationProfileId: 'modified-bozorth3-enhanced-20261009031030',
        calibrationWarning: null,
        preprocessing: {
            denoising: true,
            denoisingAlgorithm: probe.preprocessing.denoisingAlgorithm,
            gaborEnhancement: true,
            gaborImplementation: probe.preprocessing.gaborImplementation,
            binarization: true,
            zhangSuenThinning: true,
            minutiaeExtraction: true,
            minutiaeExtractionEngine: probe.preprocessing.minutiaeExtractionEngine,
            skeletonValidationRadius: probe.preprocessing.minutiaeExtractionDiagnostics?.skeletonRadius,
            falseMinutiaeFiltering: true,
            bothFingerprintsProcessed: true,
            stages: probe.preprocessing.stages
        },
        inputMinutiae: {
            probeExtracted: probe.minutiae.length,
            probeUsed: nativeResult.inputMinutiae?.probeUsed ?? probe.minutiae.length,
            referenceExtracted: reference.minutiae.length,
            referenceUsed: nativeResult.inputMinutiae?.referenceUsed ?? reference.minutiae.length,
            format: 'NIST Bozorth3 XYT generated from MINDTCT candidates validated against the Gabor/binarized/Zhang-Suen skeleton'
        },
        processingTime: nativeResult.processingTimeMs ?? null,
        warnings: Array.isArray(nativeResult.warnings) ? nativeResult.warnings : []
    };
    log('modified_bozorth3_complete', 'Modified Bozorth3 comparison completed.', {
        rawScore: result.rawScore ?? result.score,
        decision: result.result,
        status: result.status
    }, result.status === 'ok' ? 'info' : 'error');
    return result;
}

function parseMatcherJson(output, matcherName) {
    const line = String(output || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean).pop();
    if (!line) throw new Error(`${matcherName} did not return a result.`);
    try {
        return JSON.parse(line);
    } catch (_) {
        throw new Error(`${matcherName} returned invalid JSON: ${line.slice(0, 240)}`);
    }
}

function runAcademicSourceAfis(probeImageBuffer, referenceImageBuffer, threshold, options = {}) {
    const startedAt = process.hrtime.bigint();
    const log = typeof options.log === 'function' ? options.log : () => {};
    const probeDpi = toFiniteNumber(options.probeDpi, AFIS_CONFIG.academicMatchers.sourceAfisDpi);
    const referenceDpi = toFiniteNumber(options.referenceDpi, AFIS_CONFIG.academicMatchers.sourceAfisDpi);
    const probeFile = path.join(SCANNER_RUNTIME_CONFIG.tempDir, `sourceafis_probe_${crypto.randomUUID()}.png`);
    const referenceFile = path.join(SCANNER_RUNTIME_CONFIG.tempDir, `sourceafis_reference_${crypto.randomUUID()}.png`);

    try {
        fs.writeFileSync(probeFile, probeImageBuffer);
        fs.writeFileSync(referenceFile, referenceImageBuffer);
        log('sourceafis_initialized', 'SourceAFIS initialized.', { implementation: 'SourceAFIS 3.18.1 Java API' });
        log('sourceafis_probe_image_loaded', 'SourceAFIS probe image loaded from canonical normalized pixels.', {
            bytes: probeImageBuffer.length,
            dpi: probeDpi,
            imageHash: sha256Hex(probeImageBuffer)
        });
        log('sourceafis_candidate_image_loaded', 'SourceAFIS candidate image loaded from canonical normalized pixels.', {
            bytes: referenceImageBuffer.length,
            dpi: referenceDpi,
            imageHash: sha256Hex(referenceImageBuffer)
        });
        const run = spawnSync(AFIS_CONFIG.academicMatchers.javaPath, [
            '-cp', AFIS_CONFIG.academicMatchers.sourceAfisClassPath,
            'SourceAfisCli', probeFile, referenceFile,
            String(probeDpi), String(referenceDpi)
        ], {
            encoding: 'utf8',
            timeout: 30000,
            windowsHide: true
        });
        if (run.error) throw run.error;
        if (run.status !== 0) {
            throw new Error(String(run.stderr || run.stdout || `SourceAFIS exited with status ${run.status}.`).trim());
        }
        const payload = parseMatcherJson(run.stdout, 'SourceAFIS');
        const score = Number(payload.score);
        if (!Number.isFinite(score)) throw new Error('SourceAFIS did not return a finite native score.');
        const result = {
            algorithm: 'SourceAFIS',
            engineName: 'SourceAFIS 3.18.1',
            implementation: 'Official SourceAFIS Java API with independent image feature extraction',
            status: 'ok',
            score: Math.round(score * 1000000) / 1000000,
            rawScore: Math.round(score * 1000000) / 1000000,
            normalizedSimilarity: null,
            scoreScale: 'Native SourceAFIS similarity',
            threshold,
            result: score >= threshold ? 'MATCH' : 'NO MATCH',
            isMatch: score >= threshold,
            processingTimeMs: elapsedMilliseconds(startedAt),
            templateStatus: {
                probeCreated: payload.probeTemplateCreated === true,
                candidateCreated: payload.referenceTemplateCreated === true,
                distinctObjects: true
            },
            imageInput: {
                probeDpi,
                candidateDpi: referenceDpi,
                format: 'canonical 500x500 grayscale/denoised PNG; no application binarization or skeletonization',
                probeImageHash: sha256Hex(probeImageBuffer),
                candidateImageHash: sha256Hex(referenceImageBuffer)
            },
            matchedMinutiae: {
                available: false,
                message: 'Matched-minutiae visualization is not available for this matcher.'
            }
        };
        log('sourceafis_probe_template_created', 'SourceAFIS probe template created.', { created: result.templateStatus.probeCreated });
        log('sourceafis_candidate_template_created', 'SourceAFIS candidate template created.', { created: result.templateStatus.candidateCreated });
        log('sourceafis_match_executed', 'SourceAFIS match executed with distinct templates.', {});
        log('sourceafis_raw_score', 'SourceAFIS raw score returned.', { rawScore: result.rawScore });
        log('sourceafis_threshold', 'SourceAFIS threshold used.', { threshold });
        log('sourceafis_decision', 'SourceAFIS decision produced.', { decision: result.result });
        log('sourceafis_processing_time', 'SourceAFIS processing time recorded.', { processingTimeMs: result.processingTimeMs });
        return result;
    } catch (error) {
        return academicMatcherError('SourceAFIS', threshold, startedAt, error);
    } finally {
        for (const file of [probeFile, referenceFile]) {
            try {
                if (fs.existsSync(file)) fs.unlinkSync(file);
            } catch (_) {
                // Cleanup must not hide the matcher result.
            }
        }
    }
}

function nearestMinutia(minutiae, x, y) {
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    minutiae.forEach((minutia, index) => {
        const dx = minutia.x - x;
        const dy = minutia.y - y;
        const distance = (dx * dx) + (dy * dy);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = { index, ...minutia };
        }
    });
    return best;
}

function runAcademicOpenAfis(probe, reference, threshold, options = {}) {
    const startedAt = process.hrtime.bigint();
    const log = typeof options.log === 'function' ? options.log : () => {};
    const probeFile = path.join(SCANNER_RUNTIME_CONFIG.tempDir, `openafis_probe_${crypto.randomUUID()}.csv`);
    const referenceFile = path.join(SCANNER_RUNTIME_CONFIG.tempDir, `openafis_reference_${crypto.randomUUID()}.csv`);

    try {
        if (!fs.existsSync(AFIS_CONFIG.academicMatchers.openAfisPath)) {
            throw new Error('OpenAFIS executable is not available. Run scripts/setup-academic-matchers.ps1.');
        }
        if (!Array.isArray(probe.minutiae) || !Array.isArray(reference.minutiae)
            || probe.minutiae.length < 5 || reference.minutiae.length < 5) {
            throw new Error(`OpenAFIS requires at least 5 usable minutiae per fingerprint; received ${probe.minutiae?.length || 0} and ${reference.minutiae?.length || 0}.`);
        }
        const probeWidth = Number(probe.matcherTemplate?.width)
            || Number(probe.inputMetrics?.normalizedWidth) || AFIS_CONFIG.enhancement.inputSize;
        const probeHeight = Number(probe.matcherTemplate?.height)
            || Number(probe.inputMetrics?.normalizedHeight) || AFIS_CONFIG.enhancement.inputSize;
        const referenceWidth = Number(reference.matcherTemplate?.width)
            || Number(reference.inputMetrics?.normalizedWidth) || AFIS_CONFIG.enhancement.inputSize;
        const referenceHeight = Number(reference.matcherTemplate?.height)
            || Number(reference.inputMetrics?.normalizedHeight) || AFIS_CONFIG.enhancement.inputSize;
        // OpenAFIS accepts at most 128 minutiae. Its renderable pair collector
        // reserves 100 pair slots, so the bridge uses the top 100 to keep pair
        // pointers stable. The extractor already sorts by measured quality;
        // every supplied point is real extracted data, never generated data.
        const openAfisMinutiaeLimit = 100;
        const probeMinutiae = probe.minutiae.slice(0, openAfisMinutiaeLimit);
        const referenceMinutiae = reference.minutiae.slice(0, openAfisMinutiaeLimit);
        // OpenAFIS maps X and Y independently into an internal 256x256 field.
        // A rectangular canvas would therefore apply anisotropic scaling and
        // turn a rigid finger rotation into a non-rigid distortion. A shared
        // square canvas preserves one pixels-to-field scale for both axes and
        // both fingerprints without moving the minutiae to an artificial center.
        const canvas = createIsotropicCanvas(
            { width: probeWidth, height: probeHeight },
            { width: referenceWidth, height: referenceHeight }
        );
        const conversionSamples = probeMinutiae.slice(0, 5).map((minutia, index) => ({
            index,
            x: Math.round(minutia.x),
            y: Math.round(minutia.y),
            inputAngleRadClockwise: Number(minutia.angle),
            outputAngleRadClockwise: Number(minutia.angle),
            type: minutia.type
        }));
        fs.writeFileSync(probeFile, toOpenAfisCsv(probeMinutiae, canvas), 'utf8');
        fs.writeFileSync(referenceFile, toOpenAfisCsv(referenceMinutiae, canvas), 'utf8');
        log('openafis_initialized', 'OpenAFIS initialized.', { implementation: 'neilharan/openafis' });
        log('openafis_probe_minutiae_loaded', 'OpenAFIS probe minutiae loaded.', { count: probeMinutiae.length });
        log('openafis_candidate_minutiae_loaded', 'OpenAFIS candidate minutiae loaded.', { count: referenceMinutiae.length });
        log('openafis_coordinate_conversion', 'OpenAFIS minutiae convention verified.', {
            coordinateConvention: 'top-left origin; +X right; +Y down; pixels',
            angleConvention: 'radians clockwise in image coordinates',
            samples: conversionSamples
        });

        const executable = toCygwinPath(AFIS_CONFIG.academicMatchers.openAfisPath);
        const command = `"${executable}" "${toCygwinPath(probeFile)}" "${toCygwinPath(referenceFile)}"`;
        const run = spawnSync(AFIS_CONFIG.cygwinBashPath, ['-lc', command], {
            encoding: 'utf8',
            timeout: 10000,
            windowsHide: true
        });
        if (run.error) throw run.error;
        if (run.status !== 0) {
            throw new Error(String(run.stderr || run.stdout || `OpenAFIS exited with status ${run.status}.`).trim());
        }
        const payload = parseMatcherJson(run.stdout, 'OpenAFIS');
        const score = Number(payload.score);
        if (!Number.isFinite(score)) throw new Error('OpenAFIS did not return a finite native score.');
        const correspondences = (Array.isArray(payload.matchedPairs) ? payload.matchedPairs : []).map((pair, index) => {
            const probeMinutia = nearestMinutia(probe.minutiae, Number(pair.probeX), Number(pair.probeY));
            const referenceMinutia = nearestMinutia(reference.minutiae, Number(pair.referenceX), Number(pair.referenceY));
            if (!probeMinutia || !referenceMinutia) return null;
            const probeDirectionRad = Number(probeMinutia.angle);
            const referenceDirectionRad = Number(referenceMinutia.angle);
            return {
                id: `M${index + 1}`,
                similarity: Number(pair.similarity),
                probe: {
                    index: probeMinutia.index,
                    x: probeMinutia.x,
                    y: probeMinutia.y,
                    type: probeMinutia.type,
                    directionRad: Number.isFinite(probeDirectionRad) ? probeDirectionRad : null,
                    directionDeg: Number.isFinite(probeDirectionRad)
                        ? Math.round((((probeDirectionRad * 180) / Math.PI) + 360) % 360 * 100) / 100
                        : null
                },
                reference: {
                    index: referenceMinutia.index,
                    x: referenceMinutia.x,
                    y: referenceMinutia.y,
                    type: referenceMinutia.type,
                    directionRad: Number.isFinite(referenceDirectionRad) ? referenceDirectionRad : null,
                    directionDeg: Number.isFinite(referenceDirectionRad)
                        ? Math.round((((referenceDirectionRad * 180) / Math.PI) + 360) % 360 * 100) / 100
                        : null
                }
            };
        }).filter(Boolean);
        const openAfisAlignment = estimateAlignmentFromPairs(correspondences);
        const {
            pairs: alignedCorrespondences,
            ...openAfisAlignmentDiagnostics
        } = openAfisAlignment;

        const result = {
            algorithm: 'OpenAFIS',
            engineName: 'OpenAFIS',
            implementation: 'neilharan/openafis C++ triplet matcher',
            status: 'ok',
            score,
            rawScore: score,
            normalizedSimilarity: null,
            scoreScale: 'Native OpenAFIS similarity score (nominal 0-100; not a calibrated match percentage)',
            scoreDirection: 'higher-is-more-similar',
            threshold,
            result: score >= threshold ? 'MATCH' : 'NO MATCH',
            isMatch: score >= threshold,
            processingTimeMs: elapsedMilliseconds(startedAt),
            inputMinutiae: {
                probeExtracted: probe.minutiae.length,
                probeUsed: probeMinutiae.length,
                referenceExtracted: reference.minutiae.length,
                referenceUsed: referenceMinutiae.length,
                maximumPerTemplate: openAfisMinutiaeLimit,
                format: 'OpenAFIS CSV type,x,y,angle-radians',
                coordinateConvention: 'top-left origin; +X right; +Y down; pixel coordinates',
                angleConvention: 'radians clockwise in image coordinates',
                conversionSamples
            },
            matchedMinutiae: {
                available: true,
                source: 'OpenAFIS MatchRenderable pair output',
                pairs: alignedCorrespondences
            },
            matcherDiagnostics: {
                templateSource: probe.matcherTemplate?.source || 'application minutiae extractor',
                probeDimensions: { width: probeWidth, height: probeHeight },
                referenceDimensions: { width: referenceWidth, height: referenceHeight },
                isotropicCanvas: canvas,
                matchedPairCount: correspondences.length,
                alignment: openAfisAlignmentDiagnostics
            },
            warnings: probeMinutiae.length < 12 || referenceMinutiae.length < 12
                ? ['Too few minutiae for a robust OpenAFIS decision.']
                : []
        };
        log('openafis_match_executed', 'OpenAFIS match executed.', { matchedPairCount: correspondences.length });
        log('openafis_alignment_diagnostics', 'Estimated the rigid transform from OpenAFIS correspondence output.', {
            available: openAfisAlignment.available,
            estimatedRotationDeg: openAfisAlignment.estimatedRotationDeg ?? null,
            estimatedXTranslationPx: openAfisAlignment.estimatedXTranslationPx ?? null,
            estimatedYTranslationPx: openAfisAlignment.estimatedYTranslationPx ?? null,
            matchedMinutiaeCount: openAfisAlignment.matchedMinutiaeCount
        }, openAfisAlignment.available ? 'info' : 'warn');
        log('openafis_raw_score', 'OpenAFIS raw score returned.', { rawScore: score });
        log('openafis_threshold', 'OpenAFIS threshold used.', { threshold });
        log('openafis_decision', 'OpenAFIS decision produced.', { decision: result.result });
        log('openafis_processing_time', 'OpenAFIS processing time recorded.', { processingTimeMs: result.processingTimeMs });
        return result;
    } catch (error) {
        return academicMatcherError('OpenAFIS', threshold, startedAt, error);
    } finally {
        for (const file of [probeFile, referenceFile]) {
            try {
                if (fs.existsSync(file)) fs.unlinkSync(file);
            } catch (_) {
                // Cleanup must not hide the matcher result.
            }
        }
    }
}

function sanitizeAcademicThreshold(value, fallback, maximum = Number.POSITIVE_INFINITY) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? clamp(parsed, 0, maximum) : fallback;
}

// Enhance image contrast
function enhanceContrast(imageData) {
    // Find min and max
    let min = 255, max = 0;
    for (let i = 0; i < imageData.length; i++) {
        if (imageData[i] < min) min = imageData[i];
        if (imageData[i] > max) max = imageData[i];
    }
    
    const range = max - min;
    
    // Expand contrast
    for (let i = 0; i < imageData.length; i++) {
        const normalized = (imageData[i] - min) / range;
        const enhanced = Math.pow(normalized, 0.85); // Gamma correction
        imageData[i] = Math.round(enhanced * 255);
    }
}

// Generate minutiae points (ridge endings and bifurcations)
function generateMinutiaePoints(centerX, centerY, radius) {
    const minutiae = [];
    const count = 20;
    
    for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        const distance = 60 + Math.random() * 100;
        
        const x = centerX + Math.cos(angle) * distance;
        const y = centerY + Math.sin(angle) * distance;
        
        if (x > 10 && x < 490 && y > 10 && y < 490) {
            minutiae.push({
                x: Math.floor(x),
                y: Math.floor(y),
                type: Math.random() > 0.5 ? 'ending' : 'bifurcation',
                angle: angle
            });
        }
    }
    
    return minutiae;
}

// Draw minutiae markers on image
function drawMinutiaePoints(imageData, width, height, minutiae) {
    minutiae.forEach(point => {
        const radius = 6;
        
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const y = point.y + dy;
                const x = point.x + dx;
                
                if (x > 0 && x < width && y > 0 && y < height) {
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist <= radius) {
                        const idx = y * width + x;
                        
                        // Mark minutiae with specific patterns
                        if (point.type === 'ending') {
                            // Ridge ending - very dark dot
                            imageData[idx] = 30;
                        } else {
                            // Bifurcation - lighter dot
                            imageData[idx] = 150;
                        }
                    }
                }
            }
        }
    });
}

// Generate ISO template for fingerprint
function generateRandomTemplate() {
    // Generate a valid-looking ISO template (128 bytes)
    const template = Buffer.alloc(128);
    
    // ISO header
    template[0] = 0x46; // 'F'
    template[1] = 0x49; // 'I'
    template[2] = 0x52; // 'R'
    template[3] = 0x00; // Version
    
    // Fill rest with random biometric-like data
    for (let i = 8; i < 128; i++) {
        template[i] = Math.floor(Math.random() * 256);
    }
    
    return template;
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

app.get('/', (req, res) => {
    res.json({
        service: 'MINUTIAE Fingerprint Scanner Service',
        status: 'running',
        scanner_available: scannerAvailable,
        scanner_name: getScannerDisplayName(),
        scanner_provider: SCANNER_CONFIG.provider,
        scanner_info_url: `http://localhost:${port}/scanner-info`,
        scan_url: `http://localhost:${port}/scan`
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    checkScannerStatus();
    res.json({
        status: 'running',
        scanner_available: scannerAvailable,
        scanner_name: getScannerDisplayName(),
        scanner_provider: SCANNER_CONFIG.provider,
        simulation_allowed: SCANNER_CONFIG.allowSimulation,
        port: port
    });
});

app.get('/debug/config', (req, res) => {
    checkScannerStatus();
    res.json({
        success: true,
        afis: {
            enhancement: AFIS_CONFIG.enhancement,
            minutiae: AFIS_CONFIG.minutiae,
            consistency: AFIS_CONFIG.consistency,
            alignment: AFIS_CONFIG.alignment,
            graph: AFIS_CONFIG.graph,
            localStructure: AFIS_CONFIG.localStructure,
            bozorthEnhancement: AFIS_CONFIG.bozorthEnhancement,
            thresholding: AFIS_CONFIG.thresholding,
            decision: AFIS_CONFIG.decision,
            fusion: AFIS_CONFIG.fusion,
            matchThreshold: AFIS_CONFIG.matchThreshold,
            academicMatchers: {
                bozorth3Ready: isBozorth3Ready(),
                bozorth3Path: AFIS_CONFIG.bozorth3Path,
                cygwinBashPath: AFIS_CONFIG.cygwinBashPath,
                bozorth3Threshold: AFIS_CONFIG.academicMatchers.bozorth3Threshold,
                mindtctReady: fs.existsSync(AFIS_CONFIG.mindtct.executablePath),
                mindtctSkeletonRadius: AFIS_CONFIG.mindtct.skeletonRadius,
                sourceAfisThreshold: AFIS_CONFIG.academicMatchers.sourceAfisThreshold,
                openAfisThreshold: AFIS_CONFIG.academicMatchers.openAfisThreshold,
                mccThreshold: AFIS_CONFIG.academicMatchers.mccThreshold,
                jiangThreshold: AFIS_CONFIG.academicMatchers.jiangThreshold,
                sourceAfisDpi: AFIS_CONFIG.academicMatchers.sourceAfisDpi,
                sourceAfisReady: fs.existsSync(path.join(__dirname, 'matchers', 'sourceafis', 'target', 'classes', 'SourceAfisCli.class')),
                openAfisReady: fs.existsSync(AFIS_CONFIG.academicMatchers.openAfisPath),
                mccReady: fs.existsSync(AFIS_CONFIG.academicMatchers.mccPath),
                jiangReady: fs.existsSync(AFIS_CONFIG.academicMatchers.jiangPath)
            }
        },
        scanner: {
            available: scannerAvailable,
            provider: SCANNER_CONFIG.provider,
            captureCommandConfigured: !!SCANNER_CONFIG.captureCommand,
            captureCommand: SCANNER_CONFIG.captureCommand,
            captureArgs: SCANNER_CONFIG.captureArgs,
            statusArgs: SCANNER_CONFIG.statusArgs,
            outputExtension: SCANNER_CONFIG.outputExtension,
            dpi: SCANNER_CONFIG.dpi,
            captureTimeoutMs: SCANNER_RUNTIME_CONFIG.timeout,
            processGraceMs: SCANNER_RUNTIME_CONFIG.processGraceMs,
            simulationAllowed: SCANNER_CONFIG.allowSimulation,
            tempDir: SCANNER_RUNTIME_CONFIG.tempDir,
            scannerTempDir: SCANNER_RUNTIME_CONFIG.scannerTempDir
        }
    });
});

app.get('/debug/events', (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 150));
    const traceId = typeof req.query.traceId === 'string' ? req.query.traceId.trim() : '';
    const events = traceId
        ? serviceDebugEvents.filter((event) => event.traceId === traceId)
        : serviceDebugEvents;

    res.json({
        success: true,
        total: events.length,
        traceId: traceId || null,
        events: events.slice(-limit)
    });
});

app.post('/debug/clear', (req, res) => {
    serviceDebugEvents.length = 0;
    res.json({
        success: true,
        cleared: true
    });
});

// Scan fingerprint endpoint - returns both template and image
app.post('/scan', async (req, res) => {
    const { type } = req.body || {}; // 'applicant' or 'criminal'
    const traceContext = createTraceContext('scan', { route: '/scan', type: type || null });

    try {
        if (!type) {
            return res.status(400).json({
                success: false,
                traceId: traceContext.traceId,
                error: 'Missing scan type'
            });
        }

        console.log(`[${new Date().toISOString()}] Scan request: ${type}`);

        const result = await captureFingerprint(type, traceContext);

        res.json({
            success: true,
            traceId: traceContext.traceId,
            template: result.template,
            templateBase64: Buffer.isBuffer(result.template) ? result.template.toString('base64') : '',
            image: result.image,       // PNG as base64
            originalImage: result.originalImage || result.image,
            normalizedImage: result.normalizedImage || result.image,
            denoisedImage: result.denoisedImage,
            imageFormat: result.imageFormat,
            format: result.format,
            quality: result.quality,
            source: result.source,     // Include actual source information
            scanned: result.scanned,   // true if real scan, false if simulated
            fingerprintId: result.fingerprintId,
            fingerPosition: result.fingerPosition,
            dpi: result.dpi,
            dpiSource: result.dpiSource,
            enhancedImage: result.enhancedImage,
            gaborEnhancedImage: result.gaborEnhancedImage,
            binarizedImage: result.binarizedImage,
            thinnedImage: result.thinnedImage,
            minutiaeOverlayImage: result.minutiaeOverlayImage,
            minutiae: result.minutiae,
            academicMinutiae: result.academicMinutiae,
            afisQuality: result.afisQuality,
            qualityMetrics: result.qualityMetrics,
            blockMetrics: result.blockMetrics,
            orientationField: result.orientationField,
            frequencyField: result.frequencyField,
            coherenceField: result.coherenceField,
            blocksX: result.blocksX,
            blocksY: result.blocksY,
            preprocessing: result.preprocessing,
            inputMetrics: result.inputMetrics,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('[ERROR] Scan failed:', error.message);
        res.status(500).json({
            success: false,
            traceId: traceContext.traceId,
            error: error.message
        });
    }
});

// Process one fingerprint image through enhancement + minutiae extraction.
app.post('/afis/process', async (req, res) => {
    try {
        const { image, modifiedBozorth3 = false } = req.body;
        const traceContext = createTraceContext('afis_process', { route: '/afis/process' });
        if (!image) {
            return res.status(400).json({ success: false, error: 'Missing image (base64 PNG)' });
        }
        const imageBuffer = Buffer.from(parseFingerprintImageInput(image), 'base64');
        const result = await processFingerprintForAfis(imageBuffer, traceContext, {
            modifiedBozorth3: modifiedBozorth3 === true
        });
        return res.json({
            success: true,
            traceId: traceContext.traceId,
            image: result.image,
            originalImage: result.originalImage,
            normalizedImage: result.normalizedImage,
            denoisedImage: result.denoisedImage,
            enhancedImage: result.enhancedImage,
            gaborEnhancedImage: result.gaborEnhancedImage,
            binarizedImage: result.binarizedImage,
            thinnedImage: result.thinnedImage,
            minutiaeOverlayImage: result.minutiaeOverlayImage,
            minutiae: result.minutiae,
            academicMinutiae: result.academicMinutiae,
            quality: result.quality,
            qualityMetrics: result.qualityMetrics,
            blockMetrics: result.blockMetrics,
            orientationField: result.orientationField,
            frequencyField: result.frequencyField,
            coherenceField: result.coherenceField,
            foregroundMap: result.foregroundMap,
            blocksX: result.blocksX,
            blocksY: result.blocksY,
            geometryDescriptor: result.geometryDescriptor,
            preprocessing: result.preprocessing,
            inputMetrics: result.inputMetrics,
            minutiaeCount: result.minutiae.length
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Build a matching template + preview from uploaded image (PNG/JPG/TIFF/etc).
app.post('/afis/from-image', async (req, res) => {
    try {
        const { image } = req.body || {};
        const traceContext = createTraceContext('afis_from_image', { route: '/afis/from-image' });
        if (!image) {
            return res.status(400).json({ success: false, error: 'Missing image (base64 content)' });
        }

        const inputBuffer = Buffer.from(parseFingerprintImageInput(image), 'base64');
        const afis = await processFingerprintForAfis(inputBuffer, traceContext);
        const normalizedBuffer = Buffer.from(afis.image, 'base64');
        const enhancedBuffer = Buffer.from(afis.enhancedImage, 'base64');
        const template = buildTemplateFromMinutiae(afis.minutiae, enhancedBuffer, normalizedBuffer);

        return res.json({
            success: true,
            traceId: traceContext.traceId,
            format: 'ISO',
            image: afis.image,
            originalImage: afis.originalImage,
            normalizedImage: afis.normalizedImage,
            denoisedImage: afis.denoisedImage,
            enhancedImage: afis.enhancedImage,
            gaborEnhancedImage: afis.gaborEnhancedImage,
            binarizedImage: afis.binarizedImage,
            thinnedImage: afis.thinnedImage,
            minutiaeOverlayImage: afis.minutiaeOverlayImage,
            minutiae: afis.minutiae,
            academicMinutiae: afis.academicMinutiae,
            afisQuality: afis.quality,
            qualityMetrics: afis.qualityMetrics,
            blockMetrics: afis.blockMetrics,
            orientationField: afis.orientationField,
            frequencyField: afis.frequencyField,
            coherenceField: afis.coherenceField,
            foregroundMap: afis.foregroundMap,
            blocksX: afis.blocksX,
            blocksY: afis.blocksY,
            geometryDescriptor: afis.geometryDescriptor,
            preprocessing: afis.preprocessing,
            inputMetrics: afis.inputMetrics,
            templateBase64: template.toString('base64'),
            source: 'Uploaded fingerprint image',
            fingerprintId: `upload-${sha256Hex(inputBuffer).slice(0, 16)}`,
            fingerPosition: 'unspecified',
            dpi: afis.inputMetrics.dpi,
            dpiSource: afis.inputMetrics.dpiSource
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Compare two fingerprints via extracted minutiae and Bozorth3-compatible scoring.
app.post('/afis/compare', async (req, res) => {
    try {
        const {
            probeImage,
            candidateImage,
            threshold,
            requireBozorth3,
            probePreprocessed,
            candidatePreprocessed,
            tuning
        } = req.body;
        const traceContext = createTraceContext('afis_compare', { route: '/afis/compare' });
        if (!probeImage || !candidateImage) {
            return res.status(400).json({
                success: false,
                error: 'Missing probeImage or candidateImage (base64 PNG)'
            });
        }

        const matcherConfig = buildRuntimeMatcherConfig(tuning);

        logServiceEvent(traceContext, 'compare_start', 'Starting fingerprint comparison.', {
            requestedThreshold: Number.isFinite(Number(threshold)) ? Number(threshold) : matcherConfig.matchThreshold,
            requireBozorth3: !!requireBozorth3,
            probePreprocessed: !!probePreprocessed,
            candidatePreprocessed: !!candidatePreprocessed,
            tuningApplied: !!(tuning && typeof tuning === 'object')
        });
        const probe = await processFingerprintForAfis(Buffer.from(parseFingerprintImageInput(probeImage), 'base64'), {
            ...traceContext,
            label: 'probe'
        }, {
            // Modified Bozorth3 must execute every stage for every comparison;
            // a caller cannot bypass denoising by marking input preprocessed.
            skipPreparation: false,
            modifiedBozorth3: true
        });
        const candidate = await processFingerprintForAfis(Buffer.from(parseFingerprintImageInput(candidateImage), 'base64'), {
            ...traceContext,
            label: 'candidate'
        }, {
            skipPreparation: false,
            modifiedBozorth3: true
        });
        const comparison = compareWithBozorth3(probe.minutiae, candidate.minutiae);
        const requestedThreshold = Number.isFinite(Number(threshold)) ? Number(threshold) : matcherConfig.matchThreshold;
        const consistency = computeMinutiaeConsistency(probe.minutiae, candidate.minutiae, matcherConfig.consistency);
        const forwardAlignment = estimateAlignmentTransform(probe.minutiae, candidate.minutiae, matcherConfig.alignment);
        const reverseAlignment = estimateAlignmentTransform(candidate.minutiae, probe.minutiae, matcherConfig.alignment);
        const alignedConsistency = computeAlignedMinutiaeConsistency(
            probe.minutiae,
            candidate.minutiae,
            forwardAlignment,
            reverseAlignment,
            matcherConfig.consistency
        );
        const orientationAgreement = computeOrientationFrequencyAgreement(probe, candidate);
        const graphScore = scoreSpatialRelationship(probe.geometryDescriptor, candidate.geometryDescriptor);
        const localStructureScore = scoreLocalStructureAgreement(
            probe.minutiae,
            candidate.minutiae,
            forwardAlignment,
            matcherConfig.localStructure
        );
        const bozorthEnhanced = computeEnhancedBozorthScore(
            comparison.score,
            probe.minutiae,
            candidate.minutiae,
            forwardAlignment,
            matcherConfig.bozorthEnhancement
        );
        const adaptiveMinutiaeRequirement = computeAdaptiveMinutiaeRequirement(probe, candidate, orientationAgreement.overlapRatio, matcherConfig);
        const hasSufficientMinutiae = probe.minutiae.length >= adaptiveMinutiaeRequirement
            && candidate.minutiae.length >= adaptiveMinutiaeRequirement;
        const minutiaeCountScore = Math.min(
            probe.minutiae.length,
            candidate.minutiae.length
        ) / Math.max(1, adaptiveMinutiaeRequirement);
        const adaptiveThreshold = computeAdaptiveThreshold(
            requestedThreshold,
            probe,
            candidate,
            orientationAgreement.overlapRatio,
            Math.min(1, minutiaeCountScore),
            matcherConfig
        );
        const consistencyEnabled = !!matcherConfig.consistency.enabled;
        const consistencyThreshold = Number.isFinite(Number(matcherConfig.consistency.minScore))
            ? Number(matcherConfig.consistency.minScore)
            : 0;
        const directionalThreshold = Number.isFinite(Number(matcherConfig.consistency.minDirectionalScore))
            ? Number(matcherConfig.consistency.minDirectionalScore)
            : Math.max(1, Math.floor(consistencyThreshold / 2));
        const passesConsistency = !consistencyEnabled || (
            consistency.score >= consistencyThreshold
            && consistency.forward >= directionalThreshold
            && consistency.reverse >= directionalThreshold
        );
        const alignedConsistencyPass = !consistencyEnabled || (
            alignedConsistency.score >= consistencyThreshold
            && alignedConsistency.forward >= directionalThreshold
            && alignedConsistency.reverse >= directionalThreshold
        );
        const effectiveConsistencyScore = Math.max(consistency.score, alignedConsistency.score);
        const effectiveConsistencyPass = passesConsistency || alignedConsistencyPass;
        const qualityConfidence = computeQualityConfidence(probe, candidate);
        const normalizedBozorthScore = bozorthEnhanced.score;
        const fusedScore = Math.round(
            (normalizedBozorthScore * matcherConfig.fusion.bozorth)
            + (effectiveConsistencyScore * matcherConfig.fusion.consistency)
            + (orientationAgreement.combined * matcherConfig.fusion.orientation)
            + (graphScore * matcherConfig.fusion.graph)
            + (localStructureScore * matcherConfig.fusion.localStructure)
            + (qualityConfidence * matcherConfig.fusion.quality)
        );
        const structuralPass = orientationAgreement.combined >= matcherConfig.decision.structuralOrientationMin
            && graphScore >= matcherConfig.decision.structuralGraphMin;
        const structureRescuePass = localStructureScore >= matcherConfig.decision.localStructureRescueMin;
        const partialTolerancePass = orientationAgreement.overlapRatio >= matcherConfig.decision.partialOverlapMin
            || qualityConfidence >= matcherConfig.decision.partialQualityMin
            || localStructureScore >= matcherConfig.decision.partialLocalStructureMin;
        const isMatch = fusedScore >= adaptiveThreshold
            && normalizedBozorthScore >= Math.max(matcherConfig.decision.bozorthFloor, adaptiveThreshold - matcherConfig.decision.bozorthThresholdAllowance)
            && effectiveConsistencyPass
            && (structuralPass || structureRescuePass)
            && partialTolerancePass
            && hasSufficientMinutiae;
        const needsStrictBozorth3 = !!requireBozorth3;

        logServiceEvent(traceContext, 'compare_complete', 'Fingerprint comparison finished.', {
            isMatch,
            fusedScore,
            adaptiveThreshold,
            bozorthScore: comparison.score,
            enhancedBozorthScore: normalizedBozorthScore,
            normalizedBozorthScore,
            probeMinutiaeCount: probe.minutiae.length,
            candidateMinutiaeCount: candidate.minutiae.length,
            qualityConfidence,
            consistencyScore: consistency.score,
            alignedConsistencyScore: alignedConsistency.score,
            orientationScore: orientationAgreement.combined,
            graphScore,
            localStructureScore
        });

        if (needsStrictBozorth3 && comparison.algorithm !== 'bozorth3') {
            return res.status(503).json({
                success: false,
                error: 'AFIS minutiae extraction worked, but Bozorth3 comparison is unavailable.',
                traceId: traceContext.traceId,
                algorithm: comparison.algorithm,
                score: fusedScore,
                threshold: adaptiveThreshold,
                bozorthScore: comparison.score,
                rawOutput: comparison.rawOutput
            });
        }

        return res.json({
            success: true,
            traceId: traceContext.traceId,
            algorithm: comparison.algorithm,
            matchEngine: 'bozorth3_enhanced_local',
            score: fusedScore,
            threshold: adaptiveThreshold,
            isMatch,
            bozorthScore: comparison.score,
            rawNormalizedBozorthScore: bozorthEnhanced.rawNormalizedScore,
            normalizedBozorthScore,
            bozorthEnhanced: {
                score: normalizedBozorthScore,
                rawNormalizedScore: bozorthEnhanced.rawNormalizedScore,
                pairCount: bozorthEnhanced.pairCount,
                coverageScore: bozorthEnhanced.coverageScore,
                pairScore: bozorthEnhanced.pairScore,
                descriptorScore: bozorthEnhanced.descriptorScore,
                graphScore: bozorthEnhanced.graphScore
            },
            consistency: {
                enabled: consistencyEnabled,
                score: consistency.score,
                effectiveScore: effectiveConsistencyScore,
                threshold: consistencyThreshold,
                directionalThreshold,
                passes: passesConsistency,
                effectivePasses: effectiveConsistencyPass,
                forward: consistency.forward,
                reverse: consistency.reverse,
                forwardCentered: consistency.forwardCentered,
                reverseCentered: consistency.reverseCentered
            },
            alignedConsistency: {
                score: alignedConsistency.score,
                passes: alignedConsistencyPass,
                forward: alignedConsistency.forward,
                reverse: alignedConsistency.reverse,
                transform: forwardAlignment ? {
                    rotationDeg: Math.round((forwardAlignment.rotation * 180) / Math.PI),
                    translateX: Math.round(forwardAlignment.translation.x * 100) / 100,
                    translateY: Math.round(forwardAlignment.translation.y * 100) / 100,
                    supportScore: forwardAlignment.score
                } : null
            },
            minutiaeRequirement: {
                minRequiredForMatch: adaptiveMinutiaeRequirement,
                probeCount: probe.minutiae.length,
                candidateCount: candidate.minutiae.length,
                passes: hasSufficientMinutiae
            },
            orientationFrequency: {
                score: orientationAgreement.combined,
                orientationScore: orientationAgreement.orientationScore,
                frequencyScore: orientationAgreement.frequencyScore,
                overlapRatio: orientationAgreement.overlapRatio
            },
            spatialModel: {
                score: graphScore,
                model: 'pairwise_geometric_histogram'
            },
            localStructure: {
                enabled: !!matcherConfig.localStructure.enabled,
                score: localStructureScore,
                minScore: matcherConfig.localStructure.minScore,
                rescuePass: structureRescuePass
            },
            qualityFusion: {
                score: qualityConfidence,
                adaptiveThreshold,
                structuralPass,
                structureRescuePass,
                partialTolerancePass
            },
            appliedTuning: {
                matchThreshold: matcherConfig.matchThreshold,
                minutiae: matcherConfig.minutiae,
                consistency: matcherConfig.consistency,
                alignment: matcherConfig.alignment,
                thresholding: matcherConfig.thresholding,
                localStructure: matcherConfig.localStructure,
                bozorthEnhancement: matcherConfig.bozorthEnhancement,
                decision: matcherConfig.decision,
                fusion: matcherConfig.fusion
            },
            probe: {
                image: probe.image,
                originalImage: probe.originalImage,
                denoisedImage: probe.denoisedImage,
                quality: probe.quality,
                minutiaeCount: probe.minutiae.length,
                enhancedImage: probe.enhancedImage,
                gaborEnhancedImage: probe.gaborEnhancedImage,
                binarizedImage: probe.binarizedImage,
                thinnedImage: probe.thinnedImage,
                minutiaeOverlayImage: probe.minutiaeOverlayImage,
                qualityMetrics: probe.qualityMetrics,
                blockMetrics: probe.blockMetrics,
                inputMetrics: probe.inputMetrics,
                preprocessing: probe.preprocessing,
                minutiae: probe.minutiae
            },
            candidate: {
                image: candidate.image,
                originalImage: candidate.originalImage,
                denoisedImage: candidate.denoisedImage,
                quality: candidate.quality,
                minutiaeCount: candidate.minutiae.length,
                enhancedImage: candidate.enhancedImage,
                gaborEnhancedImage: candidate.gaborEnhancedImage,
                binarizedImage: candidate.binarizedImage,
                thinnedImage: candidate.thinnedImage,
                minutiaeOverlayImage: candidate.minutiaeOverlayImage,
                qualityMetrics: candidate.qualityMetrics,
                blockMetrics: candidate.blockMetrics,
                inputMetrics: candidate.inputMetrics,
                preprocessing: candidate.preprocessing,
                minutiae: candidate.minutiae
            },
            rawOutput: comparison.rawOutput
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Compare one probe/reference pair with independent matcher engines.
// Scores remain on their native scales. Failed engines never receive a
// substitute score and never prevent the other engines from returning results.
app.post('/afis/compare-all', async (req, res) => {
    const traceContext = createTraceContext('afis_compare_all', { route: '/afis/compare-all' });
    try {
        const {
            probeImage,
            referenceImage,
            thresholds = {},
            probePreprocessed,
            referencePreprocessed,
            probeInfo = {},
            referenceInfo = {}
        } = req.body || {};
        if (!probeImage || !referenceImage) {
            return res.status(400).json({
                success: false,
                traceId: traceContext.traceId,
                error: 'Missing probeImage or referenceImage (base64 PNG).'
            });
        }

        const appliedThresholds = {
            bozorth3: sanitizeAcademicThreshold(thresholds.bozorth3, AFIS_CONFIG.academicMatchers.bozorth3Threshold),
            sourceafis: sanitizeAcademicThreshold(thresholds.sourceafis, AFIS_CONFIG.academicMatchers.sourceAfisThreshold),
            openafis: sanitizeAcademicThreshold(thresholds.openafis, AFIS_CONFIG.academicMatchers.openAfisThreshold, 100),
            mcc: sanitizeAcademicThreshold(thresholds.mcc, AFIS_CONFIG.academicMatchers.mccThreshold, 1),
            jiang: sanitizeAcademicThreshold(thresholds.jiang, AFIS_CONFIG.academicMatchers.jiangThreshold, 1)
        };
        const probeBuffer = Buffer.from(parseFingerprintImageInput(probeImage), 'base64');
        const referenceBuffer = Buffer.from(parseFingerprintImageInput(referenceImage), 'base64');
        logServiceEvent(traceContext, 'academic_compare_start', 'Starting independent academic matcher comparison.', {
            thresholds: appliedThresholds,
            scoreFusion: false,
            probePreprocessed: !!probePreprocessed,
            referencePreprocessed: !!referencePreprocessed
        });

        const probe = await processFingerprintForAfis(probeBuffer, { ...traceContext, label: 'probe' }, {
            skipPreparation: false,
            inputDpi: probeInfo.dpi,
            modifiedBozorth3: true
        });
        const reference = await processFingerprintForAfis(referenceBuffer, { ...traceContext, label: 'reference' }, {
            skipPreparation: false,
            inputDpi: referenceInfo.dpi,
            modifiedBozorth3: true
        });
        // SourceAFIS remains an independent matcher, but all four supporting
        // matchers must see a common 500x500 pixel geometry. Feeding a raw
        // 500x500 scanner capture against a 300x375 imported record changes
        // ridge scale and minutia coordinates enough to create false negatives.
        // The canonical images include grayscale normalization and denoising,
        // but not the Modified Bozorth3 binarization or skeletonization stages.
        const sourceAfisProbe = Buffer.from(probe.normalizedImage || probe.image, 'base64');
        const sourceAfisReference = Buffer.from(reference.normalizedImage || reference.image, 'base64');
        const inputDiagnostics = matcherPairDiagnostics(
            probeBuffer,
            referenceBuffer,
            probe,
            reference,
            probeInfo,
            referenceInfo
        );
        logServiceEvent(traceContext, 'matcher_input_pair_verified', 'Verified the shared probe/candidate pair supplied to all five matchers.', inputDiagnostics);
        let sharedTemplates;
        let sharedMinutiaeDiagnostics;
        try {
            sharedTemplates = extractMinutiaePair({
                probeImageBuffer: sourceAfisProbe,
                referenceImageBuffer: sourceAfisReference,
                probeDpi: inputDiagnostics.probe.dpi,
                referenceDpi: inputDiagnostics.candidate.dpi,
                javaPath: AFIS_CONFIG.academicMatchers.javaPath,
                classPath: AFIS_CONFIG.academicMatchers.sourceAfisClassPath,
                tempDir: SCANNER_RUNTIME_CONFIG.tempDir
            });
            sharedMinutiaeDiagnostics = {
                status: 'ok',
                source: sharedTemplates.probe.source,
                scoreIndependent: true,
                probeCount: sharedTemplates.probe.minutiae.length,
                referenceCount: sharedTemplates.reference.minutiae.length,
                probeDimensions: { width: sharedTemplates.probe.width, height: sharedTemplates.probe.height },
                referenceDimensions: { width: sharedTemplates.reference.width, height: sharedTemplates.reference.height },
                imageFeed: 'canonical 500x500 grayscale/denoised PNG',
                probeImageHash: sha256Hex(sourceAfisProbe),
                referenceImageHash: sha256Hex(sourceAfisReference),
                coordinateConvention: sharedTemplates.probe.coordinateConvention,
                angleConvention: sharedTemplates.probe.angleConvention,
                processingTimeMs: sharedTemplates.processingTimeMs
            };
            logServiceEvent(traceContext, 'shared_minutiae_extracted', 'Extracted score-independent minutiae for OpenAFIS, MCC, and Jiang.', sharedMinutiaeDiagnostics);
        } catch (error) {
            sharedTemplates = {
                probe: { width: inputDiagnostics.probe.imageWidth, height: inputDiagnostics.probe.imageHeight, minutiae: [] },
                reference: { width: inputDiagnostics.candidate.imageWidth, height: inputDiagnostics.candidate.imageHeight, minutiae: [] }
            };
            sharedMinutiaeDiagnostics = {
                status: 'error',
                scoreIndependent: true,
                error: error.message
            };
            logServiceEvent(traceContext, 'shared_minutiae_extraction_failed', 'Could not extract minutiae for OpenAFIS, MCC, and Jiang.', sharedMinutiaeDiagnostics, 'error');
        }
        const probeAcademic = { ...probe, minutiae: sharedTemplates.probe.minutiae, matcherTemplate: sharedTemplates.probe };
        const referenceAcademic = { ...reference, minutiae: sharedTemplates.reference.minutiae, matcherTemplate: sharedTemplates.reference };
        const matcherLog = (prefix) => (stage, message, data, level) => {
            logServiceEvent(traceContext, stage, message, data, level);
            const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
            console[method](`[${prefix}] ${message}`, data || {});
        };
        // Matcher registry: adding another engine is one independent entry rather
        // than a rewrite of the comparison route.
        const matcherRegistry = [
            {
                key: 'bozorth3',
                run: () => runModifiedBozorth3Comparison(probe, reference, appliedThresholds.bozorth3, {
                    log: matcherLog('Modified Bozorth3')
                })
            },
            {
                key: 'sourceafis',
                run: () => runAcademicSourceAfis(sourceAfisProbe, sourceAfisReference, appliedThresholds.sourceafis, {
                    probeDpi: inputDiagnostics.probe.dpi,
                    referenceDpi: inputDiagnostics.candidate.dpi,
                    log: matcherLog('SOURCEAFIS')
                })
            },
            {
                key: 'openafis',
                run: () => runAcademicOpenAfis(probeAcademic, referenceAcademic, appliedThresholds.openafis, {
                    log: matcherLog('OPENAFIS')
                })
            },
            {
                key: 'mcc',
                name: 'MCC',
                run: () => runMccMatcher({
                    probeMinutiae: sharedTemplates.probe.minutiae,
                    referenceMinutiae: sharedTemplates.reference.minutiae,
                    threshold: appliedThresholds.mcc,
                    config: {
                        executablePath: AFIS_CONFIG.academicMatchers.mccPath,
                        cygwinBashPath: AFIS_CONFIG.cygwinBashPath
                    },
                    log: matcherLog('MCC')
                })
            },
            {
                key: 'jiang',
                name: 'Jiang Matcher',
                run: () => runJiangMatcher({
                    probeMinutiae: sharedTemplates.probe.minutiae,
                    referenceMinutiae: sharedTemplates.reference.minutiae,
                    threshold: appliedThresholds.jiang,
                    config: {
                        executablePath: AFIS_CONFIG.academicMatchers.jiangPath,
                        cygwinBashPath: AFIS_CONFIG.cygwinBashPath
                    },
                    log: matcherLog('JIANG')
                })
            }
        ];
        const matchers = matcherRegistry.map((matcher) => {
            const decorated = attachMatchPercentage({
                ...matcher.run(),
                inputDiagnostics: {
                    probeFingerprintId: inputDiagnostics.probe.fingerprintId,
                    candidateFingerprintId: inputDiagnostics.candidate.fingerprintId,
                    probeFilePath: inputDiagnostics.probe.filePath,
                    candidateFilePath: inputDiagnostics.candidate.filePath,
                    probeFingerPosition: inputDiagnostics.probe.fingerPosition,
                    candidateFingerPosition: inputDiagnostics.candidate.fingerPosition,
                    probeImageHash: inputDiagnostics.probe.imageHash,
                    candidateImageHash: inputDiagnostics.candidate.imageHash,
                    sameSourceImage: inputDiagnostics.sameSourceImage,
                    verifiedSharedPair: true
                }
            });
            return matcher.key === 'bozorth3'
                ? { ...decorated, matchPercentage: decorated.normalizedMatchPercentage }
                : decorated;
        });
        const supportingArbiter = buildSupportingMatcherArbiter(matchers);

        logServiceEvent(traceContext, 'academic_compare_complete', 'Independent academic matcher comparison finished.', {
            matchers: matchers.map((matcher) => ({
                algorithm: matcher.algorithm,
                status: matcher.status,
                score: matcher.score,
                normalizedMatchPercentage: matcher.normalizedMatchPercentage,
                threshold: matcher.threshold,
                result: matcher.result,
                processingTimeMs: matcher.processingTimeMs,
                matchedPairCount: matcher.matchedMinutiae?.pairs?.length || 0
            })),
            supportingArbiter
        });

        const comparisonResult = buildFingerprintComparisonResult({
            success: true,
            traceId: traceContext.traceId,
            purpose: 'Academic fingerprint-matching comparison only',
            scoreFusion: false,
            scoreNotice: 'Raw scores use matcher-specific scales and are not compared or averaged. Match percentages are matcher-specific calibrated interpretations, not probabilities of identity or system accuracy.',
            inputDiagnostics,
            sharedMinutiaeDiagnostics,
            matchers,
            supportingArbiter,
            probe: {
                image: probe.originalImage,
                originalImage: probe.originalImage,
                normalizedImage: probe.image,
                denoisedImage: probe.denoisedImage,
                enhancedImage: probe.enhancedImage,
                gaborEnhancedImage: probe.gaborEnhancedImage,
                binarizedImage: probe.binarizedImage,
                thinnedImage: probe.thinnedImage,
                minutiaeOverlayImage: probe.minutiaeOverlayImage,
                quality: probe.quality,
                qualityMetrics: probe.qualityMetrics,
                preprocessing: probe.preprocessing,
                inputMetrics: probe.inputMetrics,
                minutiae: probe.minutiae,
                crossingNumberMinutiae: probe.academicMinutiae,
                bozorth3Minutiae: probe.minutiae,
                minutiaeCount: probe.minutiae.length,
                bozorth3MinutiaeCount: probe.minutiae.length,
                width: probe.width,
                height: probe.height
            },
            reference: {
                image: reference.originalImage,
                originalImage: reference.originalImage,
                normalizedImage: reference.image,
                denoisedImage: reference.denoisedImage,
                enhancedImage: reference.enhancedImage,
                gaborEnhancedImage: reference.gaborEnhancedImage,
                binarizedImage: reference.binarizedImage,
                thinnedImage: reference.thinnedImage,
                minutiaeOverlayImage: reference.minutiaeOverlayImage,
                quality: reference.quality,
                qualityMetrics: reference.qualityMetrics,
                preprocessing: reference.preprocessing,
                inputMetrics: reference.inputMetrics,
                minutiae: reference.minutiae,
                crossingNumberMinutiae: reference.academicMinutiae,
                bozorth3Minutiae: reference.minutiae,
                minutiaeCount: reference.minutiae.length,
                bozorth3MinutiaeCount: reference.minutiae.length,
                width: reference.width,
                height: reference.height
            }
        });
        return res.json(comparisonResult);
    } catch (error) {
        logServiceEvent(traceContext, 'academic_compare_failed', 'Academic matcher comparison could not prepare the shared fingerprints.', {
            error: error.message
        }, 'error');
        return res.status(500).json({ success: false, traceId: traceContext.traceId, error: error.message });
    }
});

// Get scanner info
app.get('/scanner-info', (req, res) => {
    checkScannerStatus();
    const sdkAdapterConfigured = isCommandScannerProvider() && !!SCANNER_CONFIG.captureCommand;
    res.json({
        available: scannerAvailable,
        name: getScannerDisplayName(),
        model: SCANNER_CONFIG.provider === 'zkteco-zk9500' ? 'ZK9500' : 'Vendor SDK/CLI adapter',
        provider: SCANNER_CONFIG.provider,
        formats: ['RAW sensor capture', 'PNG preview output', 'ISO template output'],
        sdk_adapter_configured: sdkAdapterConfigured,
        capture_command_configured: !!SCANNER_CONFIG.captureCommand,
        capture_command: SCANNER_CONFIG.captureCommand,
        simulation_allowed: SCANNER_CONFIG.allowSimulation,
        connection: 'USB',
        status: scannerAvailable ? (SCANNER_CONFIG.provider === 'simulation' ? 'SIMULATION' : 'READY') : 'NOT AVAILABLE'
    });
});

// Get list of detected USB devices (for debugging)
app.get('/devices', (req, res) => {
    try {
        const devices = HID.devices();
        const deviceList = devices.map(dev => ({
            path: dev.path,
            vendor_id: '0x' + dev.vendorId.toString(16).padStart(4, '0'),
            product_id: '0x' + dev.productId.toString(16).padStart(4, '0'),
            manufacturer: dev.manufacturer || 'Unknown',
            product: dev.product || 'Unknown',
            is_bound_path: scannerBinding.path ? (dev.path === scannerBinding.path) : false,
            likely_scanner: (() => {
                const p = String(dev.path || '').toLowerCase();
                if (p.includes('\\kbd')) return false;
                const t = `${dev.manufacturer || ''} ${dev.product || ''}`.toLowerCase();
                return t.includes('finger') || t.includes('biometric') || t.includes('scanner');
            })()
        }));
        
        res.json({
            total_devices: deviceList.length,
            devices: deviceList,
            provider: SCANNER_CONFIG.provider,
            capture_command_configured: !!SCANNER_CONFIG.captureCommand,
            capture_command: SCANNER_CONFIG.captureCommand,
            simulation_allowed: SCANNER_CONFIG.allowSimulation,
            bound_path: scannerBinding.path
        });
    } catch (error) {
        res.status(500).json({
            error: error.message
        });
    }
});

// Runtime scanner binding/config update without restarting process.
app.post('/scanner-config', (req, res) => {
    try {
        const { path: scannerPath, provider } = req.body || {};
        if (provider !== undefined) {
            const normalizedProvider = String(provider || '').trim().toLowerCase();
            if (!['zkteco-zk9500', 'command', 'simulation'].includes(normalizedProvider)) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid provider. Use zkteco-zk9500, command, or simulation.'
                });
            }
            SCANNER_CONFIG.provider = normalizedProvider;
        }
        if (scannerPath !== undefined) scannerBinding.path = scannerPath || null;

        checkScannerStatus();

        return res.json({
            success: true,
            provider: SCANNER_CONFIG.provider,
            bound_path: scannerBinding.path,
            capture_command_configured: !!SCANNER_CONFIG.captureCommand,
            simulation_allowed: SCANNER_CONFIG.allowSimulation,
            scanner_available: scannerAvailable
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================================================
// START SERVER
// ============================================================================

initializeScanner();

app.listen(port, () => {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║  MINUTIAE Fingerprint Scanner Service                  ║');
    console.log(`║  Running on: http://localhost:${port}                      ║`);
    console.log(`║  Scanner Status: ${scannerAvailable ? 'READY' : 'NOT AVAILABLE'}                         ║`);
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Dashboard will connect to: http://localhost:9000/scan');
    console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[INFO] Shutting down fingerprint service...');
    process.exit(0);
});
