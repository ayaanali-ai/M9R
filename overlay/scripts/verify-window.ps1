# O2 verification for the overlay window, using real Windows APIs. Launches the built overlay against a feed file, then checks:
#   topmost, does not activate (no focus stealing), no taskbar button, top-centre placement, a click on the pill opens and
#   closes the panel while the focused window stays focused, the area around the pill is not covered by the window
#   (hit-testing, so nothing outside the pill is ever clicked), sizes, and memory.
# It moves the mouse and clicks ON THE PILL only (near the top centre of the primary screen). It never clicks anywhere else.
#   powershell -NoProfile -File overlay/scripts/verify-window.ps1 -Exe <m9r-overlay.exe> -Feed <feed.json> [-Shot <png>]
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Feed,
  [string]$Shot = ""
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public static IntPtr FindForPid(int pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { int p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) { RECT r; GetWindowRect(h, out r); if (r.Right - r.Left > 50) { found = h; return false; } } return true; }, IntPtr.Zero);
    return found;
  }
  /// The top-level window that owns whatever is drawn at this screen point.
  public static IntPtr OwnerAt(int x, int y) { POINT p; p.X = x; p.Y = y; IntPtr h = WindowFromPoint(p); return h == IntPtr.Zero ? IntPtr.Zero : GetAncestor(h, 2); }
}
"@
[void][W]::SetProcessDPIAware()
$results = @()
function Check($name, $ok, $detail) { $script:results += [pscustomobject]@{ ok = [bool]$ok; name = $name; detail = "$detail" }; "{0}  {1}  -- {2}" -f ($(if ($ok) { "PASS" } else { "FAIL" }), $name, $detail) }
function Rect($h) { $r = New-Object W+RECT; [void][W]::GetWindowRect($h, [ref]$r); $r }
function ClickOnPill($x, $y) { [void][W]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 150; [W]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60; [W]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 700 }
function Snap($r, $path) { $bmp = New-Object System.Drawing.Bitmap ($r.Right - $r.Left + 40), ($r.Bottom - $r.Top + 40); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.Left - 20, $r.Top - 20, 0, 0, $bmp.Size); $bmp.Save($path); $g.Dispose(); $bmp.Dispose() }
function TreeMemory($rootPid) {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $ids = New-Object System.Collections.Generic.HashSet[int]; [void]$ids.Add($rootPid)
  do { $n = $ids.Count; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } } } while ($ids.Count -gt $n)
  $ws = 0; $priv = 0; foreach ($id in $ids) { $pr = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($pr) { $ws += $pr.WorkingSet64; $priv += $pr.PrivateMemorySize64 } }
  [pscustomobject]@{ processes = $ids.Count; workingMB = [math]::Round($ws / 1MB, 1); privateMB = [math]::Round($priv / 1MB, 1) }
}

