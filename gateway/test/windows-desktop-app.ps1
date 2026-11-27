# Harmless same-user CI fixture, also used to exercise the local Stop control.
param([string]$Marker, [switch]$StopHelper)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes
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
$form = [Windows.Forms.Form]::new()
$form.Text = 'Node Goblin disposable application'
$form.StartPosition = 'CenterScreen'
$form.ClientSize = [Drawing.Size]::new(300,200)
$form.TopMost = $true
$button = [Windows.Forms.Button]::new()
$button.Text = 'Write harmless proof'
$button.Dock = 'Fill'
$button.Add_Click({ [IO.File]::WriteAllText($Marker, 'invoked in the Windows app') })
$form.Controls.Add($button)
try { [Windows.Forms.Application]::Run($form) }
finally { $form.Dispose() }
