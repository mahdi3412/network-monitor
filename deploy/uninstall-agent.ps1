<#
.SYNOPSIS
  Remove Network Monitor Agent from this computer.
#>
param(
  [string]$InstallDir = (Join-Path $env:ProgramFiles "NetworkMonitorAgent"),
  [string]$TaskName = "NetworkMonitorAgent",
  # Also delete the agent id and settings (a reinstall then creates a new record)
  [switch]$RemoveData
)

$ErrorActionPreference = "Continue"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-Process -Name "NetworkMonitorAgent" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
if ($RemoveData) {
  $dataDir = Join-Path $env:ProgramData "NetworkMonitor"
  if (Test-Path $dataDir) { Remove-Item -Recurse -Force $dataDir }
}
Write-Host "Removed."
