# Zamolxis service installer (Windows Task Scheduler).
# Registers a task that starts Zamolxis at logon. By default it runs as the CURRENT USER so
# your `claude login` subscription credentials in %USERPROFILE%\.claude are available. No
# administrator rights are needed for that default (RunLevel Limited); registering the task for
# ANOTHER account with -RunAsUser normally needs an elevated PowerShell.
#
# For tighter security you can run Zamolxis under a SEPARATE, lower-privilege Windows account
# (so the always-on agent - which can run shell commands - is sandboxed away from your own
# profile and files). Pass -RunAsUser (and the task will run whether or not that user is
# logged on, using stored credentials you supply once):
#
#   powershell -ExecutionPolicy Bypass -File scripts\service-install.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\service-install.ps1 -RunAsUser "ZamolxisSvc"
#
# Notes when using -RunAsUser:
#   * Create the account first (Computer Management > Users, or `net user ZamolxisSvc <pwd> /add`).
#     Give it the *least* access it needs: its own profile, the Zamolxis folder, and the data dir.
#   * That user needs its OWN Claude login: run `claude setup-token` and put the
#     CLAUDE_CODE_OAUTH_TOKEN in the Zamolxis .env (the service user can't read YOUR Keychain/profile).
#   * Point the data dir somewhere that user owns, e.g. ZAMOLXIS_DATA_DIR=C:\ZamolxisData, in .env.
#   * You'll be prompted for that account's password (stored by Task Scheduler as a saved credential).
# ASCII only (PowerShell 5.1 reads .ps1 as Windows-1252).

param(
  [string]$TaskName = "Zamolxis",
  [string]$RunAsUser = ""
)
$ErrorActionPreference = "Stop"

$projectDir = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $projectDir "dist\index.js"
$nodeExe = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path $entry)) {
  throw "Build first: run 'npm run build' (missing $entry)"
}

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument "--enable-source-maps `"$entry`"" -WorkingDirectory $projectDir
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

if ($RunAsUser) {
  # Run under a dedicated account, started at system boot, whether or not that user is signed in.
  # Task Scheduler stores the password as a saved credential (S4U/Password logon).
  $cred = Get-Credential -UserName $RunAsUser -Message "Password for the Zamolxis service account '$RunAsUser'"
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId $RunAsUser -LogonType Password -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -User $cred.UserName -Password $cred.GetNetworkCredential().Password -Force | Out-Null
  Write-Host "Installed scheduled task '$TaskName' running as '$RunAsUser' (starts at boot)."
  Write-Host "Make sure that account has its own Claude token in .env (CLAUDE_CODE_OAUTH_TOKEN) and owns ZAMOLXIS_DATA_DIR."
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "Installed scheduled task '$TaskName' running as you (starts at your next logon)."
  Write-Host "For enhanced security, re-run with -RunAsUser <account> to sandbox it under a separate user."
}

Write-Host "Start it now with:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "Tip: enable at least one messaging channel in .env (CLI is disabled when running headless)."
