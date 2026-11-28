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
  & (Join-Path $root 'gateway\deploy\windows\installer\test-installed.ps1') `
    -Setup (Join-Path $root 'gateway\dist\fixture\node-goblin-2026.11.27-windows-x64-setup.exe') `
    -UpgradeSetup (Join-Path $root "gateway\dist\node-goblin-$Version-windows-x64-setup.exe") `
    -ExpectedSourceRevision $SourceRevision `
    -GatewayExercise (Join-Path $root 'gateway\test\windows-installer-e2e.test.mjs') *> $log
  Add-Content -LiteralPath $log 'NG_WINDOWS_INSTALLER_LIFECYCLE_VERIFIED: standard-user bundled install, GUI pairing, upgrade, removal and retained data'
  exit 0
} catch {
  ($_ | Out-String) | Add-Content -LiteralPath $log
  foreach ($item in Get-ChildItem -LiteralPath $root -Directory -Filter 'node-goblin-setup-test-*') {
    foreach ($setupLog in Get-ChildItem -LiteralPath $item.FullName -File -Filter '*.log') {
      Add-Content -LiteralPath $log "Installer diagnostics: $($setupLog.Name)"
      Get-Content -LiteralPath $setupLog.FullName -Tail 55 | Add-Content -LiteralPath $log
    }
  }
  exit 1
}
