$ErrorActionPreference = 'SilentlyContinue'
$hives = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($h in $hives) {
  if (-not (Test-Path $h)) { continue }
  foreach ($k in (Get-ChildItem $h)) {
    $p = Get-ItemProperty $k.PSPath
    if ($p.DisplayName -like 'DeepSeek Harness*' -and $p.DisplayIcon) {
      $icon = $p.DisplayIcon -replace ',\d+$', ''
      if (Test-Path $icon) {
        Write-Output $icon
        Write-Output $p.DisplayVersion
        return
      }
    }
  }
}
