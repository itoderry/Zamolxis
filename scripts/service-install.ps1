# Zamolxis service installer (Windows Task Scheduler).
# Registers a task that starts Zamolxis at logon, running as the CURRENT USER
# so that your `claude login` subscription credentials in %USERPROFILE%\.claude
# are available to the engine. No administrator rights required (RunLevel Limited).
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\service-install.ps1
# ASCII only (PowerShell 5.1 reads .ps1 as Windows-1252).

param(
  [string]$TaskName = "Zamolxis"
)
$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $projectDir "dist\index.js"
$nodeExe = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path $entry)) {
  throw "Build first: run 'npm run build' (missing $entry)"
}

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument "--enable-source-maps `"$entry`"" -WorkingDirectory $projectDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName'."
Write-Host "It will start Zamolxis automatically at your next logon."
Write-Host "Start it now with:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "Tip: enable at least one messaging channel in .env (CLI is disabled when running headless)."
