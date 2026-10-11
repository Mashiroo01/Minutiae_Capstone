[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 9000
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$adapterPath = Join-Path $PSScriptRoot 'zkteco-zk9500-capture.exe'
$cygwinBash = 'C:\cygwin64\bin\bash.exe'
$bozorth3Path = '/home/mendi/nbis/bozorth3/bin/bozorth3'

if (-not (Test-Path -LiteralPath $adapterPath)) {
    throw "ZKTeco adapter not found: $adapterPath"
}
if (-not (Test-Path -LiteralPath $cygwinBash)) {
    throw "Cygwin bash not found: $cygwinBash"
}

$adapterStatusJson = & $adapterPath --status
if ($LASTEXITCODE -ne 0) {
    Write-Warning 'The ZKTeco SDK adapter could not query the scanner. Service will start in real-only mode for diagnostics.'
}
$adapterStatus = $adapterStatusJson | ConvertFrom-Json -ErrorAction SilentlyContinue
if (-not $adapterStatus -or -not $adapterStatus.available) {
    Write-Warning 'No ZKTeco ZK9500 was detected. Service will start in real-only mode and report the scanner offline until USB, FPSensor, and SDK access are ready.'
}

$env:PORT = [string]$Port
$env:SCANNER_PROVIDER = 'zkteco-zk9500'
$env:SCANNER_CAPTURE_COMMAND = $adapterPath
$env:SCANNER_ALLOW_SIMULATION = 'false'
$env:SCANNER_CAPTURE_OUTPUT_EXTENSION = 'raw'
$env:CYGWIN_BASH = $cygwinBash
$env:BOZORTH3_PATH = $bozorth3Path
$env:MINUTIAE_TEMP_DIR = Join-Path $projectRoot 'temp'
$env:SCANNER_CAPTURE_TEMP_DIR = Join-Path $projectRoot 'temp\scanner'

Write-Host "Starting the real-only ZKTeco service on port $Port. Simulation is disabled."
& node (Join-Path $projectRoot 'fingerprint-service.js')
exit $LASTEXITCODE
