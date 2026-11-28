# Per-user foreground package installation. Does not start the gateway.
[CmdletBinding()]
param([string]$Source = (Join-Path $PSScriptRoot '..\..'))
. (Join-Path $PSScriptRoot 'package-common.ps1')
Invoke-PackageOperation 'install' $Source
