<#
.SYNOPSIS
  Install the Network Monitor dashboard server as a Windows startup task, plus a daily database backup.

.DESCRIPTION
  Prerequisites (run once, as the user who owns the project folder):
    npm install
    npm run build
  Then run this script from an elevated PowerShell:
    .\deploy\install-server.ps1 -Port 3000 -RemoteAddress 10.0.0.0/8,192.168.0.0/16

  The server runs as SYSTEM. With AD_AUTH_MODE=integrated the AD queries then run as the
  computer account of this server (it can normally read user attributes in the domain).

.NOTES
  Messages are intentionally ASCII/English (Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI).
#>
param(
  [string]$ProjectDir = (Split-Path -Parent $PSScriptRoot),
  [int]$Port = 3000,
  # Firewall scope: client subnets and admin addresses allowed to reach the server. Default: any.
  [string[]]$RemoteAddress = @("Any"),
  [string]$BackupTime = "02:00",
  [string]$ServerTaskName = "NetworkMonitorServer",
  [string]$BackupTaskName = "NetworkMonitorBackup"
)

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script from an elevated (Administrator) PowerShell."
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node.exe was not found in PATH. Install Node.js 18+ first." }

$nextBin = Join-Path $ProjectDir "node_modules\next\dist\bin\next"
if (-not (Test-Path $nextBin)) { throw "Dependencies are missing. Run 'npm install' in $ProjectDir first." }
if (-not (Test-Path (Join-Path $ProjectDir "dashboard\.next"))) { throw "No production build found. Run 'npm run build' in $ProjectDir first." }

# 1) dashboard\.env.local: keep PORT in sync (the server triggers its own scans on this port)
$envFile = Join-Path $ProjectDir "dashboard\.env.local"
$lines = @()
if (Test-Path $envFile) { $lines = @(Get-Content $envFile | Where-Object { $_ -notmatch '^\s*PORT=' }) }
$lines += "PORT=$Port"
[IO.File]::WriteAllLines($envFile, $lines, (New-Object System.Text.UTF8Encoding($false)))

# 2) Server task: start at boot, restart on failure, run as SYSTEM
$serverAction = New-ScheduledTaskAction -Execute $node -Argument "`"$nextBin`" start dashboard -p $Port" -WorkingDirectory $ProjectDir
$serverTrigger = New-ScheduledTaskTrigger -AtStartup
$serverPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$serverSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $ServerTaskName -Action $serverAction -Trigger $serverTrigger `
  -Principal $serverPrincipal -Settings $serverSettings -Force | Out-Null

# 3) Daily backup task
$backupAction = New-ScheduledTaskAction -Execute $node -Argument "`"dashboard\scripts\backup.mjs`"" -WorkingDirectory $ProjectDir
$backupTrigger = New-ScheduledTaskTrigger -Daily -At $BackupTime
Register-ScheduledTask -TaskName $BackupTaskName -Action $backupAction -Trigger $backupTrigger `
  -Principal $serverPrincipal -Force | Out-Null

# 4) Firewall rule (replace if it already exists)
$ruleName = "Network Monitor (TCP $Port)"
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port `
  -Action Allow -Profile Domain,Private -RemoteAddress $RemoteAddress | Out-Null

Start-ScheduledTask -TaskName $ServerTaskName
Write-Host "Server task '$ServerTaskName' started on port $Port. Backup runs daily at $BackupTime."
Write-Host "Health check: http://localhost:$Port/api/health"
