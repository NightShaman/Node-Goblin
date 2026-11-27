# Harmless same-user CI fixture, also used to exercise the local Stop control.
param([string]$Marker, [string]$Ready, [switch]$StopHelper)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, UIAutomationClient, UIAutomationTypes
if ($StopHelper) {
  $title = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'Node Goblin desktop access')
  $window = [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children, $title)
  if (-not $window) { throw 'Local stop window not found' }
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
