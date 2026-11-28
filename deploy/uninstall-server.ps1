<#
.SYNOPSIS
  Remove the Network Monitor server tasks and firewall rule (the database in data\ is NOT deleted).
#>
param(
  [int]$Port = 3000,
  [string]$ServerTaskName = "NetworkMonitorServer",
  [string]$BackupTaskName = "NetworkMonitorBackup"
)

Stop-ScheduledTask -TaskName $ServerTaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $ServerTaskName -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $BackupTaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName "Network Monitor (TCP $Port)" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host "Removed. The database folder was left untouched."
