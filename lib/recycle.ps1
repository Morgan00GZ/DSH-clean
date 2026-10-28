<#
.SYNOPSIS
  DSH-clean：把待清理项送进 Windows 回收站，并逐项校验「是否真的进了回收站」。

.DESCRIPTION
  背景（2026-10-14 实测，2026-10-28 复核）：DSH 的文件沙箱会拒绝写工作区外的路径，
  而回收站目录 <盘>:\$Recycle.Bin\<SID> 就在工作区外。此时 Shell 会把「删除到回收站」
  静默降级成永久删除，而且返回值是骗人的：
    - SHFileOperation + FOF_ALLOWUNDO 仍返回 rc=0，fAnyOperationsAborted 也是 false
    - Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile(..., SendToRecycleBin) 同样不报错
  唯一判据是删完去回收站里比对新增的 $R 条目。

  所以本脚本先自检回收站可写（不可写就一个都不删），再删，再逐项校验。

.PARAMETER ListFile
  JSON 文件路径，内容为数组：[{"id":1,"path":"D:\\某个目录"}, ...]（UTF-8）

.NOTES
  必须保存为 UTF-8 with BOM：本机 pwsh 实为 Windows PowerShell 5.1，无 BOM 会被当 ANSI 读，
  中文注释直接 ParserError。
  必须在放宽沙箱（danger-full-access）的调用里运行，否则第 2 步自检就拒绝。
  退出码：0 = 全部进箱；2 = 有项没进箱；4 = 回收站不可写（未删任何东西）
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ListFile
)

$ErrorActionPreference = 'Stop'

if (-not ('DshCleanRecycle.ShFileOp' -as [type])) {
  Add-Type -Namespace DshCleanRecycle -Name ShFileOp -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct SHFILEOPSTRUCT {
  public IntPtr hwnd; public uint wFunc; public IntPtr pFrom; public IntPtr pTo;
  public ushort fFlags; public bool fAnyOperationsAborted; public IntPtr hNameMappings; public IntPtr lpszProgressTitle;
}
[DllImport("shell32.dll", CharSet = CharSet.Unicode)]
public static extern int SHFileOperation(ref SHFILEOPSTRUCT lpFileOp);
public static int Recycle(string path, out bool aborted) {
  SHFILEOPSTRUCT fs = new SHFILEOPSTRUCT();
  fs.wFunc = 3;
  fs.pFrom = Marshal.StringToHGlobalUni(path + "\0");
  fs.fFlags = 0x0040 | 0x0010 | 0x0004 | 0x0400;
  int rc = SHFileOperation(ref fs);
  aborted = fs.fAnyOperationsAborted;
  Marshal.FreeHGlobal(fs.pFrom);
  return rc;
}
'@
}

$script:SelfSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Get-BinDir([string]$driveRoot) {
  return ('{0}\$Recycle.Bin\{1}' -f $driveRoot.TrimEnd('\'), $script:SelfSid)
}

function Test-BinWritable([string]$binDir) {
  if (-not (Test-Path -LiteralPath $binDir)) { return $false }
  try {
    $probe = Join-Path $binDir '__dsh_clean_probe.tmp'
    $fs = [System.IO.File]::Open($probe, 'Create', 'Write')
    $fs.Close()
    [System.IO.File]::Delete($probe)
    return $true
  } catch { return $false }
}

function Get-BinEntries([string]$binDir) {
  if (-not (Test-Path -LiteralPath $binDir)) { return @() }
  return @(Get-ChildItem -LiteralPath $binDir -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like '$R*' } |
            Select-Object Name, Length, @{ n = 'IsDir'; e = { $_.PSIsContainer } })
}

function Emit-And-Exit($obj, [int]$code) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  Write-Output ('DSH_CLEAN_RECYCLE_JSON:' + $json)
  exit $code
}

# ---- 1. 读清单 -------------------------------------------------------------
if (-not (Test-Path -LiteralPath $ListFile)) {
  Emit-And-Exit @{ ok = $false; reason = 'list-file-missing'; items = @() } 4
}
$raw = [System.IO.File]::ReadAllText($ListFile, [System.Text.Encoding]::UTF8)
# 坑：PowerShell 5.1 的 ConvertFrom-Json 把整个数组当成「一个」对象交给管道（不展开），
# 于是 @($raw | ConvertFrom-Json) 只会拿到 1 个元素（元素本身是 Object[]），
# 后面 $e.id 就变成 @(1,2)、$e.path 变成用空格拼起来的字符串 —— 必须自己逐个展开。
$parsed = $raw | ConvertFrom-Json
$list = @()
if ($null -ne $parsed) { foreach ($x in $parsed) { $list += $x } }
if ($list.Count -eq 0) { Emit-And-Exit @{ ok = $true; reason = 'empty'; items = @() } 0 }

