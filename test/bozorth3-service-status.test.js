'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('fingerprint service publishes the executable backing Modified Bozorth3', () => {
    const source = fs.readFileSync(path.join(root, 'fingerprint-service.js'), 'utf8');

    assert.match(source, /bozorth3Ready:/);
    assert.match(source, /bozorth3Path:\s*AFIS_CONFIG\.bozorth3Path/);
    assert.match(source, /cygwinBashPath:\s*AFIS_CONFIG\.cygwinBashPath/);
});

test('PHP system status reports the operational fingerprint-service Bozorth3 capability', () => {
    const php = `
        require 'backend/Bozorth3Matcher.php';
        $fetcher = function ($url) {
            return json_encode([
                'success' => true,
                'afis' => [
                    'academicMatchers' => [
                        'bozorth3Ready' => true,
                        'bozorth3Path' => '/home/mendi/nbis/bozorth3/bin/bozorth3',
                        'cygwinBashPath' => 'C:\\\\cygwin64\\\\bin\\\\bash.exe',
                        'mindtctReady' => true,
                        'sourceAfisReady' => true,
                        'openAfisReady' => false,
                        'mccReady' => true,
                        'jiangReady' => true
                    ]
                ],
                'scanner' => [
                    'available' => false,
                    'provider' => 'zkteco-zk9500',
                    'captureCommandConfigured' => true,
                    'simulationAllowed' => false
                ]
            ]);
        };
        $matcher = new Bozorth3Matcher('C:\\\\missing\\\\bozorth3.exe', $fetcher, 'http://fingerprint.test:9000');
        echo json_encode($matcher->getStatus());
    `;
    const result = spawnSync('php', ['-r', php], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true
    });

    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.installed, true);
    assert.equal(status.source, 'fingerprint_service');
    assert.equal(status.path, '/home/mendi/nbis/bozorth3/bin/bozorth3');
    assert.equal(status.service_status.connected, true);
    assert.equal(status.scanner_status.available, false);
    assert.equal(status.scanner_status.provider, 'zkteco-zk9500');
    assert.equal(status.scanner_status.simulation_allowed, false);
    assert.equal(status.matcher_status.mindtct, true);
    assert.equal(status.matcher_status.sourceafis, true);
});

test('PHP system status distinguishes an unreachable fingerprint service from Bozorth3 installation', () => {
    const php = `
        require 'backend/Bozorth3Matcher.php';
        $fetcher = function ($url) { return false; };
        $matcher = new Bozorth3Matcher('C:\\\\missing\\\\bozorth3.exe', $fetcher, 'http://fingerprint.test:9000');
        echo json_encode($matcher->getStatus());
    `;
    const result = spawnSync('php', ['-r', php], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true
    });

    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.service_status.connected, false);
    assert.equal(status.service_status.url, 'http://fingerprint.test:9000');
    assert.match(status.service_status.message, /unreachable/i);
});
