param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$FilePath
)

$ErrorActionPreference = 'Stop'

if ($env:OPENMAIC_SIGNING_REQUIRED -ne '1') {
  Write-Host "[sign-windows] unsigned Release Candidate: $FilePath"
  exit 0
}

if (-not $env:WINDOWS_CERTIFICATE_PATH -or -not $env:WINDOWS_CERTIFICATE_PASSWORD) {
  throw 'Authenticode signing is required, but certificate environment variables are missing.'
}
if (-not (Test-Path -LiteralPath $env:WINDOWS_CERTIFICATE_PATH -PathType Leaf)) {
  throw 'Authenticode signing is required, but the certificate file does not exist.'
}

$signTool = Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $signTool) {
  $windowsKits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  if (Test-Path -LiteralPath $windowsKits) {
    $signTool = Get-ChildItem -LiteralPath $windowsKits -Filter signtool.exe -Recurse `
      | Where-Object { $_.Directory.Name -eq 'x64' } `
      | Sort-Object { [version]$_.Directory.Parent.Name } -Descending `
      | Select-Object -First 1
  }
}
if (-not $signTool) {
  throw 'signtool.exe is not available from PATH or the Windows 10 SDK.'
}

$signToolPath = if ($signTool.Source) { $signTool.Source } else { $signTool.FullName }
& $signToolPath sign /fd SHA256 /td SHA256 /tr 'http://timestamp.digicert.com' `
  /f $env:WINDOWS_CERTIFICATE_PATH /p $env:WINDOWS_CERTIFICATE_PASSWORD $FilePath
if ($LASTEXITCODE -ne 0) {
  throw "signtool.exe failed with exit code $LASTEXITCODE"
}

$signature = Get-AuthenticodeSignature -LiteralPath $FilePath
if ($signature.Status -ne 'Valid') {
  throw "Authenticode verification failed for ${FilePath}: $($signature.Status)"
}
