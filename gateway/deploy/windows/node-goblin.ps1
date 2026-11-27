# Windows foreground operator for Node Goblin. Compatible with Windows PowerShell 5.1.
[CmdletBinding()]
param(
  [Parameter(Position=0)][ValidateSet('configure','run','pairing-code','confirm-pairing','help')][string]$Command = 'help',
  [Parameter(Position=1)][string]$Argument,
  [string]$Controller,
  [string]$GatewayId,
  [switch]$EnableDesktop
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop') { throw 'Run this script with Windows PowerShell (powershell.exe).' }
$script:Base = Join-Path $env:LOCALAPPDATA 'NodeGoblin'
$script:ConfigDir = Join-Path $script:Base 'config'
$script:StateDir = Join-Path $script:Base 'state'
$script:Config = Join-Path $script:ConfigDir 'gateway.env'
$script:EntryPoint = Join-Path $PSScriptRoot '..\..\cli.mjs'

function Assert-NotReparse([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse point: $Path" }
  }
}
function Get-RuleSid($Identity) {
  try { return $Identity.Translate([Security.Principal.SecurityIdentifier]).Value }
  catch { throw "Unresolvable ACL identity: $Identity" }
}
function Protect-Path([string]$Path, [bool]$Directory) {
  Assert-NotReparse $Path
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $admins = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
  $allowed = @($sid.Value,$system.Value,$admins.Value)
  $exists = Test-Path -LiteralPath $Path
  if ($exists) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($Directory -ne $item.PSIsContainer) { throw "Unexpected path type: $Path" }
    $acl = if ($Directory) { [IO.Directory]::GetAccessControl($Path) } else { [IO.File]::GetAccessControl($Path) }
    if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw "Unexpected ACL owner: $Path" }
    foreach ($entry in $acl.Access) {
      if ($entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
          (Get-RuleSid $entry.IdentityReference) -notin $allowed) { throw "Unexpected ACL entry on $Path" }
    }
  } elseif ($Directory) { $acl = [Security.AccessControl.DirectorySecurity]::new() }
  else { return }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleAll($rule) }
  $inherit = if ($Directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  foreach ($who in @($sid,$system,$admins)) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($who,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  if ($Directory) {
    if ($exists) { [IO.Directory]::SetAccessControl($Path,$acl) }
    else { [void][IO.Directory]::CreateDirectory($Path,$acl) }
    $check = [IO.Directory]::GetAccessControl($Path)
  } else {
    [IO.File]::SetAccessControl($Path,$acl)
    $check = [IO.File]::GetAccessControl($Path)
  }
  if (-not $check.AreAccessRulesProtected) { throw "ACL inheritance could not be disabled: $Path" }
  foreach ($entry in $check.Access) {
    if ($entry.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        (Get-RuleSid $entry.IdentityReference) -notin $allowed -or
        ($entry.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw "Unexpected ACL entry on $Path" }
  }
}
function Initialize-ProtectedPaths {
  Assert-NotReparse $env:LOCALAPPDATA
  foreach ($p in @($script:Base,$script:ConfigDir,$script:StateDir)) { Protect-Path $p $true }
  Protect-Path $script:Config $false
}
function Read-Config {
  $values = @{}
  if (Test-Path -LiteralPath $script:Config) {
    Assert-NotReparse $script:Config
    foreach ($line in [IO.File]::ReadAllLines($script:Config)) {
      if ($line -match '^([A-Z0-9_]+)=(.*)$') { $values[$matches[1]] = $matches[2] }
      elseif ($line -and -not $line.StartsWith('#')) { throw 'Invalid gateway.env line; refusing ambiguous configuration.' }
    }
  }
  return $values
}
function Write-Config($Values) {
  $lines = foreach ($key in @('BURROW_GATEWAY_CONTROLLER_URL','BURROW_GATEWAY_ID')) { "$key=$($Values[$key])" }
  $tmp = "$script:Config.$([Guid]::NewGuid().ToString('N')).tmp"
  [IO.File]::WriteAllLines($tmp,[string[]]$lines,(New-Object Text.UTF8Encoding($false)))
  Protect-Path $tmp $false
  if (Test-Path -LiteralPath $script:Config) { [IO.File]::Replace($tmp,$script:Config,$null) }
  else { [IO.File]::Move($tmp,$script:Config) }
  Protect-Path $script:Config $false
}
function Show-Help {
  Write-Output 'Usage: node-goblin.ps1 configure | run | pairing-code | confirm-pairing CODE'
  Write-Output 'run -EnableDesktop opts in to the visible desktop helper for this launch only.'
  Write-Output 'run starts the foreground gateway in this console; Ctrl+C stops it. No service or automatic startup is configured.'
}

if ($EnableDesktop -and $Command -ne 'run') { throw '-EnableDesktop applies only to run.' }
if ($Command -eq 'help') { Show-Help; return }
Initialize-ProtectedPaths
foreach ($entry in (Get-ChildItem -LiteralPath $script:StateDir -Force)) {
  if ($entry.PSIsContainer) { throw 'Unexpected directory in Windows gateway state.' }
  Protect-Path $entry.FullName $false
}
switch ($Command) {
  'configure' {
    if (-not $Controller) { $Controller = Read-Host 'Controller host:port (or tls://host:port)' }
    if ($controller -notmatch '^tls://') { $controller = "tls://$controller" }
    $uri = $null
    if (-not [Uri]::TryCreate($controller,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -ne 'tls' -or -not $uri.Host -or $uri.Port -lt 1 -or $uri.Port -gt 65535 -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath.Trim('/')) { throw 'Controller must be tls://host:port.' }
    $id = if ($GatewayId) { $GatewayId } else { Read-Host 'Gateway ID' }
    if ($id -ceq 'local' -or $id -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$') { throw 'Invalid gateway ID.' }
    $values = Read-Config
    $values['BURROW_GATEWAY_CONTROLLER_URL'] = $controller
    $values['BURROW_GATEWAY_ID'] = $id
    Write-Config $values
    Write-Output "Saved protected config at $script:Config. No gateway was started."
  }
  'run' {
    $values = Read-Config
    if (-not $values['BURROW_GATEWAY_CONTROLLER_URL'] -or -not $values['BURROW_GATEWAY_ID']) { throw 'Run configure first.' }
    if (-not (Test-Path -LiteralPath $script:EntryPoint -PathType Leaf)) { throw 'Node Goblin cli.mjs was not found next to this deployment.' }
    $names = @('BURROW_GATEWAY_CONTROLLER_URL','BURROW_GATEWAY_ID','BURROW_GATEWAY_STATE_DIR','BURROW_GATEWAY_ENROLLMENT_TOKEN','BURROW_GATEWAY_CA_FILE','BURROW_GATEWAY_CERT_FILE','BURROW_GATEWAY_KEY_FILE','BURROW_GATEWAY_WINDOWS_DESKTOP')
    $prior = @{}; foreach ($name in $names) { $prior[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
      foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$null,'Process') }
      $env:BURROW_GATEWAY_CONTROLLER_URL = $values['BURROW_GATEWAY_CONTROLLER_URL']
      $env:BURROW_GATEWAY_ID = $values['BURROW_GATEWAY_ID']
      $env:BURROW_GATEWAY_STATE_DIR = $script:StateDir
      if ($EnableDesktop) { $env:BURROW_GATEWAY_WINDOWS_DESKTOP = '1' }
      $nodeApplication = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
      & $nodeApplication.Path $script:EntryPoint
      if ($LASTEXITCODE -ne 0) { throw "Gateway exited with code $LASTEXITCODE" }
    }
    finally {
      foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$prior[$name],'Process') }
    }
  }
  'pairing-code' {
    $file = Join-Path $script:StateDir 'pairing-code.json'; Assert-NotReparse $file
    if (-not (Test-Path -LiteralPath $file)) { Write-Output 'No pairing code is currently pending.'; exit 1 }
    Protect-Path $file $false
    $value = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    if (-not $value.gatewayId -or $value.pairingCode -notmatch '^[A-F0-9]{4}(-[A-F0-9]{4}){2}$') { throw 'Invalid pairing-code file.' }
    Write-Output "Pairing pending for $($value.gatewayId)"
    Write-Output "Pairing code: $($value.pairingCode)"
  }
  'confirm-pairing' {
    if (-not $Argument -or $Argument -notmatch '^[A-F0-9]{4}(-[A-F0-9]{4}){2}$') { throw 'Supply the displayed code: confirm-pairing CODE' }
    $pairFile = Join-Path $script:StateDir 'pairing-code.json'; Assert-NotReparse $pairFile
    Protect-Path $pairFile $false
    $pair = Get-Content -LiteralPath $pairFile -Raw | ConvertFrom-Json
    if ($pair.pairingCode -cne $Argument) { throw 'Pairing code mismatch.' }
    $dest = Join-Path $script:StateDir 'pairing-confirmation.json'
    Assert-NotReparse $dest
    $tmp = "$dest.$([Guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($tmp,(ConvertTo-Json @{ pairingCode=$Argument } -Compress),(New-Object Text.UTF8Encoding($false)))
    Protect-Path $tmp $false
    if (Test-Path -LiteralPath $dest) { [IO.File]::Replace($tmp,$dest,$null) }
    else { [IO.File]::Move($tmp,$dest) }
    Write-Output 'Confirmation recorded for the pending pairing.'
  }
  default { Show-Help }
}
