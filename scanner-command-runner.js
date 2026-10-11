const { spawn } = require('child_process');

function createRunnerError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function runScannerCommand(command, args, options = {}) {
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || 45000);
    const maxBuffer = Math.max(1024, Number(options.maxBuffer) || 20 * 1024 * 1024);

    return new Promise((resolve, reject) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        let outputBytes = 0;

        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            callback(value);
        };

        const timer = setTimeout(() => {
            child.kill();
            finish(
                reject,
                createRunnerError(
                    `Scanner SDK command exceeded its ${timeoutMs} ms process limit.`,
                    'SCANNER_CAPTURE_TIMEOUT'
                )
            );
        }, timeoutMs);

        const appendOutput = (target, chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > maxBuffer) {
                child.kill();
                finish(
                    reject,
                    createRunnerError('Scanner SDK command produced too much output.', 'SCANNER_CAPTURE_OUTPUT_LIMIT')
                );
                return target;
            }
            return target + chunk.toString('utf8');
        };

        child.stdout.on('data', (chunk) => {
            stdout = appendOutput(stdout, chunk);
        });
        child.stderr.on('data', (chunk) => {
            stderr = appendOutput(stderr, chunk);
        });
        child.on('error', (error) => finish(reject, error));
        child.on('close', (status, signal) => finish(resolve, {
            status,
            signal,
            stdout,
            stderr
        }));

        if (options.input !== undefined) {
            child.stdin.end(String(options.input));
        } else {
            child.stdin.end();
        }
    });
}

module.exports = { runScannerCommand };
