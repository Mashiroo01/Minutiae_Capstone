'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TWO_PI = Math.PI * 2;

function normalizeRadians(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error('SourceAFIS returned a non-finite minutia direction.');
    return ((number % TWO_PI) + TWO_PI) % TWO_PI;
}

function parseSerializedFeatureTemplate(payload) {
    const template = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const width = Number(template?.width);
    const height = Number(template?.height);
    const positionsX = template?.positionsX;
    const positionsY = template?.positionsY;
    const directions = template?.directions;
    const types = template?.types;
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
        throw new Error('SourceAFIS minutiae template has invalid image dimensions.');
    }
    if (!Array.isArray(positionsX) || !Array.isArray(positionsY) || !Array.isArray(directions) || typeof types !== 'string') {
        throw new Error('SourceAFIS minutiae template is missing required feature arrays.');
    }
    const count = positionsX.length;
    if (positionsY.length !== count || directions.length !== count || types.length !== count) {
        throw new Error('SourceAFIS minutiae template contains inconsistent feature counts.');
    }
    const minutiae = positionsX.map((xValue, index) => {
        const x = Number(xValue);
        const y = Number(positionsY[index]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error(`SourceAFIS returned an invalid minutia position at index ${index}.`);
        }
        const typeCode = types[index];
        if (typeCode !== 'E' && typeCode !== 'B') {
            throw new Error(`SourceAFIS returned an unknown minutia type at index ${index}.`);
        }
        return {
            x,
            y,
            angle: normalizeRadians(directions[index]),
            quality: 100,
            type: typeCode === 'B' ? 'bifurcation' : 'ending'
        };
    });
    return {
        width,
        height,
        minutiae,
        source: 'SourceAFIS feature extraction (score-independent)',
        coordinateConvention: 'top-left origin; +X right; +Y down; original image pixels',
        angleConvention: 'radians clockwise in image coordinates; [0, 2π)'
    };
}

function extractMinutiaePair(options) {
    const startedAt = process.hrtime.bigint();
    const tempDir = options.tempDir;
    fs.mkdirSync(tempDir, { recursive: true });
    const nonce = crypto.randomUUID();
    const probePath = path.join(tempDir, `sourceafis_features_probe_${nonce}.png`);
    const referencePath = path.join(tempDir, `sourceafis_features_reference_${nonce}.png`);
    try {
        fs.writeFileSync(probePath, options.probeImageBuffer);
        fs.writeFileSync(referencePath, options.referenceImageBuffer);
        const run = spawnSync(options.javaPath || 'java', [
            '-cp', options.classPath,
            'SourceAfisMinutiaeCli', '--pair',
            String(options.probeDpi || 500), String(options.referenceDpi || 500),
            probePath, referencePath
        ], {
            encoding: 'utf8',
            timeout: options.timeoutMs || 30000,
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024
        });
        if (run.error) throw run.error;
        if (run.status !== 0) {
            throw new Error(String(run.stderr || run.stdout || `SourceAFIS feature extraction exited with status ${run.status}.`).trim());
        }
        const line = String(run.stdout || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean).pop();
        const templates = JSON.parse(line);
        if (!Array.isArray(templates) || templates.length !== 2) {
            throw new Error('SourceAFIS feature extractor returned an invalid pair payload.');
        }
        return {
            probe: parseSerializedFeatureTemplate(templates[0]),
            reference: parseSerializedFeatureTemplate(templates[1]),
            processingTimeMs: Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 100) / 100
        };
    } finally {
        for (const filePath of [probePath, referencePath]) {
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            } catch (_) {
                // Cleanup must not hide extraction output or failure.
            }
        }
    }
}

module.exports = {
    extractMinutiaePair,
    normalizeRadians,
    parseSerializedFeatureTemplate
};
