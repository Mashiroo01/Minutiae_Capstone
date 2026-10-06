// Test script to extract and save fingerprint image for verification
const fs = require('fs');
const http = require('http');

async function testFingerprintImage() {
    console.log('[TEST] Requesting fingerprint image from service...');
    
    const data = JSON.stringify({ type: 'applicant' });
    
    const options = {
        hostname: 'localhost',
        port: 9000,
        path: '/scan',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
    };
    
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let responseData = '';
            
            res.on('data', (chunk) => {
                responseData += chunk;
            });
            
            res.on('end', () => {
                try {
                    const json = JSON.parse(responseData);
                    
                    if (json.success && json.image) {
                        console.log('[SUCCESS] Fingerprint image received');
                        console.log(`[INFO] Image size: ${json.image.length} characters`);
                        console.log(`[INFO] Quality: ${json.quality}`);
                        
                        // Decode base64 and save as PNG
                        const imageBuffer = Buffer.from(json.image, 'base64');
                        const outputPath = './fingerprint-test.png';
                        fs.writeFileSync(outputPath, imageBuffer);
                        
                        console.log(`[SUCCESS] Fingerprint image saved to: ${outputPath}`);
                        console.log(`[INFO] PNG file size: ${imageBuffer.length} bytes`);
                        
                        // Verify PNG header
                        const pngSignature = imageBuffer.slice(0, 8).toString('hex');
                        if (pngSignature === '89504e470d0a1a0a') {
                            console.log('[✓] Valid PNG file signature');
                        }
                        
                        resolve({
                            success: true,
                            size: imageBuffer.length,
                            quality: json.quality
                        });
                    } else {
                        reject('No image in response');
                    }
                } catch (e) {
                    reject(e.message);
                }
            });
        });
        
        req.on('error', (e) => {
            reject(e.message);
        });
        
        req.write(data);
        req.end();
    });
}

// Wait for scan to complete (~3 seconds)
setTimeout(() => {
    testFingerprintImage()
        .then(result => {
            console.log('\n[RESULT] Fingerprint test completed successfully');
            console.log(`[RESULT] Image size: ${result.size} bytes`);
            console.log(`[RESULT] Quality: ${result.quality}`);
            console.log('\n[NEXT] Open fingerprint-test.png to verify fingerprint ridges are visible');
            process.exit(0);
        })
        .catch(err => {
            console.error('[ERROR]', err);
            process.exit(1);
        });
}, 3500);
