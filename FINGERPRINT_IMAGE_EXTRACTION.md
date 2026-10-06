# Fingerprint Image Extraction From ZKTeco ZK9500

Minutiae extracts real optical fingerprint images from the ZKTeco ZK9500 through
the local scanner service.

## Capture Flow

```text
ZK9500 optical scanner
  -> ZKTeco ZKFinger SDK
  -> scripts/zkteco-zk9500-capture.exe
  -> fingerprint-service.js
  -> AFIS preprocessing, minutiae extraction, and ISO-style template storage
```

The adapter writes or returns a grayscale fingerprint image. The Node service
normalizes and enhances the image, extracts minutiae, and returns:

```json
{
  "success": true,
  "source": "ZKTeco ZK9500",
  "image": "base64 PNG",
  "enhancedImage": "base64 PNG",
  "thinnedImage": "base64 PNG",
  "templateBase64": "base64 AFIS template",
  "afisQuality": 92,
  "scanned": true
}
```

## Files

- `fingerprint-service.js`: local HTTP service and AFIS processing pipeline
- `scripts/zkteco-zk9500-capture.cs`: ZKTeco SDK adapter source
- `check-zkteco-zk9500.js`: adapter and USB diagnostic script
- `service-test.html`: internal lab page for scan, upload, and AFIS comparison testing

## Testing

```powershell
cd C:\xampp\htdocs\Minutiae
npm run scanner:diagnose
node fingerprint-service.js
```

Then open:

```text
http://localhost:9000/scanner-info
```

The scanner should report `READY` before live capture is used for clearance or
criminal enrollment.
