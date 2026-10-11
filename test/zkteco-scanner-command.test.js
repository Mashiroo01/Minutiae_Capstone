const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { runScannerCommand } = require('../scanner-command-runner');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

async function waitForService(port) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.ok) return;
        } catch (_) {
            // The child process is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Fingerprint service did not become ready in time.');
}

test('scanner command timeout is bounded and reports a stable error code', async () => {
    const startedAt = Date.now();

    await assert.rejects(
        runScannerCommand(
            process.execPath,
            ['-e', 'setTimeout(() => {}, 10000)'],
            { timeoutMs: 100, cwd: __dirname }
        ),
        (error) => error && error.code === 'SCANNER_CAPTURE_TIMEOUT'
    );

    assert.ok(Date.now() - startedAt < 3000, 'timed-out scanner process should be terminated promptly');
});

test('scanner command preserves stdout, stderr, and exit status', async () => {
    const result = await runScannerCommand(
        process.execPath,
        ['-e', "process.stdout.write('scanner-output'); process.stderr.write('sdk-note'); process.exitCode = 6;"],
        { timeoutMs: 3000, cwd: __dirname }
    );

    assert.equal(result.status, 6);
    assert.equal(result.stdout, 'scanner-output');
    assert.equal(result.stderr, 'sdk-note');
});

test('ZK9500 adapter captures the raw image without requiring native template extraction', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'scripts', 'zkteco-zk9500-capture.cs'),
        'utf8'
    );

    assert.doesNotMatch(source, /zkfp2\.AcquireFingerprint\(/);
    assert.match(source, /zkfp2\.AcquireFingerprintImage\(/);
    assert.match(source, /captureMode\\":\\"image-only/);
});

test('scan falls back to simulation when the Docker host has no Windows scanner adapter', { timeout: 20000 }, async (t) => {
    const port = await getFreePort();
    const missingAdapter = path.join(__dirname, `missing-zkteco-adapter-${process.pid}.exe`);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'fingerprint-service.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            PORT: String(port),
            SCANNER_PROVIDER: 'zkteco-zk9500',
            SCANNER_CAPTURE_COMMAND: missingAdapter,
            SCANNER_ALLOW_SIMULATION: 'true'
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    let serviceOutput = '';
    child.stdout.on('data', (chunk) => { serviceOutput += chunk.toString(); });
    child.stderr.on('data', (chunk) => { serviceOutput += chunk.toString(); });
    t.after(() => child.kill());

    await waitForService(port);
    const response = await fetch(`http://127.0.0.1:${port}/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'applicant' })
    });
    const body = await response.json();

    assert.equal(response.status, 200, serviceOutput);
    assert.equal(body.success, true);
    assert.equal(body.scanned, false);
    assert.match(body.source, /simulat/i);
    assert.ok(body.image, 'simulation should return a fingerprint image');
});
