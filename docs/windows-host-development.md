# Windows host development

This is a Windows execution-host candidate, not the supported Linux installer and not the Burrow desktop app. Run on an owned test Windows system with Node.js 24 and PowerShell 5.1. Start it explicitly as the test user, not Administrator. No service, startup task, or inbound listener is installed.

```powershell
.\gateway\deploy\windows\node-goblin.ps1 configure
.\gateway\deploy\windows\node-goblin.ps1 run
```

In a second console, use `pairing-code` and `confirm-pairing CODE` with the same script; compare the active code with the existing controller before approval. Ctrl+C stops the foreground gateway. Configuration, identity and the journal are stored under the current user's `%LOCALAPPDATA%\NodeGoblin`. Pairing allows the existing controller to run commands and read or write files as that Windows user. A workspace is not a sandbox.

The gateway protocol accepts `commandShell: powershell` or `commandShell: cmd` with a command on Windows. Omitted shell selection still uses the platform default. Windows CI tests the command/file path through the actual pairing transport, and tests a Windows process-tree cancellation fixture. No approval for elevated control, startup or logging configuration is implied by this candidate. Shell/file success does not establish access to an interactive desktop.


## Opt in to the desktop slice

Run this **from the logged-in, non-elevated Windows account** owning the test application:

```powershell
.\gateway\deploy\windows\node-goblin.ps1 run -EnableDesktop
```

The opt-in applies only to this foreground launch. The helper displays a **Stop Node Goblin desktop access** button when the input desktop is available. Clicking Stop, closing that window, or losing the authenticated controller connection revokes desktop access without stopping ordinary shell/files access. Restart locally with `-EnableDesktop` to opt in again. Session 0, elevated processes, disconnected desktop sessions, and a locked or secure input desktop do not qualify. The tool reports `desktop_input_unavailable` when Windows does not expose an accessible default input desktop; it does not claim to know which of lock, UAC, or another desktop caused that denial.

Grant the agent `Mod: Node Goblin` → `node_goblin_desktop` in Burrow. Send the exact approved gateway ID as `targetId`. Actions: `status`, `screenshot` (primary display), `windows` (same-user, non-elevated main windows), `inspect` (use `windowId`), and `invoke` (use the exact `windowId` and `controlId` from inspection). The screenshot captures the visible primary desktop in JPEG and is returned through Burrow’s usual MCP attachment path. It can contain anything visible there. No screenshot is saved on the gateway or added to its operation journal. A lost invoke is **not replayable**; inspect the application before trying again.

The desktop grant and local switch control the desktop tool, not what a separately authorized command can do as that Windows account. This slice does not install a service, automate arbitrary apps or elevated dialogs, or provide a live viewer. It reuses the existing paired outbound connection.
