# Harmless same-user CI fixture, also used to exercise the local Stop control.
param([string]$Marker, [string]$Ready, [switch]$StopHelper)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, UIAutomationClient, UIAutomationTypes
if ($StopHelper) {
  # Verify the actual visible HWND on the owned CI desktop before operating the
  # local button. UIA's global RootElement can omit windows on a borrowed session.
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FixtureStopWindow {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static IntPtr FindStop() { return FindWindow(null, "Node Goblin desktop access"); }
}
'@
  $hwnd = [FixtureStopWindow]::FindStop()
  if ($hwnd -eq [IntPtr]::Zero -or -not [FixtureStopWindow]::IsWindowVisible($hwnd)) { throw 'Visible local stop HWND not found' }
  $window = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if (-not $window) { throw 'Local stop HWND is not accessible through UIA' }
  $label = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'Stop Node Goblin desktop access')
  $button = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $label)
  if (-not $button) { throw 'Local stop button not found' }
  $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
  return
}
# WPF supplies a public ButtonAutomationPeer with InvokePattern on .NET Framework.
# Do not treat the older WinForms/MSAA bridge as a portable UIA provider.
$window = [Windows.Window]::new()
$window.Title = 'Node Goblin disposable application'
$window.WindowStartupLocation = 'CenterScreen'
$window.Width = 300
$window.Height = 200
$window.Topmost = $true
$button = [Windows.Controls.Button]::new()
$button.Content = 'Write harmless proof'
[Windows.Automation.AutomationProperties]::SetName($button, 'Write harmless proof')
$button.Add_Click({ [IO.File]::WriteAllText($Marker, 'invoked in the Windows app') })
$window.Content = $button
$window.Add_ContentRendered({
  $hwnd = [Windows.Interop.WindowInteropHelper]::new($window).Handle
  [IO.File]::WriteAllText($Ready, ('{0}:{1}' -f $PID, $hwnd.ToInt64()))
})
[void]$window.ShowDialog()
