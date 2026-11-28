# Run from the replacement source/release folder after stopping the gateway locally.
[CmdletBinding()]
param([string]$Source = (Join-Path $PSScriptRoot '..\..'))
. (Join-Path $PSScriptRoot 'package-common.ps1')
Invoke-PackageOperation 'update' $Source
