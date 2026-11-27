# Windows host development

This is a Windows execution-host candidate, not the supported Linux installer and not the Burrow desktop app. Run on an owned test Windows system with Node.js 24 and PowerShell 5.1. Start it explicitly as the test user, not Administrator. No service, startup task, or inbound listener is installed.

```powershell
.\gateway\deploy\windows\node-goblin.ps1 configure
.\gateway\deploy\windows\node-goblin.ps1 run
```

In a second console, use `pairing-code` and `confirm-pairing CODE` with the same script; compare the active code with the existing controller before approval. Ctrl+C stops the foreground gateway. Configuration, identity and the journal are stored under the current user's `%LOCALAPPDATA%\NodeGoblin`. Pairing allows the existing controller to run commands and read or write files as that Windows user. A workspace is not a sandbox.

The gateway protocol accepts `commandShell: powershell` or `commandShell: cmd` with a command on Windows. Omitted shell selection still uses the platform default. Windows CI tests the command/file path through the actual pairing transport, and tests a Windows process-tree cancellation fixture. No approval for elevated control, startup or logging configuration is implied by this candidate. Interactive desktop work and its real-guest acceptance are separate from shell/file validation; the Windows CI runner does not establish them.
