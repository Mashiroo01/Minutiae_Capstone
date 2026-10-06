const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const HID = require('node-hid');

const adapterPath = process.env.SCANNER_CAPTURE_COMMAND
    || process.env.ZKTECO_CAPTURE_COMMAND
    || path.join(__dirname, 'scripts', 'zkteco-zk9500-capture.exe');

function parseJson(text) {
    const value = String(text || '').trim();
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch (error) {
        const firstBrace = value.indexOf('{');
        const lastBrace = value.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace <= firstBrace) return null;
        try {
            return JSON.parse(value.slice(firstBrace, lastBrace + 1));
        } catch (innerError) {
            return null;
        }
    }
}

console.log('MINUTIAE ZKTeco ZK9500 Optical Scanner Diagnostic');
console.log('==================================================');
console.log(`Adapter: ${adapterPath}`);

if (!fs.existsSync(adapterPath)) {
    console.log('\nNOT READY: ZK9500 adapter executable was not found.');
    console.log('Build scripts/zkteco-zk9500-capture.cs with the .NET Framework x86 compiler,');
    console.log('or set SCANNER_CAPTURE_COMMAND / ZKTECO_CAPTURE_COMMAND to your compiled adapter.');
} else {
    const result = spawnSync(adapterPath, ['--status'], {
        cwd: __dirname,
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
    });
    const data = parseJson(result.stdout);

    if (result.error) {
        console.log(`\nNOT READY: Adapter status check failed: ${result.error.message}`);
    } else if (data && data.available) {
        console.log('\nREADY: ZKTeco ZK9500 scanner detected by the SDK adapter.');
        console.log(`Device count: ${data.deviceCount ?? 'unknown'}`);
        console.log(`Source: ${data.source || 'ZKTeco ZK9500'}`);
    } else {
        console.log('\nNOT READY: Adapter ran, but no ZK9500 scanner was detected.');
        if (data && data.error) console.log(`Adapter error: ${data.error}`);
        if (result.stderr) console.log(`Adapter stderr: ${result.stderr.trim()}`);
    }
}

console.log('\nVisible HID devices (diagnostic only):');
try {
    const devices = HID.devices();
    if (!devices.length) {
        console.log('  No HID devices visible.');
    }
    devices.forEach((dev, idx) => {
        const vid = '0x' + dev.vendorId.toString(16).padStart(4, '0');
        const pid = '0x' + dev.productId.toString(16).padStart(4, '0');
        const manufacturer = dev.manufacturer || 'Unknown manufacturer';
        const product = dev.product || 'Unknown product';
        console.log(`  ${String(idx).padStart(2)} ${vid}:${pid} ${manufacturer} ${product}`);
    });
} catch (error) {
    console.log(`  Unable to list HID devices: ${error.message}`);
}

console.log('\nNext steps:');
console.log('1. Install the ZKTeco/FPSensor driver for the ZK9500.');
console.log('2. Build scripts/zkteco-zk9500-capture.cs into scripts/zkteco-zk9500-capture.exe.');
console.log('3. Start the service with: node fingerprint-service.js');
console.log('4. Open http://localhost:9000/scanner-info to confirm status is READY.');