$targets = @()
foreach ($e in $list) {
  $full = ''
  try { $full = [System.IO.Path]::GetFullPath([string]$e.path) } catch { }
  if (-not $full) { $targets += [pscustomobject]@{ Id = $e.id; Path = [string]$e.path; Exists = $false; IsDir = $false; Size = 0 }; continue }
  $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
  $targets += [pscustomobject]@{
    Id     = $e.id
    Path   = $full
    Exists = [bool]$item
    IsDir  = [bool]($item -and $item.PSIsContainer)
    Size   = $(if ($item -and -not $item.PSIsContainer) { [int64]$item.Length } else { -1 })
  }
}

# ---- 2. 回收站可写性自检（不通就一个都不删） ------------------------------
$bins = @{}
$drives = @($targets | Where-Object { $_.Exists } | ForEach-Object { [System.IO.Path]::GetPathRoot($_.Path) } | Sort-Object -Unique)
foreach ($drv in $drives) {
  $bin = Get-BinDir $drv
  $writable = Test-BinWritable $bin
  $bins[$drv] = @{ Dir = $bin; Writable = $writable }
  if (-not $writable) {
    Emit-And-Exit @{ ok = $false; reason = 'bin-not-writable'; binDir = $bin; items = @() } 4
  }
}

# ---- 3. 删除 ---------------------------------------------------------------
$before = @{}
foreach ($drv in $bins.Keys) { $before[$drv] = @(Get-BinEntries $bins[$drv].Dir) }

$results = @()
foreach ($t in $targets) {
  if (-not $t.Exists) {
    $results += [pscustomobject]@{ Id = $t.Id; Path = $t.Path; Kind = 'MISSING'; Size = 0; Rc = -1; BinEntry = '-' }
    continue
  }
  $aborted = $false
  $rc = 0
  try { $rc = [DshCleanRecycle.ShFileOp]::Recycle($t.Path, [ref]$aborted) } catch { $rc = -1 }
  Start-Sleep -Milliseconds 300
  $results += [pscustomobject]@{
    Id = $t.Id; Path = $t.Path
    Kind = $(if ($t.IsDir) { 'DIR' } else { 'FILE' })
    Size = $t.Size; Rc = $rc; BinEntry = '-'
    StillExists = (Test-Path -LiteralPath $t.Path)
    Drive = [System.IO.Path]::GetPathRoot($t.Path)
  }
}
Start-Sleep -Milliseconds 700

# ---- 4. 校验：回收站里是否真的多了对应条目 --------------------------------
$out = @()
foreach ($r in $results) {
  if ($r.Kind -eq 'MISSING') {
    $out += [pscustomobject]@{ id = $r.Id; path = $r.Path; status = 'MISSING'; bytes = 0; bin = '-' }
    continue
  }
  $binDir = $bins[$r.Drive].Dir
  $after = @(Get-BinEntries $binDir)
  $oldNames = @($before[$r.Drive] | ForEach-Object { $_.Name })
  $new = @($after | Where-Object { $oldNames -notcontains $_.Name })
  $match = $null
  if ($r.Kind -eq 'FILE') {
    $ext = [System.IO.Path]::GetExtension($r.Path)
    $cands = @($new | Where-Object { -not $_.IsDir -and [System.IO.Path]::GetExtension($_.Name) -eq $ext })
    if ($r.Size -gt 0) { $match = $cands | Where-Object { $_.Length -eq $r.Size } | Select-Object -First 1 }
    if (-not $match) { $match = $cands | Select-Object -First 1 }
  } else {
    $match = $new | Where-Object { $_.IsDir } | Select-Object -First 1
  }
  $status = if ($r.StillExists) { 'FAILED-STILL-THERE' } elseif ($match) { 'RECYCLED' } else { 'PERMANENT-DELETE' }
  $out += [pscustomobject]@{
    id = $r.Id; path = $r.Path; status = $status
    bytes = $(if ($r.Size -gt 0) { $r.Size } else { 0 })
    bin = $(if ($match) { $match.Name } else { '-' })
    rc = $r.Rc
  }
}

$bad = @($out | Where-Object { $_.status -ne 'RECYCLED' -and $_.status -ne 'MISSING' })
if ($bad.Count -gt 0) { Emit-And-Exit @{ ok = $false; reason = 'not-all-recycled'; items = $out } 2 }
Emit-And-Exit @{ ok = $true; reason = 'done'; items = $out } 0