# Windows host development

This is a Windows execution-host candidate, not the supported Linux installer and not the Burrow desktop app. Run on an owned test Windows system with Node.js 24 and PowerShell 5.1. Start it explicitly as the test user, not Administrator. No service, startup task, or inbound listener is installed.

## Per-user installation, update and removal

This first packaging slice installs code for the existing foreground candidate. Use Windows PowerShell 5.1 (`powershell.exe`) as the non-elevated account that will run it. Install Node.js **24.x** separately and make `node.exe` available on PATH; install/update check that version and never install dependencies. Use a trusted source checkout or unpacked release **gateway folder**, outside `%LOCALAPPDATA%\NodeGoblin`. No secrets or state should be bundled in that folder.

From the repository root (or adjust the script path to your release folder):

```powershell
.\gateway\deploy\windows\install.ps1 -Source (Resolve-Path .\gateway).Path
$launcher = Join-Path $env:LOCALAPPDATA 'NodeGoblin\runtime\deploy\windows\node-goblin.ps1'
& $launcher configure
& $launcher run
```

The installed launcher's absolute path is **`%LOCALAPPDATA%\NodeGoblin\runtime\deploy\windows\node-goblin.ps1`** (expand `%LOCALAPPDATA%` for the current account). It is also printed by the installer. No PATH change, elevation, service, startup task, listener or automatic desktop opt-in is added. `run` uses the same paired outbound gateway. In a second console, invoke this installed script with `pairing-code` and `confirm-pairing CODE`; compare the active code with the existing controller before approval. Ctrl+C stops the foreground gateway. Pairing allows the existing controller to run commands and read or write files as that Windows user. A workspace is not a sandbox.

Stop the foreground gateway locally and drain its work before updating. Run the update script **from the new source/release**, outside the installation:

```powershell
.\gateway\deploy\windows\update.ps1 -Source (Resolve-Path .\gateway).Path
# Start explicitly when ready:
& $launcher run
# Later, stop it locally before removing code:
& (Join-Path $env:LOCALAPPDATA 'NodeGoblin\runtime\deploy\windows\uninstall.ps1')
```

Updates validate and stage an explicit runtime file inventory, then rename it into the fixed `runtime` directory. They refuse a detected Node process referencing that runtime and never kill it. Process inspection failure for a current-user Node process also refuses packaging; unrelated processes owned by other accounts do not block a per-user installation. Keep other consoles from launching the gateway during packaging: the packaging mutex serializes installers, but the existing foreground launcher does not participate in it. Replacement failure attempts to restore the prior runtime. A crash/power loss, rollback failure or cleanup failure can leave an explicitly named `.stage-*` or `.backup-*` directory; preserve it for inspection and recovery rather than recursively deleting the NodeGoblin directory.

Config remains in `%LOCALAPPDATA%\NodeGoblin\config`; identity, trust and journal remain in `state`. Update and uninstall preserve these files and their ACLs. Uninstall removes only the inventoried runtime, retains the parent directory and all other data, and refuses unexpected runtime files/directories rather than deleting them. There is no purge option. Reinstall can reuse the preserved pairing. Packaging copies only runtime modules, metadata and Windows deployment scripts; it does not copy tests, arbitrary source subdirectories or bundled configuration. Reparse points in selected paths and destination ancestors are refused, and neither nesting direction between source and installation is allowed.

The runtime inherits the same current-user/SYSTEM/Administrators ACL policy as the launcher. Unexpected owners or ACL identities in existing code, config or state are refused. This is a Windows host-OS boundary, not protection against the owning account, Administrators, concurrent privileged filesystem changes or arbitrary commands already authorized as that account. No additional workspace/runtime restrictions are imposed. This packaging slice does not establish blanket Windows control, service support or interactive desktop availability.

Verification: `node --test gateway/test/windows-packaging.test.mjs` runs static contract checks on Linux and native filesystem/ACL/process/transaction cases on a non-elevated Windows host with Node 24 and PowerShell 5.1. Skipped native cases or mocked PowerShell results are not Windows proof.

The gateway protocol accepts `commandShell: powershell` or `commandShell: cmd` with a command on Windows. Omitted shell selection still uses the platform default. Windows CI tests the command/file path through the actual pairing transport, and tests a Windows process-tree cancellation fixture. No approval for elevated control, startup or logging configuration is implied by this candidate. Shell/file success does not establish access to an interactive desktop.


## Opt in to the desktop slice

Run this **from the logged-in, non-elevated Windows account** owning the test application:

```powershell
& $launcher run -EnableDesktop
```

The opt-in applies only to this foreground launch. The helper displays a **Stop Node Goblin desktop access** button when the input desktop is available. Clicking Stop, closing that window, or losing the authenticated controller connection revokes desktop access without stopping ordinary shell/files access. Restart locally with `-EnableDesktop` to opt in again. Session 0, elevated processes, disconnected desktop sessions, and a locked or secure input desktop do not qualify. The tool reports `desktop_input_unavailable` when Windows does not expose an accessible default input desktop; it does not claim to know which of lock, UAC, or another desktop caused that denial.

Grant the agent `Mod: Node Goblin` → `node_goblin_desktop` in Burrow. Send the exact approved gateway ID as `targetId`. Actions: `status`, `screenshot` (primary display), `windows` (same-user, non-elevated main windows), `inspect` (use `windowId`), and `invoke` (use the exact `windowId` and `controlId` from inspection). The screenshot captures the visible primary desktop in JPEG and is returned through Burrow’s usual MCP attachment path. It can contain anything visible there. No screenshot is saved on the gateway or added to its operation journal. A lost invoke is **not replayable**; inspect the application before trying again.

The desktop grant and local switch control the desktop tool, not what a separately authorized command can do as that Windows account. This slice does not install a service, automate arbitrary apps or elevated dialogs, or provide a live viewer. It reuses the existing paired outbound connection.

The desktop helper reports `desktop_starting` while Windows loads its assemblies and compiles its native interop. Status is immediate and desktop actions are rejected (not queued) until initialization completes. Startup has a separate 30-second deadline; ordinary actions retain their five-second helper deadline. Readiness alone does not grant access: every action still checks the active standard-user desktop and visible local Stop indicator. A startup timeout or transport loss ends this launch’s consent; retrying an action does not restart the helper.
