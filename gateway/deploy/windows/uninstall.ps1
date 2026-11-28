# Remove only the owned runtime. No option deletes identity, config or journal.
[CmdletBinding()]
param()
. (Join-Path $PSScriptRoot 'package-common.ps1')
Invoke-PackageOperation 'uninstall' ''
