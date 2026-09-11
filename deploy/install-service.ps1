<#
.SYNOPSIS
  One-time registration of Tally-Talk as a Windows Service, using NSSM.

.DESCRIPTION
  Wraps `node src/server.js` (the exact same entry point `npm start` runs)
  as a native Windows Service via NSSM, so it survives reboots and restarts
  itself on a crash without any manual intervention.

  This script only INSTALLS the service definition. It does not touch
  application code, does not create .env, and does not start Tally. Run it
  once per machine; use update-service.ps1 for every deployment after that.

.PARAMETER ServiceName
  Windows Service name. Default: TallyTalk.

.PARAMETER InstallDir
  The Tally-Talk repository root on this machine (contains package.json,
  src/, .env). Default: the directory this script's parent folder lives in
  (i.e. the repo root, assuming this script stays under deploy/).

.PARAMETER NssmPath
  Path to nssm.exe. Default: assumes `nssm` is already on PATH.

.EXAMPLE
  # Run from an elevated PowerShell prompt:
  .\install-service.ps1
  .\install-service.ps1 -ServiceName TallyTalk -InstallDir 'D:\Tally-Talk'
#>
[CmdletBinding()]
param(
  [string]$ServiceName = 'TallyTalk',
  [string]$InstallDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$NssmPath = 'nssm'
)

$ErrorActionPreference = 'Stop'

function Assert-Command($name, $hint) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($null -eq $cmd) {
    throw "$name was not found on PATH. $hint"
  }
  return $cmd
}

Write-Host "Installing Windows Service '$ServiceName' for Tally-Talk at '$InstallDir'..."

$nodeCmd = Assert-Command 'node' 'Install Node.js (>=22.13.0 - required by this project''s use of node:sqlite) and ensure it is on PATH.'
$nssmCmd = Assert-Command $NssmPath 'Install NSSM (https://nssm.cc/) and ensure nssm.exe is on PATH, or pass -NssmPath <full path to nssm.exe>.'

$envFile = Join-Path $InstallDir '.env'
if (-not (Test-Path $envFile)) {
  throw ".env not found at '$envFile'. Copy .env.example to .env and fill in real values before installing the service."
}

$serverEntry = Join-Path $InstallDir 'src\server.js'
if (-not (Test-Path $serverEntry)) {
  throw "src\server.js not found under '$InstallDir'. Is -InstallDir pointing at the Tally-Talk repository root?"
}

$logDir = Join-Path $InstallDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stdoutLog = Join-Path $logDir 'tallytalk.out.log'
$stderrLog = Join-Path $logDir 'tallytalk.err.log'

# Remove any pre-existing service of the same name first, so re-running this
# script is safe (install-service.ps1 is a one-time setup step, but making
# it idempotent avoids a confusing "service already exists" failure).
$existing = & $nssmCmd.Source status $ServiceName 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Service '$ServiceName' already exists - removing it first so this install is clean."
  & $nssmCmd.Source stop $ServiceName confirm 2>$null | Out-Null
  & $nssmCmd.Source remove $ServiceName confirm | Out-Null
}

# `--env-file=.env` is the exact same flag `npm start`/`npm run dev` already
# use - no new config-loading mechanism, just the same one under NSSM.
& $nssmCmd.Source install $ServiceName $nodeCmd.Source '--env-file=.env' 'src\server.js'
& $nssmCmd.Source set $ServiceName AppDirectory $InstallDir
& $nssmCmd.Source set $ServiceName AppStdout $stdoutLog
& $nssmCmd.Source set $ServiceName AppStderr $stderrLog
# Rotate logs so they don't grow unbounded - NSSM appends across restarts by
# default; rotate online (while running) once a file exceeds ~10MB.
& $nssmCmd.Source set $ServiceName AppRotateFiles 1
& $nssmCmd.Source set $ServiceName AppRotateOnline 1
& $nssmCmd.Source set $ServiceName AppRotateBytes 10485760
# Auto-restart on crash: NSSM's default action for an unexpected exit is
# already "restart", but set it explicitly with a short delay so a rapid
# crash loop (e.g. Tally not up yet on first boot - see startupSync.js)
# backs off instead of hammering the process.
& $nssmCmd.Source set $ServiceName AppExit Default Restart
& $nssmCmd.Source set $ServiceName AppRestartDelay 5000
# Start automatically on boot, and start it now.
& $nssmCmd.Source set $ServiceName Start SERVICE_AUTO_START
& $nssmCmd.Source set $ServiceName DisplayName 'Tally-Talk'
& $nssmCmd.Source set $ServiceName Description 'Conversational AI assistant that creates TallyPrime vouchers from Telegram messages.'

Write-Host "Starting '$ServiceName'..."
& $nssmCmd.Source start $ServiceName

Write-Host ''
Write-Host "Done. Logs: $stdoutLog / $stderrLog"
Write-Host "Check status any time with: nssm status $ServiceName"
