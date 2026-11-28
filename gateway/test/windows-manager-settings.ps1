# Run with Windows PowerShell 5.1 using the built WinForms manager.
param([Parameter(Mandatory=$true)][string]$ManagerExe)
$ErrorActionPreference = 'Stop'
[void][Reflection.Assembly]::LoadFrom((Resolve-Path -LiteralPath $ManagerExe).Path)

function Assert-Rejected([scriptblock]$Action, [string]$Reason) {
    try { & $Action }
    catch {
        if ($_.Exception.GetBaseException().Message -like "*$Reason*") { return }
        throw
    }
    throw "Expected rejection: $Reason"
}

# Modeless Close and Program's using can both call Dispose. Exercise the
# actual built form, not a source-text approximation of native cleanup.
$instance = [NodeGoblin.ManagerInstance]::new()
try {
    $form = [NodeGoblin.ManagerForm]::new($instance)
    try {
        $form.Dispose()
        $form.Dispose()
        if (-not $form.IsDisposed) { throw 'The manager form was not disposed.' }
    } finally { $form.Dispose() }
} finally { $instance.Dispose() }
Write-Output 'Node Goblin repeated native form disposal passed.'

$profileRoot = Join-Path ([IO.Path]::GetTempPath()) ('node-goblin-manager-' + [Guid]::NewGuid().ToString('N'))
try {
    $store = [NodeGoblin.ManagerSettings]::new($profileRoot)
    # Create the disposable parent so Prepare can create a private NodeGoblin root.
    [void][IO.Directory]::CreateDirectory($profileRoot)
    $store.Prepare()
    $config = Join-Path $profileRoot 'NodeGoblin\config\gateway.env'
    [IO.File]::WriteAllText($config, "BURROW_GATEWAY_CONTROLLER_URL=tls://localhost:7443`nBURROW_GATEWAY_ID=legacy`nCUSTOM_KEY=retained`n")
    $identity = Join-Path $store.StateDirectory 'node-identity.json'
    [IO.File]::WriteAllText($identity, '{"existing":"keep"}')
    $settings = [NodeGoblin.GatewaySettings]::new('tls://localhost:7443', 'legacy')
    $other = [NodeGoblin.GatewaySettings]::new('tls://localhost:7444', 'legacy')
    if ($store.HasConsent($settings)) { throw 'Legacy config unexpectedly granted manager consent.' }
    $store.SaveConsent($settings)
    if (-not $store.HasConsent($settings) -or $store.HasConsent($other)) { throw 'Consent did not bind the settings.' }
    if ($store.ReadConfig()['CUSTOM_KEY'] -cne 'retained') { throw 'Existing gateway.env data was lost.' }
    if ([IO.File]::ReadAllText($identity) -cne '{"existing":"keep"}') { throw 'Existing identity was modified.' }
    if (-not ([IO.Directory]::GetAccessControl($store.StateDirectory)).AreAccessRulesProtected) { throw 'State directory inherited its ACL.' }

    $acl = [IO.File]::GetAccessControl($identity)
    $all = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($all, 'Read', 'Allow')
    $acl.AddAccessRule($rule)
    [IO.File]::SetAccessControl($identity, $acl)
    Assert-Rejected { $store.Prepare() } 'Unexpected access rule'
    [IO.File]::Delete($identity)

    $junction = Join-Path $store.StateDirectory 'junction'
    try {
        $argsForCmd = '/d /c mklink /j "{0}" "{1}"' -f $junction, $profileRoot
        $mklink = Start-Process -FilePath $env:ComSpec -ArgumentList $argsForCmd -NoNewWindow -Wait -PassThru
        if ($mklink.ExitCode -ne 0) { throw 'Could not create the disposable junction.' }
        Assert-Rejected { $store.Prepare() } 'reparse point'
    } finally {
        if ([IO.Directory]::Exists($junction)) { [IO.Directory]::Delete($junction) }
    }
    $store.Prepare()
    Write-Output 'Node Goblin settings, consent, ACL and reparse checks passed.'
} finally {
    if (Test-Path -LiteralPath $profileRoot) { Remove-Item -LiteralPath $profileRoot -Recurse -Force }
}
