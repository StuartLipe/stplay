$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
try { [System.Windows.Forms.Application]::SetHighDpiMode([System.Windows.Forms.HighDpiMode]::PerMonitorV2) } catch {}
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class NativeHost {
  public const int GWL_STYLE = -16;
  public const int GWL_EXSTYLE = -20;
  public const long WS_CHILD = 0x40000000;
  public const long WS_VISIBLE = 0x10000000;
  public const long WS_POPUP = unchecked((long)0x80000000);
  public const long WS_CAPTION = 0x00C00000;
  public const long WS_THICKFRAME = 0x00040000;
  public const long WS_SYSMENU = 0x00080000;
  public const long WS_CLIPCHILDREN = 0x02000000;
  public const long WS_CLIPSIBLINGS = 0x04000000;
  public const long WS_EX_TOPMOST = 0x00000008;
  public const long WS_EX_APPWINDOW = 0x00040000;
  public const long WS_EX_TOOLWINDOW = 0x00000080;
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const uint SWP_SHOWWINDOW = 0x0040;
  public const uint SWP_FRAMECHANGED = 0x0020;
  public static readonly IntPtr HWND_TOP = IntPtr.Zero;

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  public delegate bool EnumProc(IntPtr h, IntPtr lp);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int n);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr h, int n, IntPtr v);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr lp);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);

  public static void OrStyle(IntPtr h, long flags) {
    long style = GetWindowLongPtr(h, GWL_STYLE).ToInt64();
    SetWindowLongPtr(h, GWL_STYLE, new IntPtr(style | flags));
  }

  public static void PrepareElectronParent(IntPtr parent) {
    if (!IsWindow(parent)) return;
    OrStyle(parent, WS_CLIPCHILDREN);
    EnumChildWindows(parent, (h, _) => {
      var title = new StringBuilder(256);
      var cls = new StringBuilder(256);
      GetWindowTextW(h, title, 256);
      GetClassNameW(h, cls, 256);
      string t = title.ToString();
      string c = cls.ToString();
      if (t.IndexOf("Intermediate D3D", StringComparison.OrdinalIgnoreCase) >= 0
          || c.IndexOf("Intermediate D3D", StringComparison.OrdinalIgnoreCase) >= 0
          || c.IndexOf("Chrome_RenderWidgetHostHWND", StringComparison.OrdinalIgnoreCase) >= 0
          || c.IndexOf("Chrome_WidgetWin", StringComparison.OrdinalIgnoreCase) >= 0) {
        OrStyle(h, WS_CLIPSIBLINGS);
      }
      return true;
    }, IntPtr.Zero);
  }

  // Qualquer janela top-level do processo MPV (não só class "mpv")
  public static IntPtr FindMpvByPid(uint pid) {
    IntPtr found = IntPtr.Zero;
    // 1) class mpv
    IntPtr cur = IntPtr.Zero;
    for (int i = 0; i < 128; i++) {
      cur = FindWindowExW(IntPtr.Zero, cur, "mpv", null);
      if (cur == IntPtr.Zero) break;
      uint wpid;
      GetWindowThreadProcessId(cur, out wpid);
      if (wpid == pid) return cur;
    }
    // 2) EnumWindows — qualquer janela do PID
    EnumWindows((h, _) => {
      uint wpid;
      GetWindowThreadProcessId(h, out wpid);
      if (wpid != pid) return true;
      var cls = new StringBuilder(256);
      GetClassNameW(h, cls, 256);
      string c = cls.ToString();
      // ignora console / IME
      if (c.IndexOf("Console", StringComparison.OrdinalIgnoreCase) >= 0) return true;
      if (c.IndexOf("IME", StringComparison.OrdinalIgnoreCase) >= 0) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  public static void MakeChild(IntPtr hwnd, IntPtr parent) {
    long style = GetWindowLongPtr(hwnd, GWL_STYLE).ToInt64();
    style = (style | WS_CHILD | WS_CLIPSIBLINGS | WS_VISIBLE) & ~WS_POPUP & ~WS_CAPTION & ~WS_THICKFRAME & ~WS_SYSMENU;
    SetWindowLongPtr(hwnd, GWL_STYLE, new IntPtr(style));
    long ex = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
    ex = (ex & ~WS_EX_TOPMOST & ~WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW;
    SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(ex));
    SetParent(hwnd, parent);
    SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  }

  public static void Raise(IntPtr host) {
    if (!IsWindow(host)) return;
    SetWindowPos(host, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }
}
"@

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.ShowInTaskbar = $false
$form.Opacity = 0
$form.Size = New-Object System.Drawing.Size 1, 1
$form.Location = New-Object System.Drawing.Point -32000, -32000
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual

$script:parentHwnd = [IntPtr]::Zero
$script:videoHwnd = [IntPtr]::Zero
$queue = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
$reader = New-Object System.Threading.Thread ([System.Threading.ThreadStart]{
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    [void]$queue.Enqueue($line)
  }
})
$reader.IsBackground = $true
$reader.Start()

function Reply($text) {
  [Console]::Out.WriteLine($text)
  [Console]::Out.Flush()
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 10
$timer.Add_Tick({
  $line = $null
  while ($queue.TryDequeue([ref]$line)) {
    $parts = $line.Trim().Split(' ')
    $op = $parts[0]
    try {
      if ($op -eq 'quit') {
        $timer.Stop()
        if ($script:videoHwnd -ne [IntPtr]::Zero -and [NativeHost]::IsWindow($script:videoHwnd)) {
          try { [void][NativeHost]::SetParent($script:videoHwnd, [IntPtr]::Zero) } catch {}
        }
        [System.Windows.Forms.Application]::Exit()
        Reply 'ok'
      }
      elseif ($op -eq 'prepareparent') {
        $parent = [IntPtr][int64]$parts[1]
        if (-not [NativeHost]::IsWindow($parent)) { Reply 'err'; continue }
        $script:parentHwnd = $parent
        [NativeHost]::PrepareElectronParent($parent)
        Reply 'ok'
      }
      elseif ($op -eq 'childraise') {
        $hwnd = [IntPtr][int64]$parts[1]
        if (-not [NativeHost]::IsWindow($hwnd)) { Reply 'err'; continue }
        if ($script:parentHwnd -ne [IntPtr]::Zero) {
          [NativeHost]::PrepareElectronParent($script:parentHwnd)
        }
        [NativeHost]::Raise($hwnd)
        Reply 'ok'
      }
      elseif ($op -eq 'adopt') {
        $parent = [IntPtr][int64]$parts[1]
        $pid = [uint32]$parts[2]
        if (-not [NativeHost]::IsWindow($parent)) { Reply '0'; continue }
        $script:parentHwnd = $parent
        [NativeHost]::PrepareElectronParent($parent)
        $hwnd = [NativeHost]::FindMpvByPid($pid)
        if ($hwnd -eq [IntPtr]::Zero) { Reply '0'; continue }
        [NativeHost]::MakeChild($hwnd, $parent)
        [void][NativeHost]::ShowWindow($hwnd, 0)
        [void][NativeHost]::MoveWindow($hwnd, -32000, -32000, 16, 16, $false)
        $script:videoHwnd = $hwnd
        Reply $hwnd.ToInt64().ToString()
      }
      elseif ($op -eq 'place') {
        if ($script:videoHwnd -eq [IntPtr]::Zero -or -not [NativeHost]::IsWindow($script:videoHwnd)) {
          Reply 'err'; continue
        }
        if ($script:parentHwnd -ne [IntPtr]::Zero) {
          [NativeHost]::PrepareElectronParent($script:parentHwnd)
        }
        $x = [int]$parts[1]; $y = [int]$parts[2]; $w = [int]$parts[3]; $h = [int]$parts[4]
        [void][NativeHost]::MoveWindow($script:videoHwnd, $x, $y, [Math]::Max(16,$w), [Math]::Max(16,$h), $true)
        [void][NativeHost]::ShowWindow($script:videoHwnd, 5)
        [NativeHost]::Raise($script:videoHwnd)
        Reply 'ok'
      }
      elseif ($op -eq 'raise') {
        if ($script:videoHwnd -ne [IntPtr]::Zero -and [NativeHost]::IsWindow($script:videoHwnd)) {
          [NativeHost]::Raise($script:videoHwnd)
        }
        Reply 'ok'
      }
      elseif ($op -eq 'hide') {
        if ($script:videoHwnd -ne [IntPtr]::Zero -and [NativeHost]::IsWindow($script:videoHwnd)) {
          [void][NativeHost]::ShowWindow($script:videoHwnd, 0)
          [void][NativeHost]::MoveWindow($script:videoHwnd, -32000, -32000, 16, 16, $false)
        }
        Reply 'ok'
      }
      elseif ($op -eq 'release') {
        if ($script:videoHwnd -ne [IntPtr]::Zero -and [NativeHost]::IsWindow($script:videoHwnd)) {
          try { [void][NativeHost]::SetParent($script:videoHwnd, [IntPtr]::Zero) } catch {}
          [void][NativeHost]::ShowWindow($script:videoHwnd, 0)
        }
        $script:videoHwnd = [IntPtr]::Zero
        Reply 'ok'
      }
      else { Reply 'err' }
    } catch {
      Reply 'err'
    }
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
