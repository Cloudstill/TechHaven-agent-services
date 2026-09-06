[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[A-Za-z0-9.-]+$")]
  [string]$Server,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^[A-Za-z0-9._-]+$")]
  [string]$User,

  [Parameter(Mandatory = $true)]
  [ValidatePattern("^/[A-Za-z0-9._/-]+$")]
  [string]$DeployRoot,

  [ValidateRange(1, 65535)]
  [int]$Port = 22,

  [string]$IdentityFile,

  [switch]$SkipInstall,
  [switch]$SkipBuild,
  [switch]$PackageOnly,
  [string]$OutputArchive
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($DeployRoot -eq "/" -or $DeployRoot.Contains("..")) {
  throw "DeployRoot must be an absolute, non-root Linux path without '..'."
}

$repoRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$gatewayRoot = Join-Path $repoRoot "services\techhaven-gateway"
$bffRoot = Join-Path $repoRoot "services\techhaven-bff"
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd("\") + "\"
$workRoot = Join-Path $tempBase ("techhaven-deploy-" + [Guid]::NewGuid().ToString("N"))
$stageRoot = Join-Path $workRoot "release"
$archivePath = Join-Path $workRoot "techhaven-server-release.tgz"

function Assert-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found in PATH."
  }
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )
  Push-Location $WorkingDirectory
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "Command failed (exit=$LASTEXITCODE): $Command $($Arguments -join ' ')"
    }
  } finally {
    Pop-Location
  }
}

function Copy-RequiredItem {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Required release item is missing: $Source"
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

Assert-Command "npm"
Assert-Command "tar"
if (-not $PackageOnly) {
  Assert-Command "scp"
  Assert-Command "ssh"
}

$resolvedIdentity = $null
if ($IdentityFile) {
  $resolvedIdentity = (Resolve-Path -LiteralPath $IdentityFile).Path
}

try {
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

  if (-not $SkipInstall) {
    Invoke-Checked -Command "npm" -Arguments @("run", "install:services") -WorkingDirectory $repoRoot
  }
  if (-not $SkipBuild) {
    Invoke-Checked -Command "npm" -Arguments @("run", "build") -WorkingDirectory $repoRoot
  }
  Invoke-Checked -Command "npm" -Arguments @("run", "package:release", "--", $archivePath) -WorkingDirectory $repoRoot
  if ($PackageOnly) {
    $targetArchive = if ($OutputArchive) { [System.IO.Path]::GetFullPath($OutputArchive) } else { Join-Path $repoRoot "techhaven-agent-release.tgz" }
    Copy-Item -LiteralPath $archivePath -Destination $targetArchive -Force
    Write-Host "Agent-only release archive created: $targetArchive"
    return
  }

  $remoteSuffix = "$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())-$PID"
  $remoteArchive = "/tmp/techhaven-release-$remoteSuffix.tgz"
  $remoteScript = "/tmp/techhaven-deploy-$remoteSuffix.sh"
  $remoteTarget = "${User}@${Server}"
  $scpOptions = @("-P", "$Port")
  $sshOptions = @("-p", "$Port")
  if ($resolvedIdentity) {
    $scpOptions += @("-i", $resolvedIdentity)
    $sshOptions += @("-i", $resolvedIdentity)
  }

  Write-Host "[4/5] Uploading release to ${remoteTarget}..."
  Invoke-Checked -Command "scp" -Arguments ($scpOptions + @($archivePath, "${remoteTarget}:$remoteArchive")) -WorkingDirectory $repoRoot
  Invoke-Checked -Command "scp" -Arguments ($scpOptions + @((Join-Path $PSScriptRoot "deploy-server-release.sh"), "${remoteTarget}:$remoteScript")) -WorkingDirectory $repoRoot

  Write-Host "[5/5] Activating release, restarting, and checking health..."
  Invoke-Checked -Command "ssh" -Arguments ($sshOptions + @($remoteTarget, "bash", $remoteScript, $remoteArchive, $DeployRoot)) -WorkingDirectory $repoRoot
  Write-Host "Deployment complete. Agent services: $DeployRoot/current/services; Gateway: http://127.0.0.1:3091; BFF: http://127.0.0.1:3092"
} finally {
  $resolvedWorkRoot = [System.IO.Path]::GetFullPath($workRoot)
  if ($resolvedWorkRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase) -and
      [System.IO.Path]::GetFileName($resolvedWorkRoot).StartsWith("techhaven-deploy-")) {
    if (Test-Path -LiteralPath $resolvedWorkRoot) {
      Remove-Item -LiteralPath $resolvedWorkRoot -Recurse -Force
    }
  }
}
