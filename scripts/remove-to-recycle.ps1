param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string[]]$Path,

  [switch]$Permanent
)

# Remove para a LIXIRA, nao apaga de vez.
#
# Regra do dono: nada e apagado permanentemente sem necessidade comprovada.
# `Remove-Item -Force` ja destruiu builds inteiros de 1.0.6 antes desta regra
# existir, e saida de build nao versionada pelo git nao tem volta.
#
# Use -Permanent SO para alvo regeneravel (dist/, node_modules/, .vite/).
# Para qualquer coisa que o dono possa querer de volta, a lixeira e o destino.
#
# Implementacao: SHFileOperationW com FOF_ALLOWUNDO. E a API nativa que o
# Explorer usa por tras do "Enviar para a Lixeira".
#
# Descartados antes:
#   - Microsoft.VisualBasic.FileIO — o assembly nao existe neste PowerShell
#   - Shell.Application.MoveHere — silenciosamente nao move sem sessao desktop
#     interativa, e o script nao-detectava: reportava sucesso sem apagar nada.

$ErrorActionPreference = 'Stop'

if (-not ('StPlay.Native' -as [type])) {
  Add-Type -Namespace 'StPlay' -Name 'Native' -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct SHFILEOPSTRUCTW {
  public IntPtr hwnd;
  public uint wFunc;
  [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
  [MarshalAs(UnmanagedType.LPWStr)] public string pTo;
  public ushort fFlags;
  [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
  public IntPtr hNameMappings;
  [MarshalAs(UnmanagedType.LPWStr)] public string lpszProgressTitle;
}

[DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern int SHFileOperationW(ref SHFILEOPSTRUCTW lpFileOp);
'@
}

$FO_DELETE = 0x0003
$FOF_ALLOWUNDO = 0x0040
$FOF_NOCONFIRMATION = 0x0010
$FOF_SILENT = 0x0004
$FOF_NOERRORUI = 0x0400

$targets = @()
foreach ($p in $Path) {
  $full = [System.IO.Path]::GetFullPath($p)
  if (-not (Test-Path -LiteralPath $full)) {
    Write-Warning "nao existe, pulando: $full"
    continue
  }
  $targets += $full
}

if ($targets.Count -eq 0) { exit 0 }

foreach ($full in $targets) {
  $isDir = (Get-Item -LiteralPath $full) -is [System.IO.DirectoryInfo]

  if ($Permanent) {
    if ($isDir) { Remove-Item -LiteralPath $full -Recurse -Force }
    else { Remove-Item -LiteralPath $full -Force }
    Write-Host "  APAGADO (permanente): $full"
    continue
  }

  $op = New-Object StPlay.Native+SHFILEOPSTRUCTW
  $op.hwnd = [IntPtr]::Zero
  $op.wFunc = $FO_DELETE
  $op.pFrom = "$full`0`0"   # NUL duplo: lista double-null terminated
  $op.pTo = $null
  $op.fFlags = $FOF_ALLOWUNDO -bor $FOF_NOCONFIRMATION -bor $FOF_SILENT -bor $FOF_NOERRORUI
  $op.lpszProgressTitle = $null

  $rc = [StPlay.Native]::SHFileOperationW([ref]$op)

  if ($op.fAnyOperationsAborted) { throw "operacao cancelada: $full" }
  if ($rc -ne 0) { throw "SHFileOperationW falhou (codigo $rc): $full" }
  if (Test-Path -LiteralPath $full) { throw "continua no disco apos mover para a lixeira: $full" }

  Write-Host "  lixeira: $full"
}
