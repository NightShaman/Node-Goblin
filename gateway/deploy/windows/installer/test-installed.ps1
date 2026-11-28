# Run in a disposable, interactive, standard Windows user profile.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Setup,
    [Parameter(Mandatory)][string]$UpgradeSetup,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedSourceRevision,
    [ValidateNotNullOrEmpty()][string]$GatewayExercise
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Require([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Hash([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Verify-Artifact([string]$Path) {
    $name = [IO.Path]::GetFileName($Path)
    $expected = "$(Hash $Path)  $name"
    Require ((Get-Content -LiteralPath "$Path.sha256" -Raw).Trim() -ceq $expected) "Invalid checksum for $name"
}

function Run-Installer([string]$Path, [string]$Name, [string]$Extra = '', [switch]$Reject) {
    $log = Join-Path $logs "$Name.log"
    $process = Start-Process -FilePath $Path -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG=`"$log`" $Extra" -PassThru
    Require ($process.WaitForExit(120000)) "Installer timed out. Log at $log"
    if ($Reject) { Require ($process.ExitCode -ne 0) "Installer unexpectedly succeeded. Log at $log" }
    else { Require ($process.ExitCode -eq 0) "Installer returned $($process.ExitCode). Log at $log" }
}

function Verify-InstalledPayload([string]$Artifact) {
    $metadata = Get-Content -LiteralPath (Join-Path $app 'package-build.json') -Raw | ConvertFrom-Json
    $version = $metadata.version
    Require ([IO.Path]::GetFileName($Artifact) -ceq "node-goblin-$version-windows-x64-setup.exe") 'Installed and advertised versions differ.'
    $setupInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($Artifact)
    $numeric = "$($setupInfo.FileMajorPart).$($setupInfo.FileMinorPart).$($setupInfo.FileBuildPart).$($setupInfo.FilePrivatePart)"
    Require ($numeric -ceq $metadata.windowsVersion -and $setupInfo.ProductVersion.Trim() -ceq $version) 'Setup PE version disagrees with installed metadata.'
    $managerInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($managerExe)
    Require ($managerInfo.ProductVersion.Trim() -ceq $version) 'Manager PE version disagrees with the installer.'
    Require ((Get-Content -LiteralPath (Join-Path $app 'gateway\VERSION') -Raw).Trim() -ceq $version) 'Installed VERSION disagrees with the installer.'
    $package = Get-Content -LiteralPath (Join-Path $app 'gateway\package.json') -Raw | ConvertFrom-Json
    Require ($package.version -ceq $version) 'Installed package.json disagrees with the installer.'

    foreach ($file in $metadata.files.PSObject.Properties) {
        Require ($file.Name -cnotmatch '(?:^|/)\.\.(?:/|$)|[:\\]') "Invalid installed inventory path $($file.Name)"
        Require ((Hash (Join-Path $app $file.Name)) -ceq $file.Value) "Installed hash mismatch for $($file.Name)"
    }
    foreach ($file in 'NodeGoblin.exe', 'node/node.exe', 'node/LICENSE', 'LICENSE.txt', 'THIRD-PARTY-NOTICES.txt',
            'gateway/cli.mjs', 'gateway/index.mjs', 'gateway/node-goblin.mjs', 'gateway/deploy/windows/manager-host.mjs',
            'gateway/deploy/windows/desktop-helper.ps1') {
        Require ($null -ne $metadata.files.PSObject.Properties[$file]) "Missing installed inventory entry $file"
    }
    foreach ($file in Get-ChildItem -LiteralPath $app -Recurse -File) {
        $relative = $file.FullName.Substring($app.Length + 1).Replace('\', '/')
        if ($relative -match '\A(?:unins\d{3}\.(?:dat|exe|msg)|setup-guard-[a-f0-9]{64}\.exe|package-build\.json)\z') { continue }
        Require ($null -ne $metadata.files.PSObject.Properties[$relative]) "Unexpected installed file $relative"
    }
    $nodeVersion = & $nodeExe --version
    Require ($LASTEXITCODE -eq 0 -and $nodeVersion -ceq $metadata.node.version -and $nodeVersion -match '^v24\.') 'Installed Node version disagrees with metadata.'
    $nodeArch = & $nodeExe -p process.arch
    Require ($LASTEXITCODE -eq 0 -and $nodeArch -ceq 'x64') 'Bundled Node must run as x64.'
    $nodeLicense = Get-Content -LiteralPath (Join-Path $app 'node\LICENSE') -Raw
    Require ($nodeLicense -match 'Node\.js is licensed for use') 'The bundled Node license is missing.'
    return $metadata
}

function Open-Manager {
    $process = Start-Process -FilePath $managerExe -WorkingDirectory $app -PassThru
    $until = [DateTime]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 100
        $process.Refresh()
    } until ($process.HasExited -or $process.MainWindowHandle -ne 0 -or [DateTime]::UtcNow -ge $until)
    Require (-not $process.HasExited -and $process.MainWindowHandle -ne 0) 'The installed graphical manager did not open.'
    return $process
}

function Assert-RetainedData {
    foreach ($file in $savedData.Keys) {
        Require ((Hash $file) -ceq $savedData[$file].Hash -and (Get-Acl -LiteralPath $file).Sddl -ceq $savedData[$file].Acl) "Installer changed $file"
    }
    foreach ($path in $savedDirectories.Keys) {
        Require ((Get-Acl -LiteralPath $path).Sddl -ceq $savedDirectories[$path]) "Installer changed the ACL of $path"
    }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
Require (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'Use a fresh standard Windows user.'
Require ((Get-Process -Id $PID).SessionId -ne 0) 'Use an interactive signed-in Windows session.'
$Setup = (Resolve-Path -LiteralPath $Setup).Path
$UpgradeSetup = (Resolve-Path -LiteralPath $UpgradeSetup).Path
if ($GatewayExercise) { $GatewayExercise = (Resolve-Path -LiteralPath $GatewayExercise).Path }
Require ($Setup -ne $UpgradeSetup) 'Provide two distinct installer versions.'
Verify-Artifact $Setup
Verify-Artifact $UpgradeSetup

$root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'NodeGoblin'
$app = Join-Path $root 'app'
$managerExe = Join-Path $app 'NodeGoblin.exe'
$nodeExe = Join-Path $app 'node\node.exe'
$arpSuffix = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{39333212-C9F8-43BC-A95F-6DDE9D02A4FB}_is1'
$arp = "HKCU:\$arpSuffix"
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Node Goblin.lnk'
$desktop = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Node Goblin.lnk'
Require (-not (Test-Path -LiteralPath $root) -and -not (Test-Path -LiteralPath $arp)) 'Use a fresh profile without a Node Goblin installation.'
$logs = Join-Path ([IO.Path]::GetTempPath()) ('node-goblin-setup-test-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($logs)
Write-Host "Installer logs at $logs"

$wrongPath = Join-Path $logs 'wrong directory'
Run-Installer $Setup 'reject-redirect' "/DIR=`"$wrongPath`"" -Reject
Require (-not (Test-Path -LiteralPath $wrongPath) -and -not (Test-Path -LiteralPath $root)) 'Setup wrote to an unexpected location.'
Run-Installer $Setup 'install' '/TASKS=""'
$firstBuild = Verify-InstalledPayload $Setup
$settingsExercise = Join-Path $PSScriptRoot '..\..\..\test\windows-manager-settings.ps1'
if ($GatewayExercise) {
    # Reflection holds an image lock until process exit; isolate this check from upgrade.
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $settingsExercise -ManagerExe $managerExe
    Require ($LASTEXITCODE -eq 0) 'Installed manager settings validation failed.'
}
Require (Test-Path -LiteralPath $startMenu -PathType Leaf) 'Per-user Start Menu shortcut is missing.'
Require (-not (Test-Path -LiteralPath $desktop)) 'Setup created an unselected desktop shortcut.'
Require ((Get-Acl -LiteralPath $root).AreAccessRulesProtected) 'Setup did not protect the application/data parent.'
$registration = Get-ItemProperty -LiteralPath $arp
Require ($registration.DisplayVersion -ceq $firstBuild.version -and $registration.InstallLocation.TrimEnd('\') -eq $app) 'Per-user Add/Remove Programs entry is incorrect.'
Require (-not (Test-Path -LiteralPath "HKLM:\$arpSuffix")) 'Setup registered an all-users installation.'
Require ($null -eq (Get-ItemProperty -LiteralPath $run -Name NodeGoblin -ErrorAction SilentlyContinue)) 'Setup opted the user into sign-in launch.'

$managerProcess = Open-Manager
$config = Join-Path $root 'config'
$state = Join-Path $root 'state'
$startupCommand = "`"$managerExe`" --background"
$configFile = Join-Path $config 'gateway.env'
if (-not (Test-Path -LiteralPath $configFile)) {
    Set-Content -LiteralPath $configFile -Value '# installer retention fixture' -Encoding ASCII
}
[void][Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Microsoft\Windows\CurrentVersion\Run').Dispose()
Set-ItemProperty -LiteralPath $run -Name NodeGoblin -Value $startupCommand
Set-Content -LiteralPath (Join-Path $state 'installer-retention.txt') -Value 'installer retention fixture' -Encoding ASCII
$savedData = @{}
foreach ($file in Get-ChildItem -LiteralPath $config, $state -File -Force) {
    $savedData[$file.FullName] = @{ Hash = (Hash $file.FullName); Acl = (Get-Acl -LiteralPath $file.FullName).Sddl }
}
$savedDirectories = @{}
foreach ($path in $root, $config, $state) { $savedDirectories[$path] = (Get-Acl -LiteralPath $path).Sddl }

# A separately launched bundled Node has no manager shutdown endpoint. Setup must leave it and the old app intact.
$blocker = Start-Process -FilePath $nodeExe -ArgumentList '-e "setInterval(()=>{},1000)"' -WindowStyle Hidden -PassThru
try {
    Run-Installer $UpgradeSetup 'reject-live-node' '/TASKS=desktopicon' -Reject
    Require (-not $blocker.HasExited) 'Setup stopped a process it did not own.'
    Require ((Verify-InstalledPayload $Setup).version -ceq $firstBuild.version) 'Setup replaced files while Node was active.'
    Require ($managerProcess.WaitForExit(5000)) 'Setup did not request manager shutdown.'
} finally {
    if (-not $blocker.HasExited) { $blocker.Kill(); [void]$blocker.WaitForExit(5000) }
}
$managerProcess = Open-Manager
Run-Installer $UpgradeSetup 'upgrade' '/TASKS=desktopicon'
Require ($managerProcess.WaitForExit(5000)) 'Upgrade did not request manager shutdown.'
$upgraded = Verify-InstalledPayload $UpgradeSetup
Require ($upgraded.version -ne $firstBuild.version -and $upgraded.sourceRevision -ceq $ExpectedSourceRevision) 'Upgrade metadata does not identify the requested release and source.'
$pin = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'node-win-x64.sha256') -Raw).Trim()
Require ($pin -ceq "$($upgraded.node.archiveSha256)  node-$($upgraded.node.version)-win-x64.zip") 'Installed Node metadata disagrees with the archive pin.'
Require ($upgraded.node.url -ceq "https://nodejs.org/dist/$($upgraded.node.version)/node-$($upgraded.node.version)-win-x64.zip") 'Installed Node metadata has an unexpected source.'
Require (Test-Path -LiteralPath $desktop -PathType Leaf) 'Selected desktop shortcut is missing.'
Require ((Get-ItemPropertyValue -LiteralPath $run -Name NodeGoblin) -ceq $startupCommand) 'Upgrade changed the user sign-in choice.'
Assert-RetainedData

# Exercise first-run pairing on the ACTUAL release installer after its upgrade,
# not just on the previous-version test fixture. Retain its real paired data
# across uninstall after verifying upgrade retention independently above.
$managerProcess = Open-Manager
if ($GatewayExercise) {
    $previousMode = $env:NODE_GOBLIN_MANAGER_E2E
    $previousPid = $env:NODE_GOBLIN_MANAGER_PID
    try {
        $env:NODE_GOBLIN_MANAGER_E2E = '1'
        $env:NODE_GOBLIN_MANAGER_PID = [string]$managerProcess.Id
        & $nodeExe --test $GatewayExercise
        Require ($LASTEXITCODE -eq 0) "Installed gateway exercise failed (exit $LASTEXITCODE)."
    } finally {
        $env:NODE_GOBLIN_MANAGER_E2E = $previousMode
        $env:NODE_GOBLIN_MANAGER_PID = $previousPid
    }
    Require ($managerProcess.HasExited) 'The gateway exercise did not shut down its manager.'
    Require ((Get-ItemPropertyValue -LiteralPath $run -Name NodeGoblin) -ceq $startupCommand) 'The gateway exercise did not leave the opted-in sign-in command.'
    foreach ($name in 'config\gateway.env', 'config\manager-consent', 'state\node-identity.json', 'state\operations.json') {
        Require (Test-Path -LiteralPath (Join-Path $root $name) -PathType Leaf) "Gateway exercise did not create $name."
    }
    $managerProcess = Open-Manager
}
$savedData = @{}
foreach ($file in Get-ChildItem -LiteralPath $config, $state -File -Force) {
    $savedData[$file.FullName] = @{ Hash = (Hash $file.FullName); Acl = (Get-Acl -LiteralPath $file.FullName).Sddl }
}
# Also replace the app while it has REAL paired identity/trust/journal data,
# rather than relying only on the earlier sentinel/config upgrade fixture.
if ($GatewayExercise) {
    Run-Installer $UpgradeSetup 'refresh-paired' '/TASKS=desktopicon'
    Require ($managerProcess.WaitForExit(5000)) 'Paired refresh did not request manager shutdown.'
    Require ((Verify-InstalledPayload $UpgradeSetup).sourceRevision -ceq $ExpectedSourceRevision) 'Paired refresh changed the intended payload.'
    Assert-RetainedData
    Require ((Get-ItemPropertyValue -LiteralPath $run -Name NodeGoblin) -ceq $startupCommand) 'Paired refresh changed the sign-in choice.'
    $managerProcess = Open-Manager
}
$uninstaller = (Get-ItemPropertyValue -LiteralPath $arp -Name UninstallString).Trim('"')
Require ([IO.Path]::GetDirectoryName($uninstaller) -eq $app) 'Registered uninstaller has an unexpected path.'
$junction = Join-Path $app 'unsafe-test-junction'
$outside = Join-Path $logs 'outside-app'
[void][IO.Directory]::CreateDirectory($outside)
$sentinel = Join-Path $outside 'preserve.txt'
Set-Content -LiteralPath $sentinel -Value 'preserve' -Encoding ASCII
[void](New-Item -Path $junction -ItemType Junction -Target $outside)
try {
    Run-Installer $uninstaller 'reject-junction' -Reject
    Require ((Get-Content -LiteralPath $sentinel) -ceq 'preserve') 'Uninstall followed an application junction.'
    Require (Test-Path -LiteralPath $arp) 'Rejected uninstall erased registration.'
    Require (-not $managerProcess.HasExited) 'Uninstall stopped the manager before validating its path.'
} finally {
    [IO.Directory]::Delete($junction)
}
Run-Installer $uninstaller 'uninstall'
Require ($managerProcess.WaitForExit(5000)) 'Uninstall did not request manager shutdown.'
# Inno's temporary clone may still be deleting the original uninstaller after exit.
$until = [DateTime]::UtcNow.AddSeconds(15)
while ((Test-Path -LiteralPath $app) -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 100 }
Require (-not (Test-Path -LiteralPath $app) -and -not (Test-Path -LiteralPath $arp)) 'Uninstall left the application or its registration.'
Require (-not (Test-Path -LiteralPath $startMenu) -and -not (Test-Path -LiteralPath $desktop)) 'Uninstall left a setup shortcut.'
Require ($null -eq (Get-ItemProperty -LiteralPath $run -Name NodeGoblin -ErrorAction SilentlyContinue)) 'Uninstall left the owned sign-in entry.'
Assert-RetainedData
Write-Host "Verified install $($firstBuild.version), upgrade $($upgraded.version), and uninstall as $($identity.Name)."
