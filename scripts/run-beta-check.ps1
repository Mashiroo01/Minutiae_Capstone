[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

function Invoke-BetaStep {
    param([string]$Name, [string[]]$Arguments)
    Write-Host "`n=== $Name ==="
    & npm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE."
    }
}

Invoke-BetaStep 'Regression suite' @('test')
Invoke-BetaStep 'Production dependency audit' @('audit', '--omit=dev')
Invoke-BetaStep 'Five-matcher live matrix' @('run', 'matchers:verify')
Invoke-BetaStep 'Modified Bozorth3 calibrated quality gate' @('run', 'modified-bozorth3:verify-quality')
Invoke-BetaStep 'Authenticated application smoke test' @('run', 'beta:smoke')

Write-Host "`nBETA RELEASE GATE: PASS"
