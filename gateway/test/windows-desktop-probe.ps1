# Owned CI fixture only: paint and sample a disposable window, never save a screenshot.
param([Parameter(Mandatory=$true)][string]$ResultPath, [switch]$ExerciseGateway)
$ErrorActionPreference = 'Stop'
$state = 'probe_error'
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
[Environment]::CurrentDirectory = $PSScriptRoot
Set-Location -LiteralPath $PSScriptRoot
$env:TEMP = $PSScriptRoot; $env:TMP = $PSScriptRoot
$stage = 'load'
$problem = $null
try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DesktopProbe {
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint bytes, out uint needed);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int cls, out int result, int bytes, out int needed);
  [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int cls, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
  public static bool IsElevated(IntPtr token) {
    int elevated, bytes;
    if (!GetTokenInformation(token, 20, out elevated, 4, out bytes)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return elevated != 0;
  }
  public static bool Active(int session) {
    IntPtr buffer; int bytes;
    if (!WTSQuerySessionInformation(IntPtr.Zero, session, 8, out buffer, out bytes)) return false;
    try { return bytes >= 4 && Marshal.ReadInt32(buffer) == 0; }
    finally { WTSFreeMemory(buffer); }
  }
  public static bool DefaultInputDesktop() {
    IntPtr h = OpenInputDesktop(0, false, 1);
    if (h == IntPtr.Zero) return false;
    try { uint bytes; var name = new StringBuilder(128); return GetUserObjectInformation(h, 2, name, 256, out bytes) && name.ToString() == "Default"; }
    finally { CloseDesktop(h); }
  }
}
'@
  $stage = 'session'
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($session -eq 0) { $state = 'session_0' }
  elseif ([DesktopProbe]::IsElevated($identity.Token)) { $state = 'elevated' }
  elseif (-not [DesktopProbe]::Active($session)) { $state = 'session_not_active' }
  elseif (-not [DesktopProbe]::DefaultInputDesktop()) { $state = 'input_desktop_unavailable' }
  else {
    $stage = 'surface'
    $form = New-Object Windows.Forms.Form
    $bitmap = New-Object Drawing.Bitmap(1, 1)
    $g = [Drawing.Graphics]::FromImage($bitmap)
    try {
      $form.Text = 'Node Goblin disposable desktop fixture'
      $form.StartPosition = 'CenterScreen'
      $form.TopMost = $true
      $form.BackColor = [Drawing.Color]::FromArgb(2, 209, 197)
      $form.Show()
      $form.Refresh()
      [Windows.Forms.Application]::DoEvents()
      $point = $form.PointToScreen([Drawing.Point]::new(20,20))
      $g.CopyFromScreen($point, [Drawing.Point]::Empty, [Drawing.Size]::new(1,1))
      if ($bitmap.GetPixel(0,0).ToArgb() -ne $form.BackColor.ToArgb()) { $state = 'fixture_pixel_not_visible' }
      else { $state = 'interactive_non_elevated_capture_verified' }
    } finally { $g.Dispose(); $bitmap.Dispose(); $form.Dispose() }
  }
} catch { $problem = "$($_.Exception.GetType().Name): $($_.Exception.Message)" }
[IO.File]::WriteAllText($ResultPath, (@{ state=$state; session=$session; stage=$stage; error=$problem } | ConvertTo-Json -Compress))

if ($ExerciseGateway) {
  if ($state -ne 'interactive_non_elevated_capture_verified') { throw "Standard-user desktop prerequisite failed ($state at $stage): $problem" }
  $env:NODE_GOBLIN_DESKTOP_E2E = '1'
  $env:Path = "$PSScriptRoot;${env:ProgramFiles}\Git\usr\bin;$env:Path"
  $env:NODE_GOBLIN_INSTALLED_E2E = '1'
  & (Join-Path $PSScriptRoot 'node.exe') --test --test-reporter=tap gateway/test/windows-packaging.test.mjs *> (Join-Path $PSScriptRoot 'packaging-e2e.log')
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & (Join-Path $PSScriptRoot 'node.exe') --test --test-reporter=tap gateway/test/windows-launcher.test.mjs *> (Join-Path $PSScriptRoot 'desktop-e2e.log')
  exit $LASTEXITCODE
}
