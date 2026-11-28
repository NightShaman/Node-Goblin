# Same-session test driver. Each stdin JSON line produces one stdout JSON line.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, Accessibility, System.Windows.Forms, System.Drawing
Add-Type -ReferencedAssemblies ([Accessibility.IAccessible].Assembly.Location) @'
using System;
using System.Runtime.InteropServices;
using Accessibility;

public static class ManagerTestWindows {
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("oleacc.dll")]
    static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint objectId, ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);

    static IAccessible Client(IntPtr hwnd) {
        var iid = typeof(IAccessible).GUID;
        IAccessible accessible;
        Marshal.ThrowExceptionForHR(AccessibleObjectFromWindow(hwnd, 0xfffffffc, ref iid, out accessible));
        return accessible;
    }

    public static string Read(IntPtr hwnd) { return Client(hwnd).get_accValue(0); }
    public static void Write(IntPtr hwnd, string value) { Client(hwnd).set_accValue(0, value); }
    public static void Activate(IntPtr hwnd) { Client(hwnd).accDoDefaultAction(0); }
}
'@

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$session = [Diagnostics.Process]::GetCurrentProcess().SessionId
if ($session -eq 0 -or -not [Environment]::UserInteractive -or
    $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run the UI driver in an interactive, non-elevated user session.'
}

# Keep handles to the exact owned processes so PID reuse cannot satisfy an exit check.
$tracked = @{}
function Manager-Window($targetPid) {
    $process = Get-Process -Id $targetPid
    if ($process.SessionId -ne $session) { throw 'Manager is in a different session' }
    return $process.MainWindowHandle
}

function Test-FixtureCapture($request) {
    $handle = [IntPtr][long]$request.handle
    if (-not [ManagerTestWindows]::IsWindowVisible($handle)) { return $false }
    $element = [Windows.Automation.AutomationElement]::FromHandle($handle)
    if ($element.Current.ProcessId -ne $request.pid -or
        $element.Current.Name -cne 'Node Goblin disposable application') { return $false }
    $rectangle = $element.Current.BoundingRectangle
    $bounds = [Windows.Forms.Screen]::PrimaryScreen.Bounds
    # The helper resizes the primary display. Compare its JPEG against a live
    # reference in the fixture's region, allowing for lossy JPEG encoding.
    $left = [int][Math]::Ceiling($rectangle.Left) + 8
    $top = [int][Math]::Ceiling($rectangle.Top) + 8
    $right = [int][Math]::Floor($rectangle.Right) - 8
    $bottom = [int][Math]::Floor($rectangle.Bottom) - 8
    if ($left -lt $bounds.Left -or $top -lt $bounds.Top -or
        $right -ge $bounds.Right -or $bottom -ge $bounds.Bottom -or
        $right -le $left -or $bottom -le $top) { return $false }
    $stream = [IO.MemoryStream]::new([Convert]::FromBase64String($request.jpeg))
    try {
        $jpeg = [Drawing.Bitmap]::new($stream)
        try {
            $local = [Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
            try {
                $graphics = [Drawing.Graphics]::FromImage($local)
                try { $graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.Size) }
                finally { $graphics.Dispose() }
                $scaled = [Drawing.Bitmap]::new($local, $jpeg.Width, $jpeg.Height)
                try {
                    $matches = 0
                    for ($row = 0; $row -lt 9; $row++) {
                        $y = [int][Math]::Floor(($top - $bounds.Top + ($bottom - $top) * $row / 8) * $jpeg.Height / $bounds.Height)
                        for ($column = 0; $column -lt 9; $column++) {
                            $x = [int][Math]::Floor(($left - $bounds.Left + ($right - $left) * $column / 8) * $jpeg.Width / $bounds.Width)
                            $actual = $jpeg.GetPixel($x, $y)
                            $expected = $scaled.GetPixel($x, $y)
                            if ([Math]::Abs([int]$actual.R - [int]$expected.R) -le 32 -and
                                [Math]::Abs([int]$actual.G - [int]$expected.G) -le 32 -and
                                [Math]::Abs([int]$actual.B - [int]$expected.B) -le 32) { $matches++ }
                        }
                    }
                    return ($matches -ge 73)
                } finally { $scaled.Dispose() }
            } finally { $local.Dispose() }
        } finally { $jpeg.Dispose() }
    } finally { $stream.Dispose() }
}

function Run-Request($request) {
    switch ($request.action) {
        'ready' { return $true }
        'compareCapture' { return (Test-FixtureCapture $request) }
        'registry' { return (Get-ItemPropertyValue -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name NodeGoblin) }
        'track' {
            $process = Get-Process -Id $request.pid
            if ($process.SessionId -ne $session -or $process.MainModule.FileName -ine $request.exe) {
                throw 'Unexpected owned process'
            }
            $null = $process.Handle
            $tracked[$request.pid] = $process
            return $true
        }
        'exited' { return $tracked[$request.pid].HasExited }
        'terminate' {
            $process = $tracked[$request.pid]
            if (-not $process.HasExited) { $process.Kill(); $null = $process.WaitForExit(5000) }
            return $process.HasExited
        }
        'window' { return (Manager-Window $request.pid).ToInt64() }
    }

    $hwnd = Manager-Window $request.pid
    if (-not $hwnd -or -not [ManagerTestWindows]::IsWindowVisible($hwnd)) { throw 'Manager window is hidden' }
    $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($root.Current.Name -cne 'Node Goblin') { throw 'Unexpected manager window' }
    if ($request.action -eq 'close') {
        $root.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).Close()
        return $true
    }

    $name = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $request.name)
    $item = $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $name)
    if (-not $item) {
        if ($request.action -eq 'exists') { return $false }
        throw 'Manager control was not found'
    }
    if ($request.action -eq 'exists') { return $true }
    if ($request.action -eq 'enabled') { return $item.Current.IsEnabled }
    if ($request.action -ne 'read' -and -not $item.Current.IsEnabled) { throw 'Manager control is disabled' }

    # Older WinForms controls can surface through UIA without the corresponding
    # pattern. Use the native accessibility default action/value on those HWNDs.
    $pattern = $null
    switch ($request.action) {
        'read' {
            if ($item.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { return $pattern.Current.Value }
        }
        'set' {
            if ($item.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $pattern.SetValue($request.value); return $true }
        }
        'invoke' {
            if ($item.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); return $true }
        }
        'toggle' {
            if ($item.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $pattern.Toggle(); return $true }
        }
        default { throw 'Unknown UI action' }
    }
    $handle = [IntPtr]$item.Current.NativeWindowHandle
    if ($handle -eq [IntPtr]::Zero) { throw 'Accessibility fallback requires a native control handle' }
    switch ($request.action) {
        'read' { return [ManagerTestWindows]::Read($handle) }
        'set' { [ManagerTestWindows]::Write($handle, $request.value) }
        default { [ManagerTestWindows]::Activate($handle) }
    }
    return $true
}

while ($null -ne ($line = [Console]::ReadLine())) {
    try {
        $request = ConvertFrom-Json -InputObject $line
        $reply = @{ ok = $true; value = (Run-Request $request) }
    } catch {
        # Exception messages can contain the request or an accessibility value.
        $reply = @{ ok = $false; error = $_.Exception.GetType().Name; line = $_.InvocationInfo.ScriptLineNumber }
    }
    [Console]::WriteLine((ConvertTo-Json -InputObject $reply -Compress -Depth 4))
}
