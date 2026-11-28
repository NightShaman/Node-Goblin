# Build on windows-2025 from the checkout whose VERSION has already been set.
[CmdletBinding()]
param([string]$OutputDirectory = (Join-Path $PSScriptRoot '..\..\..\dist'))

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Find-InnoCompiler {
    $locations = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe')
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    )
    foreach ($key in @('HKLM:\SOFTWARE\WOW6432Node', 'HKLM:\SOFTWARE', 'HKCU:\SOFTWARE')) {
        $entry = Get-ItemProperty -LiteralPath "$key\Microsoft\Windows\CurrentVersion\Uninstall\Inno Setup 6_is1" -ErrorAction SilentlyContinue
        if ($entry -and $entry.PSObject.Properties['InstallLocation'] -and $entry.InstallLocation) {
            $locations += Join-Path $entry.InstallLocation 'ISCC.exe'
        }
    }
    foreach ($location in $locations) {
        if (Test-Path -LiteralPath $location -PathType Leaf) { return $location }
    }
    throw 'Inno Setup 6.7 or later in the 6.x series is required on the build machine. Install Inno Setup 6 in its standard location, or use the windows-2025 runner image.'
}

function Copy-PayloadFile([string]$Source, [string]$Destination) {
    $item = Get-Item -LiteralPath $Source
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Expected a regular payload file at $Source"
    }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Destination))
    [IO.File]::Copy($item.FullName, $Destination)
}

function Copy-Libraries([string]$Source, [string]$Destination) {
    $directory = Get-Item -LiteralPath $Source
    if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Expected a regular library directory at $Source"
    }
    foreach ($item in Get-ChildItem -LiteralPath $directory.FullName -Force) {
        $target = Join-Path $Destination $item.Name
        if ($item.PSIsContainer) { Copy-Libraries $item.FullName $target }
        else { Copy-PayloadFile $item.FullName $target }
    }
}

function Get-Hash([string]$File) {
    (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
}

if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess) {
    throw 'Run the installer build using 64-bit PowerShell on Windows x64.'
}

$windows = Split-Path -Parent $PSScriptRoot
$gateway = (Resolve-Path -LiteralPath (Join-Path $windows '..\..')).Path
$repo = Split-Path -Parent $gateway
$manager = Join-Path $windows 'app'
$hostModule = Join-Path $windows 'manager-host.mjs'
$sources = @()
$manifest = $null
if (Test-Path -LiteralPath $manager -PathType Container) {
    $sources = @(Get-ChildItem -LiteralPath $manager -File -Filter '*.cs' | Sort-Object Name)
    foreach ($name in 'app.manifest', 'NodeGoblin.manifest') {
        $candidate = Join-Path $manager $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $manifest = $candidate; break }
    }
}
if (-not $sources.Count -or -not $manifest -or -not (Test-Path -LiteralPath $hostModule -PathType Leaf)) {
    throw 'The Windows manager sources, asInvoker manifest, and manager-host.mjs are required. Build from a checkout containing the Windows manager change.'
}
[xml]$manifestXml = Get-Content -LiteralPath $manifest -Raw
$executionLevel = $manifestXml.SelectSingleNode("//*[local-name()='requestedExecutionLevel']")
if (-not $executionLevel -or $executionLevel.GetAttribute('level') -cne 'asInvoker' -or $executionLevel.GetAttribute('uiAccess') -cne 'false') {
    throw 'The Windows manager manifest must specify asInvoker and uiAccess=false.'
}

$version = (Get-Content -LiteralPath (Join-Path $gateway 'VERSION') -Raw).Trim()
if ($version -cnotmatch '\A([0-9]{4}\.[0-9]{2}\.[0-9]{2})(?:\.([0-9]+))?\z') {
    throw 'gateway/VERSION must use YYYY.MM.DD[.N].'
}
$calendarDate = $Matches[1]
$revision = 0
if ($Matches.ContainsKey(2) -and (-not [int]::TryParse($Matches[2], [ref]$revision) -or $revision -gt 65535)) {
    throw 'The VERSION revision must fit a Windows version resource component (0..65535).'
}
$date = [DateTime]::MinValue
if (-not [DateTime]::TryParseExact($calendarDate, 'yyyy.MM.dd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$date)) {
    throw 'gateway/VERSION contains an invalid UTC calendar date.'
}
$numericVersion = "$($date.Year).$($date.Month).$($date.Day).$revision"
$package = Get-Content -LiteralPath (Join-Path $gateway 'package.json') -Raw | ConvertFrom-Json
if ($package.version -cne $version -or $package.type -cne 'module') {
    throw 'gateway/package.json must have the assigned gateway/VERSION and type=module.'
}
# The release job may stamp VERSION and package.json after checking out this commit.
$sourceRevision = & git -C $repo rev-parse --verify HEAD
if ($LASTEXITCODE -ne 0 -or $sourceRevision -cnotmatch '\A[0-9a-f]{40}\z') {
    throw 'A Git checkout with a known HEAD is required to record source provenance.'
}

$csc = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw "Framework64 csc.exe was not found at $csc" }
$iscc = Find-InnoCompiler
$pin = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'node-win-x64.sha256') -Raw).Trim()
if ($pin -cnotmatch '\A([0-9a-f]{64})  (node-(v24\.[0-9]+\.[0-9]+)-win-x64\.zip)\z') {
    throw 'Invalid vendored Node.js archive pin.'
}
$nodeHash = $Matches[1]
$nodeArchiveName = $Matches[2]
$nodeVersion = $Matches[3]
$nodeUrl = "https://nodejs.org/dist/$nodeVersion/$nodeArchiveName"

