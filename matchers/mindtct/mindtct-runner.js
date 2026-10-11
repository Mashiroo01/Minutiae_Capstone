'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { toCygwinPath } = require('../bozorth3/bozorth3-runner');

function quoteBash(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function normalizeDegrees(value) {
    return ((value % 360) + 360) % 360;
}

function parseMindtctOutput(output) {
    const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.map((line, index) => {
        const fields = line.split(/\s+/).map(Number);
        if (fields.length !== 5 || fields.some((value) => !Number.isFinite(value))) {
            throw new Error(`Invalid MINDTCT output at line ${index + 1}.`);
        }
        const [x, y, nistDirection, reliability, nativeType] = fields;
        if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(nistDirection)) {
            throw new Error(`Invalid MINDTCT coordinate or direction at line ${index + 1}.`);
        }
        if (nativeType !== 0 && nativeType !== 1) {
            throw new Error(`Invalid MINDTCT minutia type at line ${index + 1}.`);
        }
        const clockwiseDegrees = normalizeDegrees(nistDirection);
        return {
            x,
            y,
            angle: clockwiseDegrees * Math.PI / 180,
            quality: Math.round(Math.max(0, Math.min(1, reliability)) * 100),
            type: nativeType === 1 ? 'ending' : 'bifurcation',
            source: 'NIST NBIS MINDTCT',
            nistDirection,
            reliability
        };
    });
}

function filterMindtctMinutiaeBySkeleton(minutiae, skeleton, width, height, options = {}) {
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
        throw new Error('Skeleton validation requires positive integer width and height.');
    }
    if (!skeleton || skeleton.length !== width * height) {
        throw new Error(`Skeleton validation requires exactly ${width * height} pixels.`);
    }
    const radius = Math.max(0, Math.floor(Number(options.radius) || 0));
    const accepted = [];
    const rejected = [];
    for (const candidate of Array.isArray(minutiae) ? minutiae : []) {
        const imageX = Math.round(Number(candidate.x));
        const imageY = Math.round(height - Number(candidate.y));
        let supported = false;
        for (let oy = -radius; oy <= radius && !supported; oy++) {
            for (let ox = -radius; ox <= radius; ox++) {
                const x = imageX + ox;
                const y = imageY + oy;
                if (x >= 0 && y >= 0 && x < width && y < height && skeleton[y * width + x] === 1) {
                    supported = true;
                    break;
                }
            }
        }
        const decorated = {
            ...candidate,
            imageX,
            imageY,
            imageAngle: normalizeDegrees(360 - ((Number(candidate.angle) * 180) / Math.PI)) * Math.PI / 180,
            skeletonSupported: supported,
            skeletonRadius: radius
        };
        (supported ? accepted : rejected).push(decorated);
    }
    return { accepted, rejected, radius };
}

function defaultExecute({ executablePath, cygwinBashPath, inputPath, width, height, ppi, timeoutMs }) {
    if (cygwinBashPath && fs.existsSync(cygwinBashPath)) {
        const command = [toCygwinPath(executablePath), toCygwinPath(inputPath), width, height, ppi]
            .map(quoteBash)
            .join(' ');
        const run = spawnSync(cygwinBashPath, ['-lc', command], {
            encoding: 'utf8',
            timeout: timeoutMs,
            windowsHide: true
        });
        return { ...run, command: `${cygwinBashPath} -lc ${command}` };
    }
    const run = spawnSync(executablePath, [inputPath, String(width), String(height), String(ppi)], {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true
    });
    return { ...run, command: `${executablePath} "${inputPath}" ${width} ${height} ${ppi}` };
}

function runMindtctExtractor(options = {}) {
    const width = Number(options.width);
    const height = Number(options.height);
    const ppi = Number(options.ppi || 500);
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
        throw new Error('MINDTCT requires positive integer width and height.');
    }
    const pixels = Buffer.from(options.pixels || []);
    if (pixels.length !== width * height) {
        throw new Error(`MINDTCT requires exactly ${width * height} grayscale pixels; received ${pixels.length}.`);
    }
    if (!Number.isFinite(ppi) || ppi <= 0) throw new Error('MINDTCT requires a positive PPI value.');

    const config = {
        executablePath: path.join(__dirname, 'mindtct-raw.exe'),
        cygwinBashPath: 'C:\\cygwin64\\bin\\bash.exe',
        tempDir: path.join(os.tmpdir(), 'Minutiae', 'mindtct'),
        timeoutMs: 30000,
        ...(options.config || {})
    };
    const execute = typeof options.execute === 'function' ? options.execute : defaultExecute;
    fs.mkdirSync(config.tempDir, { recursive: true });
    const inputPath = path.join(config.tempDir, `mindtct_${crypto.randomUUID()}.raw`);
    try {
        if (!options.execute && !fs.existsSync(config.executablePath)) {
            throw new Error(`MINDTCT raw extractor is not available at ${config.executablePath}.`);
        }
        fs.writeFileSync(inputPath, pixels);
        const run = execute({
            executablePath: config.executablePath,
            cygwinBashPath: config.cygwinBashPath,
            inputPath,
            width,
            height,
            ppi,
            timeoutMs: config.timeoutMs
        });
        if (run.error) throw run.error;
        if (run.status !== 0) {
            throw new Error(String(run.stderr || run.stdout || `MINDTCT exited with status ${run.status}.`).trim());
        }
        return {
            status: 'ok',
            engineName: 'NIST NBIS MINDTCT',
            minutiae: parseMindtctOutput(run.stdout),
            execution: {
                command: run.command || config.executablePath,
                exitCode: run.status,
                stderr: String(run.stderr || '').trim()
            }
        };
    } finally {
        try {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
        } catch (_) {
            // Cleanup failure must not hide extraction results.
        }
    }
}

module.exports = {
    filterMindtctMinutiaeBySkeleton,
    parseMindtctOutput,
    runMindtctExtractor
};
