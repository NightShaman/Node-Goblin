# Shared Windows PowerShell 5.1 packaging contract. No launcher side effects.
$ErrorActionPreference = 'Stop'
function Assert-PackageHost {
  if ($PSVersionTable.PSEdition -ne 'Desktop' -or [Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Use Windows PowerShell 5.1 on Windows.' }
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run as the non-elevated Windows user, not Administrator.' }
}
function Assert-PlainPath([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  for ($p = $full; $p; $p = [IO.Path]::GetDirectoryName($p)) {
    try { $item = Get-Item -LiteralPath $p -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { continue }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse point: $p" }
  }
}
function Get-PackageAcl([string]$Path, [bool]$Directory) {
  Assert-PlainPath $Path
  $acl = if ($Directory) { [IO.Directory]::GetAccessControl($Path) } else { [IO.File]::GetAccessControl($Path) }
  $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw "Unexpected ACL owner: $Path" }
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw "Unexpected ACL entry on $Path" }
  }
  return $acl
}
function New-ProtectedPackageDirectory([string]$Path) {
  Assert-PlainPath $Path
  if (Test-Path -LiteralPath $Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "Unexpected path type: $Path" }
    $acl = Get-PackageAcl $Path $true
  } else { $acl = [Security.AccessControl.DirectorySecurity]::new() }
  $acl.SetAccessRuleProtection($true,$false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
  foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')) {
    $identity = [Security.Principal.SecurityIdentifier]::new($sid)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit, ObjectInherit','None','Allow')
    [void]$acl.AddAccessRule($rule)
  }
  if (Test-Path -LiteralPath $Path) { [IO.Directory]::SetAccessControl($Path,$acl) }
  else { [void][IO.Directory]::CreateDirectory($Path,$acl) }
  $check = Get-PackageAcl $Path $true
  if (-not $check.AreAccessRulesProtected) { throw "ACL inheritance could not be disabled: $Path" }
  foreach ($rule in $check.Access) {
    if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw "Incomplete package ACL: $Path" }
  }
}
function Initialize-PackageLayout {
  if (-not $env:LOCALAPPDATA -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) { throw 'LOCALAPPDATA must be an absolute directory.' }
  $script:Base = Join-Path ([IO.Path]::GetFullPath($env:LOCALAPPDATA)) 'NodeGoblin'
  $script:Runtime = Join-Path $script:Base 'runtime'
  Assert-PlainPath $script:Base
  if (Test-Path -LiteralPath $script:Base) { $null = Get-PackageAcl $script:Base $true }
  # Inspect existing data without changing its contents or ACLs.
  foreach ($name in @('config','state')) {
    $dir = Join-Path $script:Base $name
    if (Test-Path -LiteralPath $dir) {
      if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "Unexpected path type: $dir" }
      $null = Get-PackageAcl $dir $true
      foreach ($file in Get-ChildItem -LiteralPath $dir -Force) {
        Assert-PlainPath $file.FullName
        if ($file.PSIsContainer) { throw "Unexpected data directory: $($file.FullName)" }
        $null = Get-PackageAcl $file.FullName $false
      }
    }
  }
  # Existing data may inherit from Base; validate but never rewrite its ACL.
  if (-not (Test-Path -LiteralPath $script:Base)) { New-ProtectedPackageDirectory $script:Base }
}
function Get-RuntimeFiles([string]$Source) {
  Assert-PlainPath $Source
  $files = @('VERSION','package.json','cli.mjs','node-goblin.mjs','index.mjs',
    'deploy/windows/node-goblin.ps1','deploy/windows/desktop-helper.ps1',
    'deploy/windows/install.ps1','deploy/windows/update.ps1','deploy/windows/uninstall.ps1','deploy/windows/package-common.ps1')
  Assert-PlainPath (Join-Path $Source 'lib')
  foreach ($file in Get-ChildItem -LiteralPath $Source -Filter '*.mjs' -File) {
    if ($file.Name -notlike '*.test.mjs') { $files += $file.Name }
  }
  foreach ($file in Get-ChildItem -LiteralPath (Join-Path $Source 'lib') -Force) {
    Assert-PlainPath $file.FullName
    if ($file.PSIsContainer -or $file.Extension -ne '.mjs') { throw "Unexpected runtime library asset: $($file.Name)" }
    $files += "lib/$($file.Name)"
  }
  foreach ($relative in ($files | Sort-Object -Unique)) {
    $path = Join-Path $Source $relative
    Assert-PlainPath $path
    if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -eq 0) { throw "Incomplete package: $relative" }
    $relative
  }
}
function Assert-Node24 {
  $script:Node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Path
  $version = & $script:Node --version
  if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v24\.\d+\.\d+$') { throw 'Node.js 24 is required on PATH; install it explicitly before packaging.' }
}
function Assert-RuntimePackage([string]$Path, [string[]]$Files) {
  $metadata = Get-Content -LiteralPath (Join-Path $Path 'package.json') -Raw | ConvertFrom-Json
  $version = (Get-Content -LiteralPath (Join-Path $Path 'VERSION') -Raw).Trim()
  if ($metadata.type -ne 'module' -or $metadata.version -cne $version -or $version -notmatch '^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$') { throw 'Invalid or inconsistent package metadata.' }
  foreach ($relative in $Files) {
    if ($relative.EndsWith('.mjs')) {
      & $script:Node --check (Join-Path $Path $relative)
      if ($LASTEXITCODE -ne 0) { throw "Runtime syntax check failed: $relative" }
    }
  }
  & $script:Node --input-type=module -e 'import {pathToFileURL} from ''node:url''; await import(pathToFileURL(process.argv[1]))' (Join-Path $Path 'index.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Runtime dependency graph does not load.' }
}
function Assert-GatewayStopped {
  # Inspect our per-user installation, not unrelated services/other users. Never kill processes.
  $ownSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop)) {
    if (-not $process.CommandLine) {
      # Windows may deny even owner lookup for foreign processes. Do not turn
      # another account's uninspectable process into a per-user install blocker.
      try { $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop }
      catch { continue }
      if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $ownSid) { throw 'Cannot inspect a current-user Node process; resolve process visibility before packaging.' }
      continue # Other-user/SYSTEM processes are outside this per-user install.
    }
    $line = $process.CommandLine.Replace('/','\')
    if ($line.IndexOf($script:Runtime,[StringComparison]::OrdinalIgnoreCase) -ge 0) { throw "Target gateway is running (PID $($process.ProcessId)); stop it locally before packaging." }
  }
}
function Get-OwnedFiles([string]$Path) {
  Assert-PlainPath $Path
  $marker = Join-Path $Path '.node-goblin-package.json'
  Assert-PlainPath $marker
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw "Refusing unowned runtime: $Path" }
  $record = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
  if ($record.owner -cne 'NodeGoblin.Windows.Runtime.1') { throw 'Invalid runtime ownership marker.' }
  $files = @($record.files)
  if (-not $files.Count -or @($files | Sort-Object -Unique).Count -ne $files.Count) { throw 'Invalid runtime inventory.' }
  $dirs = @('lib','deploy','deploy/windows')
  foreach ($relative in $files) {
    if ($relative -notmatch '^(?:[a-zA-Z0-9_-]+\.mjs|VERSION|package\.json|lib/[a-zA-Z0-9_-]+\.mjs|deploy/windows/(?:node-goblin|desktop-helper|install|update|uninstall|package-common)\.ps1)$') { throw 'Invalid owned path.' }
    Assert-PlainPath (Join-Path $Path $relative)
  }
  $pending = @($Path)
  while ($pending.Count) {
    $next = $pending[0]; $pending = @($pending | Select-Object -Skip 1)
    foreach ($entry in Get-ChildItem -LiteralPath $next -Force) {
      Assert-PlainPath $entry.FullName
      $relative = $entry.FullName.Substring($Path.Length + 1).Replace('\','/')
      $null = Get-PackageAcl $entry.FullName ([bool]$entry.PSIsContainer)
      if ($entry.PSIsContainer) {
        if ($relative -notin $dirs) { throw "Unexpected runtime directory: $relative" }
        $pending += $entry.FullName
      } elseif ($relative -ne '.node-goblin-package.json' -and $relative -notin $files) { throw "Unowned runtime file: $relative" }
    }
  }
  $null = Get-PackageAcl $Path $true
  return $files
}
function Remove-OwnedRuntime([string]$Path) {
  $files = @(Get-OwnedFiles $Path)
  # Explicit leaves only: no recursive deletion or wildcard interpretation.
  foreach ($relative in $files) {
    $file = Join-Path $Path $relative
    if (Test-Path -LiteralPath $file -PathType Leaf) { [IO.File]::Delete($file) }
  }
  [IO.File]::Delete((Join-Path $Path '.node-goblin-package.json'))
  foreach ($relative in @('deploy/windows','deploy','lib')) {
    $dir = Join-Path $Path $relative
    if (Test-Path -LiteralPath $dir) { [IO.Directory]::Delete($dir,$false) }
  }
  [IO.Directory]::Delete($Path,$false)
}
function Invoke-PackageOperation([string]$Operation, [string]$Source) {
  Assert-PackageHost
  if (-not $env:LOCALAPPDATA -or $env:LOCALAPPDATA -notmatch '^[a-zA-Z]:[\\/]') { throw 'LOCALAPPDATA must be an absolute local drive directory.' }
  # Cross-session, per-user/path mutex serializes packaging, not foreground launches.
  $hash = [Security.Cryptography.SHA256]::Create()
  try { $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes(([IO.Path]::GetFullPath($env:LOCALAPPDATA)).ToUpperInvariant()))).Replace('-','') } finally { $hash.Dispose() }
  $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $mutex = [Threading.Mutex]::new($false,"Global\NodeGoblinPackaging-$userSid-$key")
  $held = $false
  try {
    try { $held = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) { throw 'Another packaging operation is active.' }
    Initialize-PackageLayout
    Assert-PlainPath $script:Runtime
    Assert-GatewayStopped
    $exists = Test-Path -LiteralPath $script:Runtime
    if ($Operation -eq 'install' -and $exists) { throw 'Runtime already exists; use update.ps1.' }
    if ($Operation -eq 'update' -and -not $exists) { throw 'No installed runtime; use install.ps1.' }
    if ($exists) { $null = Get-OwnedFiles $script:Runtime }
    if ($Operation -eq 'uninstall') {
      if ($exists) { Remove-OwnedRuntime $script:Runtime }
      Write-Output "Removed owned runtime only. Config, identity and journal preserved at $script:Base."
      return
    }
    Assert-Node24
    $Source = [IO.Path]::GetFullPath($Source).TrimEnd('\','/')
    # Neither nesting direction is safe for a package transaction.
    if ($Source.Equals($script:Base,[StringComparison]::OrdinalIgnoreCase) -or
        $Source.StartsWith($script:Base + '\',[StringComparison]::OrdinalIgnoreCase) -or
        $script:Base.StartsWith($Source + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Source and installation data must not overlap.' }
    $files = @(Get-RuntimeFiles $Source)
    $stage = Join-Path $script:Base ('.stage-' + [Guid]::NewGuid().ToString('N'))
    $backup = Join-Path $script:Base ('.backup-' + [Guid]::NewGuid().ToString('N'))
    New-ProtectedPackageDirectory $stage
    # Write inventory first so even incomplete staging can be safely cleaned up.
    @{ owner='NodeGoblin.Windows.Runtime.1'; files=$files } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage '.node-goblin-package.json') -Encoding UTF8
    $transactionError = $null
    try {
      foreach ($dir in @('lib','deploy','deploy/windows')) { New-ProtectedPackageDirectory (Join-Path $stage $dir) }
      foreach ($relative in $files) {
        Assert-PlainPath (Join-Path $Source $relative)
        [IO.File]::Copy((Join-Path $Source $relative),(Join-Path $stage $relative),$false)
      }
      Assert-RuntimePackage $stage $files
      $null = Get-OwnedFiles $stage
      Assert-GatewayStopped
      if ($exists) { [IO.Directory]::Move($script:Runtime,$backup) }
      try { [IO.Directory]::Move($stage,$script:Runtime) }
      catch {
        if ($exists) {
          try { [IO.Directory]::Move($backup,$script:Runtime) }
          catch { throw "Replacement and rollback failed. Prior runtime retained at $backup. $($_.Exception.Message)" }
        }
        throw
      }
      if ($exists) {
        try { Remove-OwnedRuntime $backup }
        catch { throw "New runtime installed; prior code cleanup failed at $backup. $($_.Exception.Message)" }
      }
      Write-Output "Installed foreground launcher: $script:Runtime\deploy\windows\node-goblin.ps1"
      Write-Output 'No gateway started. Configure and run explicitly as this user.'
    } catch {
      $transactionError = $_
      throw
    } finally {
      if (Test-Path -LiteralPath $stage) {
        try { Remove-OwnedRuntime $stage }
        catch {
          if ($transactionError) { Write-Warning "Staging cleanup failed at $stage. $($_.Exception.Message)" }
          else { throw }
        }
      }
    }
  } finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}
