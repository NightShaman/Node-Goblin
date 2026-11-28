# Run only as the foreground launcher's child, with private stdin/stdout.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
public static class NodeGoblinDesktop {
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr h, int index, StringBuilder value, uint bytes, out uint needed);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  delegate bool WindowCallback(IntPtr h, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint command);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder value, int capacity);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags);
  [DllImport("user32.dll")] static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int cls, out int result, int bytes, out int needed);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("wtsapi32.dll")] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int cls, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
  public static void SetupDpi() { SetProcessDPIAware(); }
  public static void ShowIndicator(IntPtr h) { SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x0057); } // show, preserve position/size/z-order and activation
  public static bool IsMainWindow(IntPtr h) { return IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero; } // no owner
  public static IntPtr[] MainWindows() {
    var windows = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((h, _) => { if (IsMainWindow(h)) windows.Add(h); return true; }, IntPtr.Zero);
    return windows.ToArray();
  }
  public static string Caption(IntPtr h) {
    var title = new StringBuilder(201);
    GetWindowText(h, title, title.Capacity);
    return title.ToString();
  }
  public static int Owner(IntPtr h) { int pid; return GetWindowThreadProcessId(h, out pid) == 0 ? 0 : pid; }
  static bool Standard(IntPtr token) {
    int value, bytes;
    return GetTokenInformation(token, 20, out value, sizeof(int), out bytes) && value == 0;
  }
  public static bool SameStandardUser(int pid) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) return false;
    try {
      IntPtr token;
      if (!OpenProcessToken(process, 8, out token)) return false;
      try {
        if (!Standard(token)) return false;
        using (var own = WindowsIdentity.GetCurrent())
        using (var target = new WindowsIdentity(token)) { return own.User.Equals(target.User); }
      } finally { CloseHandle(token); }
    } finally { CloseHandle(process); }
  }
  public static string State(int session) {
    if (session == 0) return "desktop_session_0";
    using (var own = WindowsIdentity.GetCurrent()) if (!Standard(own.Token)) return "desktop_elevated";
    IntPtr buffer; int bytes;
    if (!WTSQuerySessionInformation(IntPtr.Zero, session, 8, out buffer, out bytes)) return "desktop_session_inactive";
    try { if (bytes < 4 || Marshal.ReadInt32(buffer) != 0) return "desktop_session_inactive"; }
    finally { WTSFreeMemory(buffer); }
    IntPtr desktop = OpenInputDesktop(0, false, 1);
    if (desktop == IntPtr.Zero) return "desktop_input_unavailable";
    try {
      uint needed; var name = new StringBuilder(128);
      return GetUserObjectInformation(desktop, 2, name, 256, out needed) && name.ToString() == "Default"
        ? "available" : "desktop_input_unavailable";
    } finally { CloseDesktop(desktop); }
  }
  public static readonly ConcurrentQueue<string> Input = new ConcurrentQueue<string>();
  public static volatile bool Closed;
  public static void StartReader() {
    var reader = new Thread(() => {
      try { string line; while ((line = Console.ReadLine()) != null) Input.Enqueue(line); }
      catch (System.IO.IOException) { }
      finally { Closed = true; }
    });
    reader.IsBackground = true;
    reader.Start();
  }
}
'@
[NodeGoblinDesktop]::SetupDpi()
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
function Get-DesktopState { [NodeGoblinDesktop]::State($session) }
function Limit-Label([string]$value) { if ($value.Length -gt 200) { $value.Substring(0,200) } else { $value } }
function Get-AvailableDesktop {
  $state = Get-DesktopState
  if ($state -ne 'available') { return $state }
  $hwnd = [Windows.Interop.WindowInteropHelper]::new($window).Handle
  if (-not $window.IsVisible -or -not [NodeGoblinDesktop]::IsWindowVisible($hwnd) -or [NodeGoblinDesktop]::IsIconic($hwnd)) { return 'desktop_indicator_unavailable' }
  return 'available'
}
function Get-MainWindows {
  foreach ($h in [NodeGoblinDesktop]::MainWindows()) {
    $processId = [NodeGoblinDesktop]::Owner($h)
    if ($processId -le 0 -or $processId -eq $PID -or -not [NodeGoblinDesktop]::SameStandardUser($processId)) { continue }
    # Check the HWND/PID association again after opening and checking the process token.
    if ([NodeGoblinDesktop]::Owner($h) -ne $processId) { continue }
    @{ windowId=('{0}:{1}' -f $processId, $h.ToInt64()); title=[NodeGoblinDesktop]::Caption($h) }
  }
}
function Get-InvokableElements($request, [bool]$Invoke) {
  if ($request.windowId -notmatch '^(\d{1,10}):(\d{1,19})$') { throw 'desktop_arguments_invalid' }
  $owner = [int]$matches[1]; $hwnd = [IntPtr]::new([long]$matches[2])
  if ($owner -eq $PID -or [NodeGoblinDesktop]::Owner($hwnd) -ne $owner -or -not [NodeGoblinDesktop]::IsMainWindow($hwnd)) { throw 'desktop_window_unavailable' }
  if (-not [NodeGoblinDesktop]::SameStandardUser($owner)) { throw 'desktop_window_access_denied' }
  $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root -or $root.Current.ProcessId -ne $owner) { throw 'desktop_window_unavailable' }
  $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty, $true)
  $elements = $root.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
  $items = [Collections.Generic.List[object]]::new()
  for ($i = 0; $i -lt [Math]::Min(100, $elements.Count); $i++) {
    $item = $elements.Item($i)
    if ($item.Current.ProcessId -ne $owner) { continue }
    $id = $item.GetRuntimeId() -join ':'
    if ($Invoke -and $id -ceq $request.controlId) {
      if (-not $item.Current.IsEnabled) { throw 'desktop_control_unavailable' }
      $state = Get-AvailableDesktop; if ($state -ne 'available') { throw $state }
      $item.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
      return @{ invoked=$true }
    }
    if (-not $Invoke) { $items.Add(@{ controlId=$id; name=(Limit-Label $item.Current.Name); enabled=$item.Current.IsEnabled }) }
  }
  if ($Invoke) { throw 'desktop_control_unavailable' }
  @{ title=(Limit-Label $root.Current.Name); controls=$items.ToArray(); truncated=($elements.Count -gt 100) }
}
function Get-DesktopScreenshot {
  $bounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds
  if ($bounds.Width -lt 1 -or $bounds.Height -lt 1) { throw 'desktop_input_unavailable' }
  if ([long]$bounds.Width * $bounds.Height -gt 35000000) { throw 'desktop_screenshot_too_large' }
  $full = [Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
  $graphics = [Drawing.Graphics]::FromImage($full)
  try {
    $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size)
    $state = Get-AvailableDesktop; if ($state -ne 'available') { throw $state }
    $scale = [Math]::Min(1, 1280 / [double][Math]::Max($bounds.Width,$bounds.Height))
    $width = [Math]::Max(1, [int]($bounds.Width * $scale)); $height = [Math]::Max(1, [int]($bounds.Height * $scale))
    $image = [Drawing.Bitmap]::new($full, $width, $height)
    $buffer = [IO.MemoryStream]::new()
    try {
      $image.Save($buffer, [Drawing.Imaging.ImageFormat]::Jpeg)
      if ($buffer.Length -gt 1048576) { throw 'desktop_screenshot_too_large' }
      @{ mimeType='image/jpeg'; data=[Convert]::ToBase64String($buffer.ToArray()); width=$width; height=$height }
    } finally { $image.Dispose(); $buffer.Dispose() }
  } finally { $graphics.Dispose(); $full.Dispose() }
}
function Handle-Request($request) {
  $state = Get-AvailableDesktop
  if ($request.action -eq 'status') { return @{ available=($state -eq 'available'); state=$state; sessionId=$session } }
  if ($state -ne 'available') { throw $state }
  switch -CaseSensitive ($request.action) {
    'screenshot' { Get-DesktopScreenshot }
    'windows' { @{ windows=@(Get-MainWindows | Select-Object -First 80) } }
    'inspect' { Get-InvokableElements $request $false }
    'invoke' { Get-InvokableElements $request $true }
    default { throw 'desktop_arguments_invalid' }
  }
}
# Use a native WPF button so the visible local Stop is exposed to Windows assistive technology.
$window = [Windows.Window]::new()
$window.Title = 'Node Goblin desktop access'
$window.Width = 320
$window.Height = 88
$window.WindowStartupLocation = 'Manual'
$window.Left = 20
$window.Top = 20
$window.Topmost = $true
$window.ResizeMode = 'NoResize'
$window.ShowActivated = $false
$stop = [Windows.Controls.Button]::new()
$stop.Content = 'Stop Node Goblin desktop access'
[Windows.Automation.AutomationProperties]::SetName($stop, 'Stop Node Goblin desktop access')
$stop.Add_Click({ $window.Close() })
$window.Content = $stop
$dispatcher = [Windows.Threading.Dispatcher]::CurrentDispatcher
$window.Add_Closed({ $dispatcher.BeginInvokeShutdown([Windows.Threading.DispatcherPriority]::Send) })
$timer = [Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromMilliseconds(100)
$script:ReadySent = $false
$timer.Add_Tick({
  if ([NodeGoblinDesktop]::Closed) { $window.Close(); return }
  if (-not $window.IsVisible -and (Get-DesktopState) -eq 'available') {
    $window.Show()
    # A hidden subprocess startup flag can override the first ShowWindow call.
    [NodeGoblinDesktop]::ShowIndicator([Windows.Interop.WindowInteropHelper]::new($window).Handle)
  }
  # Initialization is complete and the dispatcher is processing requests. This
  # is readiness only; every action still checks the live session and indicator.
  if (-not $script:ReadySent) {
    [Console]::WriteLine('{"ready":true}')
    $script:ReadySent = $true
  }
  $line = $null
  if (-not [NodeGoblinDesktop]::Input.TryDequeue([ref]$line)) { return }
  $request = $null
  try { $request = ConvertFrom-Json -InputObject $line; $reply = Handle-Request $request }
  catch {
    $code = $_.Exception.Message
    if ($code -cmatch '^desktop_[a-z_]+$') { $reply = @{ error=$code } }
    else {
      $cause = $_.Exception.GetBaseException()
      [Console]::Error.WriteLine(('Node Goblin desktop {0} failed: {1} (0x{2:X8})' -f $request.action, $cause.GetType().Name, $cause.HResult))
      $reply = @{ error='desktop_action_failed' }
    }
  }
  [Console]::WriteLine((ConvertTo-Json -InputObject $reply -Depth 8 -Compress))
})
[NodeGoblinDesktop]::StartReader()
try { $timer.Start(); [Windows.Threading.Dispatcher]::Run() }
finally { $timer.Stop() }
