'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runMccMatcher, runJiangMatcher } = require('../matchers/mpi-afis/mpi-afis-runner');
const { createIsotropicCanvas, toOpenAfisCsv } = require('../matchers/openafis/openafis-adapter');

const projectRoot = path.join(__dirname, '..');
const mccExecutable = path.join(projectRoot, 'matchers', 'mpi-afis', 'mcc-match.exe');
const jiangExecutable = path.join(projectRoot, 'matchers', 'mpi-afis', 'jiang-match.exe');
const openAfisExecutable = path.join(projectRoot, 'matchers', 'openafis', 'openafis-match.exe');
const cygwinBash = process.env.CYGWIN_BASH || 'C:\\cygwin64\\bin\\bash.exe';

const probe = Array.from({ length: 28 }, (_, index) => ({
    x: 70 + ((index * 73) % 340),
    y: 65 + ((index * 97) % 350),
    angle: ((index * 0.47) + 0.03) % (Math.PI * 2),
    quality: 90,
    type: index % 4 === 0 ? 'bifurcation' : 'ending'
}));

function rigidTransform(points, rotationDeg, translateX, translateY) {
    const rotation = rotationDeg * Math.PI / 180;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const center = { x: 250, y: 250 };
    return points.map((point) => {
        const x = point.x - center.x;
        const y = point.y - center.y;
        return {
            ...point,
            x: (x * cos) - (y * sin) + center.x + translateX,
            y: (x * sin) + (y * cos) + center.y + translateY,
            angle: point.angle + rotation
        };
    });
}

function toCygwinPath(filePath) {
    const normalized = path.resolve(filePath).replace(/\\/g, '/');
    const match = normalized.match(/^([A-Za-z]):\/(.*)$/);
    return match ? `/cygdrive/${match[1].toLowerCase()}/${match[2]}` : normalized;
}

function runOpenAfis(reference) {
    const tempRoot = path.join(os.tmpdir(), 'Minutiae', 'geometry-tests');
    fs.mkdirSync(tempRoot, { recursive: true });
    const nonce = crypto.randomUUID();
    const probePath = path.join(tempRoot, `${nonce}-probe.csv`);
    const referencePath = path.join(tempRoot, `${nonce}-reference.csv`);
    const canvas = createIsotropicCanvas({ width: 560, height: 560 }, { width: 560, height: 560 });
    try {
        fs.writeFileSync(probePath, toOpenAfisCsv(probe, canvas));
        fs.writeFileSync(referencePath, toOpenAfisCsv(reference, canvas));
        const command = `"${toCygwinPath(openAfisExecutable)}" "${toCygwinPath(probePath)}" "${toCygwinPath(referencePath)}"`;
        const run = spawnSync(cygwinBash, ['-lc', command], { encoding: 'utf8', timeout: 10000, windowsHide: true });
        if (run.error || run.status !== 0) throw run.error || new Error(run.stderr || run.stdout);
        return JSON.parse(String(run.stdout).trim().split(/\r?\n/).pop()).score;
    } finally {
        for (const filePath of [probePath, referencePath]) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
    }
}

for (const rotationDeg of [0, 5, 10, 15, 20, -12]) {
    test(`OpenAFIS, MCC, and Jiang tolerate a rigid ${rotationDeg} degree rotation plus translation`, () => {
        const reference = rigidTransform(probe, rotationDeg, 18, -11);
        const openAfisScore = runOpenAfis(reference);
        const mcc = runMccMatcher({
            probeMinutiae: probe,
            referenceMinutiae: reference,
            threshold: 0.04,
            config: { executablePath: mccExecutable }
        });
        const jiang = runJiangMatcher({
            probeMinutiae: probe,
            referenceMinutiae: reference,
            threshold: 0.245,
            config: { executablePath: jiangExecutable }
        });

        assert.ok(openAfisScore >= 6, `OpenAFIS score ${openAfisScore}`);
        assert.equal(mcc.result, 'MATCH', `MCC score ${mcc.rawScore}`);
        assert.equal(jiang.result, 'MATCH', `Jiang score ${jiang.rawScore}`);
    });
}
