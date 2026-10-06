param(
    [string]$MavenVersion = "3.9.11"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolsRoot = Join-Path $projectRoot "temp\matcher-build"
$mavenRoot = Join-Path $toolsRoot "apache-maven-$MavenVersion"
$mavenExecutable = Join-Path $mavenRoot "bin\mvn.cmd"
$sourceAfisRoot = Join-Path $projectRoot "matchers\sourceafis"
$openAfisRoot = Join-Path $projectRoot "matchers\openafis"
$openAfisSource = Join-Path $toolsRoot "openafis"
$mpiAfisSource = Join-Path $toolsRoot "mpi-afis"
$mpiAfisRoot = Join-Path $projectRoot "matchers\mpi-afis"
$mpiAfisCommit = "f93e537e7b7024905ddfc7a124e9546e9dece38e"
$cygwinBash = "C:\cygwin64\bin\bash.exe"

New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null

if (-not (Test-Path -LiteralPath $mavenExecutable)) {
    $archive = Join-Path $toolsRoot "apache-maven-$MavenVersion-runtime.zip"
    $url = "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/$MavenVersion/apache-maven-$MavenVersion-bin.zip"
    Write-Host "Downloading Apache Maven $MavenVersion..."
    & curl.exe --fail --location --output $archive $url
    if ($LASTEXITCODE -ne 0) {
        throw "Apache Maven download failed."
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $toolsRoot -Force
}

Write-Host "Building the SourceAFIS 3.18.1 Java bridge..."
& $mavenExecutable -q -f (Join-Path $sourceAfisRoot "pom.xml") package
if ($LASTEXITCODE -ne 0) {
    throw "SourceAFIS bridge build failed."
}

if (-not (Test-Path -LiteralPath $cygwinBash)) {
    throw "Cygwin bash was not found at $cygwinBash."
}
if (-not (Test-Path -LiteralPath (Join-Path $openAfisSource ".git"))) {
    Write-Host "Downloading official OpenAFIS source..."
    git clone --depth 1 https://github.com/neilharan/openafis.git $openAfisSource
    if ($LASTEXITCODE -ne 0) {
        throw "OpenAFIS source download failed."
    }
}

$output = Join-Path $openAfisRoot "openafis-match.exe"
$projectCygwin = (& "C:\cygwin64\bin\cygpath.exe" -u $projectRoot).Trim()
Write-Host "Building the OpenAFIS C++ bridge..."
$buildCommand = "cd '$projectCygwin' && g++ -std=gnu++17 -O2 -I temp/matcher-build/openafis/lib -I temp/matcher-build/openafis/3rdparty matchers/openafis/openafis_match.cpp temp/matcher-build/openafis/lib/*.cpp -o matchers/openafis/openafis-match.exe"
& $cygwinBash -lc $buildCommand
if ($LASTEXITCODE -ne 0) {
    throw "OpenAFIS bridge build failed."
}

if (-not (Test-Path -LiteralPath (Join-Path $mpiAfisSource ".git"))) {
    Write-Host "Downloading the Apache-2.0 mpi-afis MCC and Jiang source..."
    git clone https://github.com/dperaltac/mpi-afis.git $mpiAfisSource
    if ($LASTEXITCODE -ne 0) {
        throw "mpi-afis source download failed."
    }
    git -C $mpiAfisSource checkout --detach $mpiAfisCommit
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to check out the pinned mpi-afis revision $mpiAfisCommit."
    }
}

# The standalone matcher targets do not use MPI, but the upstream common header
# includes its Score type unconditionally. Guard only those declarations so the
# original MCC and Jiang implementations can build without an MPI installation.
$fingerprintHeader = Join-Path $mpiAfisSource "include\Fingerprint.h"
$headerText = [System.IO.File]::ReadAllText($fingerprintHeader)
if ($headerText -notmatch '#ifdef COMPILE_USING_MPI\s*#include "Score.h"') {
    $headerText = $headerText.Replace('#include "Score.h"', "#ifdef COMPILE_USING_MPI`n#include `"Score.h`"`n#endif")
    $headerText = $headerText.Replace("`t`tstatic bool better(const Score &score1, const Score &score2);", "#ifdef COMPILE_USING_MPI`n`t`tstatic bool better(const Score &score1, const Score &score2);")
    $headerText = $headerText.Replace("`t`tstatic bool betterOrEqual(const Score &score1, const Score &score2);", "`t`tstatic bool betterOrEqual(const Score &score1, const Score &score2);`n#endif")
    $headerText = $headerText.Replace('inline bool Fingerprint::better(const Score &score1, const Score &score2) {return better(score1.getScore(), score2.getScore());}', "#ifdef COMPILE_USING_MPI`ninline bool Fingerprint::better(const Score &score1, const Score &score2) {return better(score1.getScore(), score2.getScore());}")
    $headerText = $headerText.Replace('inline bool Fingerprint::betterOrEqual(const Score &score1, const Score &score2) {return betterOrEqual(score1.getScore(), score2.getScore());}', "inline bool Fingerprint::betterOrEqual(const Score &score1, const Score &score2) {return betterOrEqual(score1.getScore(), score2.getScore());}`n#endif")
    [System.IO.File]::WriteAllText($fingerprintHeader, $headerText, [System.Text.UTF8Encoding]::new($false))
}

# Add machine-readable diagnostics to the reference command-line wrappers.
# These observations do not participate in matching or alter native scores.
$mccHeader = Join-Path $mpiAfisSource "MCC\MCC.h"
$mccHeaderText = [System.IO.File]::ReadAllText($mccHeader)
if ($mccHeaderText -notmatch 'getCylinderCount') {
    $mccHeaderText = $mccHeaderText.Replace(
        'void printCylinders(std::ostream &output = std::cout, char sep='' '') const;',
        "void printCylinders(std::ostream &output = std::cout, char sep=' ') const;`n`t`tunsigned int getCylinderCount() const { return cylinders.size(); }")
    [System.IO.File]::WriteAllText($mccHeader, $mccHeaderText, [System.Text.UTF8Encoding]::new($false))
}

$mccMain = Join-Path $mpiAfisSource "MCC\main.cpp"
$mccText = [System.IO.File]::ReadAllText($mccMain)
if ($mccText -notmatch 'MCC_DIAGNOSTIC') {
    $mccText = $mccText.Replace(
        "`tcout << `"First fingerprint: `" << endl;`n`ta1.printCylinders(cout);",
        "`tcout << `"MCC_DIAGNOSTIC probeCylinders=`" << a1.getCylinderCount()`n`t`t << `" referenceCylinders=`" << a2.getCylinderCount() << endl;")
    [System.IO.File]::WriteAllText($mccMain, $mccText, [System.Text.UTF8Encoding]::new($false))
}

$jiangMain = Join-Path $mpiAfisSource "MatcherJiang\main.cpp"
$jiangText = [System.IO.File]::ReadAllText($jiangMain)
if ($jiangText -notmatch 'JIANG_DIAGNOSTIC') {
    $jiangText = $jiangText.Replace(
        "    cout << a1.match(a2) << endl;",
        "    cout << `"JIANG_DIAGNOSTIC probeLocalStructures=`" << a1.size()`n         << `" referenceLocalStructures=`" << a2.size()`n         << `" alignment=completed`" << endl;`n    cout << a1.match(a2) << endl;")
    [System.IO.File]::WriteAllText($jiangMain, $jiangText, [System.Text.UTF8Encoding]::new($false))
}

New-Item -ItemType Directory -Force -Path $mpiAfisRoot | Out-Null
$mpiAfisCygwin = (& "C:\cygwin64\bin\cygpath.exe" -u $mpiAfisSource).Trim()
Write-Host "Building the mpi-afis MCC and Jiang standalone matchers..."
& $cygwinBash -lc "cd '$mpiAfisCygwin/MCC' && make clean && make"
if ($LASTEXITCODE -ne 0) {
    throw "mpi-afis MCC build failed."
}
& $cygwinBash -lc "cd '$mpiAfisCygwin/MatcherJiang' && make clean && make"
if ($LASTEXITCODE -ne 0) {
    throw "mpi-afis Jiang build failed."
}
Copy-Item -LiteralPath (Join-Path $mpiAfisSource "MCC\mcc.exe") -Destination (Join-Path $mpiAfisRoot "mcc-match.exe") -Force
Copy-Item -LiteralPath (Join-Path $mpiAfisSource "MatcherJiang\jiangMatching.exe") -Destination (Join-Path $mpiAfisRoot "jiang-match.exe") -Force
Copy-Item -LiteralPath (Join-Path $mpiAfisSource "LICENSE") -Destination (Join-Path $mpiAfisRoot "LICENSE") -Force

Write-Host "Academic matcher adapters are ready."
Write-Host "SourceAFIS classes: $(Join-Path $sourceAfisRoot 'target\classes')"
Write-Host "OpenAFIS executable: $output"
Write-Host "MCC executable: $(Join-Path $mpiAfisRoot 'mcc-match.exe')"
Write-Host "Jiang executable: $(Join-Path $mpiAfisRoot 'jiang-match.exe')"