$output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
$stage = Join-Path ([IO.Path]::GetTempPath()) ('node-goblin-setup-' + [Guid]::NewGuid().ToString('N'))
try {
    $payload = Join-Path $stage 'app'
    $nodeDirectory = Join-Path $payload 'node'
    [void][IO.Directory]::CreateDirectory($nodeDirectory)
    $archive = Join-Path $stage $nodeArchiveName
    Invoke-WebRequest -Uri $nodeUrl -MaximumRedirection 0 -UseBasicParsing -OutFile $archive
    if ((Get-Hash $archive) -cne $nodeHash) { throw "SHA-256 mismatch for $nodeArchiveName" }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        foreach ($name in 'node.exe', 'LICENSE') {
            $entry = $zip.GetEntry("node-$nodeVersion-win-x64/$name")
            if (-not $entry -or $entry.Length -eq 0) { throw "Missing $name in the verified Node.js archive." }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $nodeDirectory $name))
        }
    } finally { $zip.Dispose() }

    $gatewayPayload = Join-Path $payload 'gateway'
    foreach ($relative in 'VERSION', 'package.json', 'cli.mjs', 'index.mjs', 'node-goblin.mjs',
            'deploy\windows\desktop-helper.ps1', 'deploy\windows\manager-host.mjs') {
        Copy-PayloadFile (Join-Path $gateway $relative) (Join-Path $gatewayPayload $relative)
    }
    Copy-Libraries (Join-Path $gateway 'lib') (Join-Path $gatewayPayload 'lib')
    Copy-PayloadFile (Join-Path $repo 'LICENSE') (Join-Path $payload 'LICENSE.txt')
    Copy-PayloadFile (Join-Path $PSScriptRoot 'THIRD-PARTY-NOTICES.txt') (Join-Path $payload 'THIRD-PARTY-NOTICES.txt')

    $versionSource = Join-Path $stage 'ReleaseVersion.cs'
    @(
        " [assembly: System.Reflection.AssemblyFileVersion(`"$numericVersion`")]"
        " [assembly: System.Reflection.AssemblyInformationalVersion(`"$version`")]"
    ) | Set-Content -LiteralPath $versionSource -Encoding ASCII
    $managerExe = Join-Path $payload 'NodeGoblin.exe'
    $sourcePaths = @($sources | ForEach-Object FullName)
    & $csc /nologo /target:winexe /platform:x64 /optimize+ /define:NODE_GOBLIN_RELEASE "/win32manifest:$manifest" "/out:$managerExe" "/reference:System.Windows.Forms.dll,System.Drawing.dll,System.Web.Extensions.dll,System.Core.dll" $versionSource @sourcePaths | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Framework64 csc.exe could not compile the Windows manager.' }

    $guard = Join-Path $stage 'setup-guard.exe'
    & $csc /nologo /target:exe /platform:x64 /optimize+ "/out:$guard" (Join-Path $PSScriptRoot 'SetupGuard.cs') | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Framework64 csc.exe could not compile the installer safety checks.' }
    $guardHash = Get-Hash $guard
    Copy-PayloadFile $guard (Join-Path $payload "setup-guard-$guardHash.exe")

    $files = [ordered]@{}
    foreach ($file in Get-ChildItem -LiteralPath $payload -Recurse -File | Sort-Object FullName) {
        $relative = $file.FullName.Substring($payload.Length + 1).Replace('\', '/')
        $files[$relative] = Get-Hash $file.FullName
    }
    [ordered]@{
        version = $version
        windowsVersion = $numericVersion
        sourceRevision = $sourceRevision
        node = [ordered]@{ version = $nodeVersion; url = $nodeUrl; archiveSha256 = $nodeHash }
        files = $files
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $payload 'package-build.json') -Encoding UTF8

    $baseName = "node-goblin-$version-windows-x64-setup"
    & $iscc "/DReleaseVersion=$version" "/DNumericVersion=$numericVersion" "/DStageRoot=$stage" "/DGuardHash=$guardHash" "/O$stage" "/F$baseName" (Join-Path $PSScriptRoot 'NodeGoblin.iss') | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup failed to compile Setup.exe.' }
    $setup = Join-Path $stage "$baseName.exe"
    $sha = Get-Hash $setup
    $checksum = "$setup.sha256"
    "$sha  $baseName.exe" | Set-Content -LiteralPath $checksum -Encoding ASCII
    [void][IO.Directory]::CreateDirectory($output)
    Move-Item -LiteralPath $setup -Destination $output -Force
    Move-Item -LiteralPath $checksum -Destination $output -Force
    Write-Output (Join-Path $output "$baseName.exe")
    Write-Output (Join-Path $output "$baseName.exe.sha256")
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
