param(
  [string]$Destination
)

$ErrorActionPreference = 'Stop'

$nodeVersion = '22.11.0'
$expectedSha256 = '7447c4ece014aa41fb2ff866c993c708e5a8213a00913cc2ac5049ea3ffc230d'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Destination) {
  $Destination = Join-Path $root 'src-tauri\binaries\node-x86_64-pc-windows-msvc.exe'
}

$destinationPath = [System.IO.Path]::GetFullPath($Destination)
$destinationDirectory = Split-Path -Parent $destinationPath
New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null

$downloadPath = Join-Path $env:TEMP "openmaic-node-v$nodeVersion-$PID.exe"
try {
  Invoke-WebRequest `
    -Uri "https://nodejs.org/dist/v$nodeVersion/win-x64/node.exe" `
    -OutFile $downloadPath

  $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloadPath).Hash.ToLowerInvariant()
  if ($actualSha256 -ne $expectedSha256) {
    throw "Node sidecar checksum mismatch: expected $expectedSha256, received $actualSha256"
  }

  Move-Item -LiteralPath $downloadPath -Destination $destinationPath -Force
  $actualVersion = (& $destinationPath --version).Trim()
  if ($actualVersion -ne "v$nodeVersion") {
    throw "Node sidecar version mismatch: expected v$nodeVersion, received $actualVersion"
  }

  Write-Host "[prepare-windows-sidecar] Node $actualVersion verified at $destinationPath"
} finally {
  if (Test-Path -LiteralPath $downloadPath) {
    Remove-Item -LiteralPath $downloadPath -Force
  }
}
