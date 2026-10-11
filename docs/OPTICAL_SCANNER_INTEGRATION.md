# ZKTeco ZK9500 Optical Fingerprint Scanner Integration

Minutiae now captures real ZKTeco ZK9500 optical scanner images through the local Node scanner service at `http://localhost:9000/scan`.

The service supports these providers:

- `zkteco-zk9500`: default. Calls the ZKTeco SDK adapter and processes the captured image through Minutiae AFIS.
- `command`: optional generic vendor SDK/CLI command adapter.
- `simulation`: development-only generated fingerprints. This is disabled unless explicitly enabled.

## Recommended Setup

Install the ZKTeco/FPSensor driver, then build `scripts/zkteco-zk9500-capture.cs` into `scripts/zkteco-zk9500-capture.exe`. On this workstation the adapter uses the native DLL at `C:\Program Files (x86)\FPSensor\Biokey\ZKFPCap_ASYNC.dll`.

Example PowerShell session:

```powershell
cd C:\xampp\htdocs\Minutiae
npm run scanner:diagnose
node fingerprint-service.js
```

If the adapter lives somewhere else, configure it explicitly:

```powershell
$env:SCANNER_PROVIDER = "zkteco-zk9500"
$env:SCANNER_CAPTURE_COMMAND = "C:\Path\To\zkteco-zk9500-capture.exe"
node fingerprint-service.js
```

The service creates a temporary output path and replaces these placeholders before running the adapter:

- `{output}`: absolute path where the scanner command should write a fingerprint image
- `{type}`: `applicant` or `criminal`
- `{timeout}`: capture timeout in milliseconds
- `{format}`: configured output image extension, default `raw` for ZK9500 scanner capture

The scanner command can either:

1. Write an image or raw grayscale sensor bytes to `{output}`.
2. Print JSON to stdout with one of these fields:

```json
{
  "imagePath": "C:\\captures\\fingerprint.png",
  "source": "ZKTeco ZK9500"
}
```

or:

```json
{
  "imageBase64": "base64-encoded-image-content",
  "source": "ZKTeco ZK9500"
}
```

Minutiae converts the captured image into the internal ISO-style template, stores the normalized image for audit/review, and uses the same Bozorth3-enhanced AFIS comparison path used by uploaded fingerprints.

## No Silent Synthetic Fallback

Generated scans are no longer used automatically. If scanner capture fails, `/scan` returns an error unless development simulation is explicitly enabled:

```powershell
$env:SCANNER_PROVIDER = "simulation"
$env:SCANNER_ALLOW_SIMULATION = "1"
node fingerprint-service.js
```

Use simulation only for UI/lab testing, not real enrollment or applicant clearance.

## Verify

Start the service, then open:

- `http://localhost:9000/health`
- `http://localhost:9000/scanner-info`
- `service-test.html`

For live operations:

- Applicant checks use `dashboard.html` and the existing **Scan with ZK9500** button after a demographic hit.
- Criminal enrollment and replacement use `admin.html` and the **Scan with ZK9500** buttons in the register/edit forms.
