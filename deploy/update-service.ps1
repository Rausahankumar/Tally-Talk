<#
.SYNOPSIS
  Repeatable deploy/update for an already-installed Tally-Talk Windows
  Service (see install-service.ps1 for the one-time setup).

.DESCRIPTION
  stop service -> git fetch/checkout the requested ref -> npm ci (only if
  package.json/package-lock.json changed) -> start service -> smoke-check
  /health.

  .env and the data\ directory (SQLite database + its -wal/-shm sidecar
  files) are NEVER touched by this script. They are both already excluded
  from git (.gitignore), so a `git checkout`/`git pull` cannot overwrite or
  delete them by construction - this script additionally verifies both are
  still present before and after, as a safety check, not as the actual
  protection mechanism.

.PARAMETER Ref
  Git branch, tag, or commit to deploy. Recommended: a tag, for a
  reproducible release. Default: main.

.PARAMETER ServiceName
  Windows Service name. Default: TallyTalk.

.PARAMETER InstallDir
  The Tally-Talk repository root on this machine. Default: the repo root
  this script lives under (assumes it stays in deploy/).

.PARAMETER NssmPath
  Path to nssm.exe. Default: assumes `nssm` is already on PATH.

.PARAMETER HealthPort
  Port to smoke-check /health against after restart. Default: read from
  .env's PORT, falling back to 3000 (the app's own default - see
  src/config/index.js).

.EXAMPLE
  .\update-service.ps1 -Ref v0.3.0
  .\update-service.ps1 -Ref main
#>
[CmdletBinding()]
param(
  [string]$Ref = 'main',
  [string]$ServiceName = 'TallyTalk',
  [string]$InstallDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$NssmPath = 'nssm',
  [int]$HealthPort = 0
)

$ErrorActionPreference = 'Stop'

function Assert-Command($name, $hint) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($null -eq $cmd) {
    throw "$name was not found on PATH. $hint"
  }
  return $cmd
}

$nssmCmd = Assert-Command $NssmPath 'Install NSSM (https://nssm.cc/) and ensure nssm.exe is on PATH, or pass -NssmPath <full path to nssm.exe>.'
Assert-Command 'git' 'git is required to fetch/checkout the release.' | Out-Null
Assert-Command 'npm' 'Node.js/npm is required to reinstall dependencies when they change.' | Out-Null

Push-Location $InstallDir
try {
  $envFile = Join-Path $InstallDir '.env'
  $dataDir = Join-Path $InstallDir 'data'
  if (-not (Test-Path $envFile)) { throw ".env not found at '$envFile' - refusing to deploy onto an unconfigured install." }
  if (-not (Test-Path $dataDir)) {
    Write-Warning "data\ does not exist yet at '$dataDir' - normal only for a brand-new install that has never started once."
  }
  $envHashBefore = (Get-FileHash $envFile -Algorithm SHA256).Hash
  $dataExistedBefore = Test-Path $dataDir

  Write-Host "Stopping service '$ServiceName'..."
  & $nssmCmd.Source stop $ServiceName 2>$null | Out-Null

  $beforeSha = (git rev-parse HEAD).Trim()
  Write-Host "Current commit: $beforeSha"

  Write-Host "Fetching and checking out '$Ref'..."
  git fetch origin --tags --prune
  git checkout $Ref
  # If $Ref is a branch (HEAD is not detached), fast-forward to its remote
  # tip too - a bare `git checkout <branch>` alone does not pull new commits.
  $onBranch = git symbolic-ref -q HEAD
  if ($LASTEXITCODE -eq 0 -and $onBranch) {
    git pull --ff-only origin $Ref
  }

  $afterSha = (git rev-parse HEAD).Trim()
  Write-Host "Deployed commit: $afterSha"

  # Safety check - this should be structurally impossible (both paths are
  # gitignored), but confirm rather than assume.
  if ((Get-FileHash $envFile -Algorithm SHA256).Hash -ne $envHashBefore) {
    throw ".env changed during checkout - this should never happen (.env is gitignored). Stopping before starting the service on a potentially wrong configuration."
  }
  if ($dataExistedBefore -and -not (Test-Path $dataDir)) {
    throw "data\ disappeared during checkout - this should never happen (data\ is gitignored). Stopping before starting the service."
  }

  $changedFiles = if ($beforeSha -ne $afterSha) { git diff --name-only $beforeSha $afterSha } else { @() }
  $depsChanged = $changedFiles -contains 'package.json' -or $changedFiles -contains 'package-lock.json'
  if ($depsChanged) {
    Write-Host 'package.json/package-lock.json changed - running npm ci --omit=dev...'
    npm ci --omit=dev
  } else {
    Write-Host 'No dependency changes detected - skipping npm ci.'
  }

  Write-Host "Starting service '$ServiceName'..."
  & $nssmCmd.Source start $ServiceName

  if ($HealthPort -eq 0) {
    $portLine = Get-Content $envFile | Where-Object { $_ -match '^\s*PORT\s*=\s*(\d+)\s*$' } | Select-Object -First 1
    $HealthPort = if ($portLine -match '(\d+)') { [int]$Matches[1] } else { 3000 }
  }
  $healthUrl = "http://127.0.0.1:$HealthPort/health"
  Write-Host "Smoke-checking $healthUrl ..."
  $ok = $false
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 2
    try {
      $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) { $ok = $true; break }
    } catch {
      # Not up yet - startup runs config/db init and a Tally sync before
      # listening (see server.js); keep retrying within the loop.
    }
  }

  if (-not $ok) {
    Write-Error "Smoke check FAILED: $healthUrl did not return 200 after restart. Check logs\tallytalk.err.log. The service was started but may not be healthy - this script does not auto-rollback."
    exit 1
  }

  Write-Host ''
  Write-Host "Deployment of '$Ref' ($afterSha) complete. Service is healthy."
} finally {
  Pop-Location
}
