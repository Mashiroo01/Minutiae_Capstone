[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://127.0.0.1:8080',
    [string]$FingerprintUrl = 'http://127.0.0.1:9000'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $projectRoot '.env'

function Assert-BetaCondition {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw $Message
    }
}

function Read-LocalEnvironment {
    $settings = @{}
    foreach ($line in Get-Content -LiteralPath $environmentPath) {
        if ($line -match '^\s*([^#=]+)=(.*)$') {
            $settings[$matches[1].Trim()] = $matches[2].Trim().Trim('"')
        }
    }
    return $settings
}

Assert-BetaCondition (Test-Path -LiteralPath $environmentPath) 'The local .env file is missing.'
$settings = Read-LocalEnvironment
$username = $settings['MINUTIAE_ADMIN_USERNAME']
if ([string]::IsNullOrWhiteSpace($username)) { $username = 'admin' }
$password = $settings['MINUTIAE_ADMIN_PASSWORD']
Assert-BetaCondition (-not [string]::IsNullOrWhiteSpace($password)) 'MINUTIAE_ADMIN_PASSWORD is not configured.'

$publicPages = @('login.html', 'admin.html', 'dashboard.html', 'service-test.html', 'dataset-collector.html')
foreach ($page in $publicPages) {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$page"
    Assert-BetaCondition ($response.StatusCode -eq 200) "$page returned HTTP $($response.StatusCode)."
}

$unauthorizedStatus = $null
try {
    $unauthorizedResponse = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/backend/applicant_info.php?action=stats"
    $unauthorizedStatus = [int]$unauthorizedResponse.StatusCode
} catch {
    if ($null -ne $_.Exception.Response) {
        $unauthorizedStatus = [int]$_.Exception.Response.StatusCode
    } else {
        throw
    }
}
Assert-BetaCondition ($unauthorizedStatus -eq 401) 'Protected analytics did not reject an unauthenticated request with HTTP 401.'

$invalidLogin = Invoke-RestMethod -Method Post -Uri "$BaseUrl/backend/auth.php?action=login" -ContentType 'application/json' -Body '{"username":"","password":""}'
Assert-BetaCondition ($invalidLogin.success -ne $true -and -not [string]::IsNullOrWhiteSpace($invalidLogin.error)) 'Empty credentials were not rejected clearly.'

$fingerprintHealth = Invoke-RestMethod -Uri "$FingerprintUrl/health" -TimeoutSec 10
Assert-BetaCondition ($fingerprintHealth.status -eq 'running') 'Fingerprint service is not running.'
Assert-BetaCondition ($fingerprintHealth.scanner_available -eq $true) 'ZKTeco scanner is not available.'
Assert-BetaCondition ($fingerprintHealth.simulation_allowed -ne $true) 'Real-scanner beta gate must not allow simulation.'

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$loggedIn = $false
try {
    $login = Invoke-RestMethod -Method Post -Uri "$BaseUrl/backend/auth.php?action=login" -ContentType 'application/json' -Body (@{
        username = $username
        password = $password
    } | ConvertTo-Json -Compress) -WebSession $session
    Assert-BetaCondition ($login.success -eq $true) 'Configured administrator login failed.'
    $loggedIn = $true

    $sessionState = Invoke-RestMethod -Uri "$BaseUrl/backend/auth.php?action=session" -WebSession $session
    Assert-BetaCondition ($sessionState.authenticated -eq $true) 'Authenticated session was not retained.'
    Assert-BetaCondition (@('admin', 'super_admin') -contains $sessionState.user.role) 'Configured beta account is not an administrator.'

    $applicantStats = Invoke-RestMethod -Uri "$BaseUrl/backend/applicant_info.php?action=stats" -WebSession $session
    Assert-BetaCondition ($null -ne $applicantStats.total) 'Applicant statistics payload is incomplete.'
    Assert-BetaCondition ($applicantStats.biometric_evaluation.status -eq 'ready') 'Biometric analytics is not ready.'

    $criminalStats = Invoke-RestMethod -Uri "$BaseUrl/backend/criminal_record.php?action=stats" -WebSession $session
    Assert-BetaCondition ($null -ne $criminalStats.total_criminals) 'Criminal statistics payload is incomplete.'

    $systemStatus = Invoke-RestMethod -Uri "$BaseUrl/backend/criminal_record.php?action=status" -WebSession $session
    Assert-BetaCondition ($systemStatus.database_status.connected -eq $true) 'MariaDB is not connected.'
    Assert-BetaCondition ($systemStatus.bozorth3_status.service_status.connected -eq $true) 'PHP cannot reach the fingerprint service.'
    Assert-BetaCondition ($systemStatus.bozorth3_status.scanner_status.available -eq $true) 'PHP reports the scanner unavailable.'
    foreach ($matcher in @('mindtct', 'sourceafis', 'openafis', 'mcc', 'jiang')) {
        Assert-BetaCondition ($systemStatus.bozorth3_status.matcher_status.$matcher -eq $true) "$matcher is not ready."
    }

    $null = Invoke-RestMethod -Uri "$BaseUrl/backend/applicant_info.php?action=history&limit=5" -WebSession $session
    $null = Invoke-RestMethod -Uri "$BaseUrl/backend/criminal_info.php?action=list" -WebSession $session
    $null = Invoke-RestMethod -Uri "$BaseUrl/backend/applicant_info.php?action=notifications&state=active&limit=5" -WebSession $session
    $null = Invoke-RestMethod -Uri "$BaseUrl/backend/applicant_info.php?action=comparisons&limit=5" -WebSession $session
    $dataset = Invoke-RestMethod -Uri "$BaseUrl/backend/dataset_collection.php?action=list&limit=5" -WebSession $session
    Assert-BetaCondition ($null -ne $dataset) 'Research dataset endpoint returned no payload.'

    [pscustomobject]@{
        passed = $true
        authenticatedRole = $sessionState.user.role
        applicantRecords = [int]$applicantStats.total
        criminalRecords = [int]$criminalStats.total_criminals
        biometricAnalytics = $applicantStats.biometric_evaluation.status
        databaseConnected = [bool]$systemStatus.database_status.connected
        fingerprintServiceConnected = [bool]$systemStatus.bozorth3_status.service_status.connected
        scannerAvailable = [bool]$fingerprintHealth.scanner_available
        scannerProvider = $fingerprintHealth.scanner_provider
        simulationAllowed = [bool]$fingerprintHealth.simulation_allowed
        matcherCount = 5
        protectedEndpointsChecked = 8
    } | ConvertTo-Json -Depth 4
} finally {
    if ($loggedIn) {
        try {
            $null = Invoke-RestMethod -Method Post -Uri "$BaseUrl/backend/auth.php?action=logout" -WebSession $session
        } catch {
            Write-Warning 'The smoke-test session could not be logged out cleanly.'
        }
    }
}
