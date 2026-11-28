# Disposable Windows CI entry point, run as a standard user in the active session.
param(
  [Parameter(Mandatory=$true)][string]$Version,
  [Parameter(Mandatory=$true)][ValidatePattern('^[0-9a-f]{40}$')][string]$SourceRevision
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $root
[Environment]::CurrentDirectory = $root
$env:TEMP = $root; $env:TMP = $root
$env:Path = "$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0;${env:ProgramFiles}\Git\usr\bin"
# The parent runner uses PowerShell 7; its module path is not Windows PowerShell's.
$env:PSModulePath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules;${env:ProgramFiles}\WindowsPowerShell\Modules"
$log = Join-Path $root 'installer-e2e.log'
try {
  # The launcher must supply the token's genuine profile environment from birth.
  # Patching variables after shell startup can leave cached known folders pointing
  # at runneradmin and would conceal an invalid standard-user acceptance fixture.
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $profileKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $identity.User.Value
  $profile = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath $profileKey -Name ProfileImagePath).ProfileImagePath)
  if (-not [IO.Directory]::Exists($profile)) { throw 'The standard-user profile was not loaded' }
  Add-Content -Encoding UTF8 -LiteralPath $log "Standard-user token: $($identity.Name); profile: $profile; launch profile: $env:USERPROFILE"
  if (-not $env:USERPROFILE -or -not $env:USERPROFILE.Equals($profile, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The launch environment does not belong to the standard-user token'
  }
  # A fresh logon does not run Explorer's first-sign-in folder initialization.
  foreach ($folder in 'LocalApplicationData', 'ApplicationData', 'Programs', 'DesktopDirectory') {
    $path = [Environment]::GetFolderPath($folder, [Environment+SpecialFolderOption]::DoNotVerify)
    Add-Content -Encoding UTF8 -LiteralPath $log "Known folder ${folder}: $path"
    if (-not $path -or -not $path.StartsWith($profile + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw "Windows resolved $folder outside the standard-user profile: $path"
    }
    if ($folder -eq 'LocalApplicationData' -and -not $path.Equals($env:LOCALAPPDATA, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Windows and the launch environment disagree on LOCALAPPDATA'
    }
    if ($folder -eq 'ApplicationData' -and -not $path.Equals($env:APPDATA, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Windows and the launch environment disagree on APPDATA'
    }
    [void][IO.Directory]::CreateDirectory($path)
  }
  & (Join-Path $root 'gateway\deploy\windows\installer\test-installed.ps1') `
    -Setup (Join-Path $root 'gateway\dist\fixture\node-goblin-2026.11.27-windows-x64-setup.exe') `
    -UpgradeSetup (Join-Path $root "gateway\dist\node-goblin-$Version-windows-x64-setup.exe") `
    -ExpectedSourceRevision $SourceRevision `
    -GatewayExercise (Join-Path $root 'gateway\test\windows-installer-e2e.test.mjs') *>&1 | Out-File -LiteralPath $log -Append -Encoding UTF8
  Add-Content -Encoding UTF8 -LiteralPath $log 'NG_WINDOWS_INSTALLER_LIFECYCLE_VERIFIED: standard-user bundled install, GUI pairing, upgrade, removal and retained data'
  exit 0
} catch {
  ($_ | Out-String) | Add-Content -Encoding UTF8 -LiteralPath $log
  Add-Content -Encoding UTF8 -LiteralPath $log $_.ScriptStackTrace
  Add-Content -Encoding UTF8 -LiteralPath $log $_.InvocationInfo.PositionMessage
  foreach ($item in Get-ChildItem -LiteralPath $root -Directory -Filter 'node-goblin-setup-test-*') {
    foreach ($setupLog in Get-ChildItem -LiteralPath $item.FullName -File -Filter '*.log') {
      Add-Content -Encoding UTF8 -LiteralPath $log "Installer diagnostics: $($setupLog.Name)"
      Get-Content -LiteralPath $setupLog.FullName -Tail 55 | Add-Content -Encoding UTF8 -LiteralPath $log
    }
  }
  exit 1
}
