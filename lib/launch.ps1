param(
  [Parameter(Mandatory = $true)][string]$Script,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
$ErrorActionPreference = 'Stop'

$exe = $env:DSH_DESKTOP_NODE_EXECUTABLE
$cachedPath = Join-Path $env:LOCALAPPDATA 'dsh-clean\node-path.txt'
if (-not $exe -and (Test-Path -LiteralPath $cachedPath)) {
  $cached = (Get-Content -LiteralPath $cachedPath -TotalCount 1)
  if ($cached -and (Test-Path -LiteralPath $cached.Trim())) { $exe = $cached.Trim() }
}
$ver = ''
if (-not $exe) {
  $lines = @()
  try { $lines = @(& "$PSScriptRoot\find-node.ps1") } catch { $lines = @() }
  $exe = $lines | Select-Object -First 1
  $ver = $lines | Select-Object -Skip 1 -First 1
}
if (-not $exe) {
  foreach ($c in @(
    "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe",
    "$env:ProgramFiles\DeepSeek Harness\DeepSeek Harness.exe",
    "${env:ProgramFiles(x86)}\DeepSeek Harness\DeepSeek Harness.exe"
  )) {
    if ($c -and (Test-Path $c)) { $exe = $c; break }
  }
}

if (-not $exe -or -not (Test-Path $exe)) {
  Write-Host '[dsh-clean] Cannot find a Node runtime.'
  Write-Host '  Install DeepSeek Harness Desktop, or add node to PATH, then retry.'
  exit 3
}

try {
  $cacheDir = Join-Path $env:LOCALAPPDATA 'dsh-clean'
  if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
  Set-Content -LiteralPath (Join-Path $cacheDir 'node-path.txt') -Value $exe -Encoding ASCII
} catch { }

$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_CLEAN_DESKTOP_EXE = $exe
$env:DSH_CLEAN_DESKTOP_VERSION = $ver
& $exe $Script @Rest
exit $LASTEXITCODE
