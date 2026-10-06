# Fingerprint Scanner Integration Guide - ZKTeco ZK9500

Minutiae is now configured for the ZKTeco ZK9500 optical fingerprint scanner.
The browser pages call the local Node service at `http://localhost:9000/scan`.
The Node service calls the ZKTeco SDK adapter, captures a real optical image,
then converts that image into the internal AFIS/ISO-style template used by the
existing matching workflow.

## Required Hardware And SDK

- ZKTeco ZK9500 optical fingerprint scanner
- ZKTeco/FPSensor Windows driver
- Native capture DLL installed at `C:\Program Files (x86)\FPSensor\Biokey\ZKFPCap_ASYNC.dll`
- Node.js dependencies already installed from `package.json`

## Build The ZK9500 Adapter

The adapter source is `scripts/zkteco-zk9500-capture.cs`. Build it into:

```text
scripts/zkteco-zk9500-capture.exe
```

Build command used for this workstation:

```powershell
cd C:\xampp\htdocs\Minutiae
C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe /nologo /platform:x86 /target:exe /out:scripts\zkteco-zk9500-capture.exe scripts\zkteco-zk9500-capture.cs
```

If you already have a vendor-provided executable, set:

```powershell
$env:SCANNER_CAPTURE_COMMAND = "C:\Path\To\Your\ZK9500Capture.exe"
```

## Start The Service

```powershell
cd C:\xampp\htdocs\Minutiae
npm run scanner:diagnose
node fingerprint-service.js
```

Check readiness in a browser:

```text
http://localhost:9000/health
http://localhost:9000/scanner-info
```

The expected provider is `zkteco-zk9500`. The expected scanner name is
`ZKTeco ZK9500 Optical Fingerprint Scanner`.

## Use In The App

- Applicant checks use `dashboard.html` and the **Scan with ZK9500** button.
- Criminal enrollment and replacement use `admin.html` and the **Scan with ZK9500** buttons.
- Upload still works as a fallback for existing fingerprint files.

## Simulation

Synthetic scans are disabled by default. Use simulation only for UI/lab testing:

```powershell
$env:SCANNER_PROVIDER = "simulation"
$env:SCANNER_ALLOW_SIMULATION = "1"
node fingerprint-service.js
```

Do not use simulation for real applicant clearance or criminal enrollment.

## Troubleshooting

Run the diagnostic:

```powershell
npm run scanner:diagnose
```

If it says the adapter is missing, build `scripts/zkteco-zk9500-capture.exe`
from the C# source.

If it says no ZK9500 scanner was detected, verify:

- The ZK9500 is connected by USB.
- The ZKTeco driver appears cleanly in Device Manager.
- `ZKFPCap_ASYNC.dll` is installed in `C:\Program Files (x86)\FPSensor\Biokey`.
- No other application is currently holding the scanner.
- The service was restarted after installing the driver or adapter.
