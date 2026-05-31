# Removes the Zamolxis scheduled task.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\service-uninstall.ps1
# ASCII only.

param(
  [string]$TaskName = "Zamolxis"
)
$ErrorActionPreference = "Stop"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $existing) {
  Write-Host "No scheduled task named '$TaskName' found."
  return
}
try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Removed scheduled task '$TaskName'."
