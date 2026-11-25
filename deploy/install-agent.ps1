<#
.SYNOPSIS
  Install or update Network Monitor Agent on this computer (suitable for a GPO computer Startup Script).

.EXAMPLE
  .\install-agent.ps1 -ServerUrl http://monitor.example.local:3000 -SourcePath \\fileserver\apps\NetworkMonitorAgent

.NOTES
  Messages are intentionally ASCII/English: Windows PowerShell 5.1 reads BOM-less UTF-8 scripts as ANSI,
  and non-ASCII text can break parsing.
#>
param(
  [Parameter(Mandatory = $true)][string]$ServerUrl,
  # Folder containing the build output (the contents of client\dist\win-unpacked)
  [Parameter(Mandatory = $true)][string]$SourcePath,
  [string]$InstallDir = (Join-Path $env:ProgramFiles "NetworkMonitorAgent"),
  [string]$TaskName = "NetworkMonitorAgent"
)

$ErrorActionPreference = "Stop"
$exeName = "NetworkMonitorAgent.exe"
$dataDir = Join-Path $env:ProgramData "NetworkMonitor"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$logFile = Join-Path $dataDir "install.log"
function Log($message) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message" | Out-File -FilePath $logFile -Append -Encoding ascii
  Write-Host $message
}

try {
  $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "This script must run as Administrator (or SYSTEM when used from a GPO)."
  }

  $sourceExe = Join-Path $SourcePath $exeName
  if (-not (Test-Path $sourceExe)) { throw "$exeName not found in $SourcePath" }

  # 1) Copy the program (only when missing or the version differs)
  $installedExe = Join-Path $InstallDir $exeName
  $sourceVersion = (Get-Item $sourceExe).VersionInfo.FileVersion
  $installedVersion = ""
  if (Test-Path $installedExe) { $installedVersion = (Get-Item $installedExe).VersionInfo.FileVersion }

  if ($sourceVersion -ne $installedVersion) {
    Log "Installing/updating agent: '$installedVersion' -> '$sourceVersion'"
    Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($exeName)) -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    & robocopy $SourcePath $InstallDir /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
  } else {
    Log "Version $installedVersion is already installed."
  }

  # 2) Shared data folder: every Windows user must be able to read/write the agent id and key
  & icacls $dataDir /grant "*S-1-5-32-545:(OI)(CI)M" /Q | Out-Null

  # 3) Machine-wide config (no BOM). This server URL overrides any per-user setting.
  $config = @{ serverUrl = $ServerUrl.TrimEnd("/") } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $dataDir "config.json"), $config, $utf8NoBom)

  # 4) Unique id of this computer; created only if missing.
  #    If you install from a cloned image, delete agent-id before capturing the image.
  $idFile = Join-Path $dataDir "agent-id"
  if (-not (Test-Path $idFile)) {
    [IO.File]::WriteAllText($idFile, [guid]::NewGuid().ToString(), $utf8NoBom)
    Log "Created a new agent-id."
  }

  # 5) Start automatically at every user logon, inside that user's session (so the username is correct)
  $action = New-ScheduledTaskAction -Execute $installedExe -Argument "--hidden"
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -GroupId "BUILTIN\Users" -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

  Log "Done. The agent starts at the next logon of each user."
  exit 0
}
catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
}