# One instance only: stale copies from an earlier run would make clicks toggle the wrong window.
Get-Process m9r-overlay -ErrorAction SilentlyContinue | ForEach-Object { $_.Kill() }
Start-Sleep -Milliseconds 500
$env:M9R_FEED = $Feed
$app = Start-Process -FilePath $Exe -PassThru
try {
  $hwnd = [IntPtr]::Zero
  for ($i = 0; $i -lt 60 -and $hwnd -eq [IntPtr]::Zero; $i++) { Start-Sleep -Milliseconds 250; $hwnd = [W]::FindForPid($app.Id) }
  Check "the pill window appears" ($hwnd -ne [IntPtr]::Zero) "hwnd=$hwnd"
  if ($hwnd -eq [IntPtr]::Zero) { throw "no window" }
  Start-Sleep -Seconds 4   # let the page load and draw

  $ex = [W]::GetWindowLong($hwnd, -20)
  Check "always on top (WS_EX_TOPMOST)" (($ex -band 0x8) -ne 0) ("exstyle=0x{0:X}" -f $ex)
  Check "does not activate when clicked (WS_EX_NOACTIVATE)" (($ex -band 0x08000000) -ne 0) ("exstyle=0x{0:X}" -f $ex)
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $tray = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, "Shell_TrayWnd")))
  $buttons = @(); if ($tray) { $buttons = @($tray.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button))) | ForEach-Object { $_.Current.Name }) }
  $mine = @($buttons | Where-Object { $_ -match "M9R" })
  Check "no taskbar button for the overlay" (($tray -ne $null) -and ($mine.Count -eq 0)) ("taskbar buttons seen: $($buttons.Count); matching M9R: $($mine.Count)")

  $r = Rect $hwnd; $sw = [W]::GetSystemMetrics(0)
  $cx = [int](($r.Left + $r.Right) / 2); $collapsedH = $r.Bottom - $r.Top; $collapsedW = $r.Right - $r.Left
  Check "top centre of the primary screen" (([math]::Abs($cx - $sw / 2) -le 4) -and ($r.Top -ge 0) -and ($r.Top -le 40)) ("centre x=$cx of $sw, top=$($r.Top), size ${collapsedW}x${collapsedH}")
  Check "the collapsed window is only as big as the pill (nothing invisible around it)" ($collapsedW -le 300 -and $collapsedH -le 60) "${collapsedW}x${collapsedH} physical px"

  # Hit-testing: the pill's own point belongs to the pill; points just outside it belong to some other window.
  Check "a point on the pill belongs to the pill window" ([W]::OwnerAt($cx, $r.Top + 18) -eq $hwnd) "owner=$([W]::OwnerAt($cx, $r.Top + 18)) pill=$hwnd"
  $below = [W]::OwnerAt($cx, $r.Bottom + 40); $left = [W]::OwnerAt($r.Left - 40, $r.Top + 18); $right = [W]::OwnerAt($r.Right + 40, $r.Top + 18)
  Check "the area around the pill is not covered by it (clicks there reach the app underneath)" (($below -ne $hwnd) -and ($left -ne $hwnd) -and ($right -ne $hwnd)) "below=$below left=$left right=$right pill=$hwnd"

  # Click the pill while some other window has the focus; that window must keep it.
  $fg = [W]::GetForegroundWindow()
  Check "test setup: another window has the focus" (($fg -ne $hwnd) -and ($fg -ne [IntPtr]::Zero)) "foreground=$fg"
  ClickOnPill $cx ($r.Top + 18)
  $r2 = Rect $hwnd
  Check "clicking the pill does NOT take focus from the window you were in" ([W]::GetForegroundWindow() -eq $fg) "foreground before=$fg after=$([W]::GetForegroundWindow())"
  Check "the click reached the pill: the panel opened" (($r2.Bottom - $r2.Top) -gt $collapsedH + 60) "height $collapsedH -> $($r2.Bottom - $r2.Top)"
  Check "the open panel is wider than the pill and stays centred" ((($r2.Right - $r2.Left) -ge 330) -and ([math]::Abs((($r2.Left + $r2.Right) / 2) - $cx) -le 4) -and ($r2.Top -eq $r.Top)) "width $($r2.Right - $r2.Left), centre $([int](($r2.Left + $r2.Right) / 2)), top $($r2.Top)"
  if ($Shot) { Snap $r2 $Shot.Replace(".png", "-open.png") }
  $mem = TreeMemory $app.Id
  $own = [math]::Round((Get-Process -Id $app.Id).WorkingSet64 / 1MB, 1)
  Check "memory: the overlay process itself is under 30 MB" ($own -lt 30) "$own MB. Whole tree with WebView2: $($mem.processes) processes, working set $($mem.workingMB) MB (shared pages counted once per process), private $($mem.privateMB) MB"

  ClickOnPill $cx ($r.Top + 18)
  $r3 = Rect $hwnd
  Check "clicking the pill again folds the panel away and the window shrinks back" ((($r3.Bottom - $r3.Top) -le $collapsedH + 4) -and (([W]::GetForegroundWindow()) -eq $fg)) "height back to $($r3.Bottom - $r3.Top), focus still with $fg"
  if ($Shot) { Snap $r3 $Shot.Replace(".png", "-closed.png") }
} finally {
  if ($app -and -not $app.HasExited) { $app.Kill() }
}
$failed = @($results | Where-Object { -not $_.ok }).Count
"{0} of {1} checks passed" -f (@($results | Where-Object { $_.ok }).Count), $results.Count
exit $(if ($failed -eq 0) { 0 } else { 1 })
