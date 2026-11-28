# Windows installation

Mini Node Goblin has a **per-user Windows x64 Setup.exe**. It bundles Node.js 24 and a graphical setup/tray manager. You do not need to install Node, paste commands, change PowerShell execution policy, or leave a terminal open. This is the standalone execution host, not the separate Burrow desktop chat application.

## Install and pair

1. Download **`node-goblin-VERSION-windows-x64-setup.exe`** from the selected [Node Goblin Development release](https://github.com/NightShaman/Node-Goblin/releases). Choose the Setup.exe, not the Linux `.tar.gz`. The checksum sidecar is published alongside it. The installer is currently **unsigned**; Windows may display an unknown-publisher or SmartScreen warning. Download only from the intended release; a checksum is not a publisher signature.
2. Run Setup normally as the Windows account that will use Node Goblin—not **Run as administrator**. Finish the wizard and launch **Node Goblin**. Setup adds a Start Menu entry and Windows Installed Apps entry; the desktop shortcut is optional.
3. In the setup window, enter the **Node Goblin controller listener address** (`host:port` or `tls://host:port`). This comes from **Node Goblin → Controller & TLS** in Burrow. It is **not** the Burrow website/reverse-proxy URL. The controller must already be enabled and reachable; its default TLS port is 7443. Leave the proposed computer name or choose a unique stable Gateway ID.
4. Read the PC-access explanation, tick the consent box, and choose **Save consent and start**.
5. In Burrow's **Pending pairings**, find the same Gateway ID. Compare its **current** code with the code in the Windows window. If they match, tick **This code matches the current code in Burrow**, choose **Confirm pairing on this computer**, and approve the intended request in Burrow. Reconnecting may replace the code; never approve an unexpected request.
6. Wait for **Connected and authenticated with Burrow**. In Burrow, assign the intended agent to this approved gateway and choose an absolute Windows workspace path. Assignments apply to subsequent turns. Verify a harmless command or file read on a new turn.

Pairing grants shell and filesystem access **as this signed-in Windows account**. A workspace is a working location, not a sandbox. Setup does not elevate this account or change Core authentication.

## Background operation and sign-in

Closing the window leaves Node Goblin in the notification area. Reopen it from the tray or Start Menu. **Stop gateway** stops the connection and its owned work; **Exit Node Goblin** exits the manager as well. Connection and authentication are shown separately, with useful sanitized failure codes rather than an assumed success state.

**Start Node Goblin on Windows sign-in** is an explicit choice. It starts the background manager and saved, consented connection after this user signs in. Installation alone does not start a connection or opt into sign-in startup. The setting never grants consent for a different controller/Gateway ID.

This is **logged-in user-session background operation**, not a machine-wide Windows service. It does not promise availability before sign-in or after sign-out. There is no service in Session 0 claiming access to the interactive desktop.

## Optional desktop access

Desktop access is **off** on every manager start and after a controller disconnect. While authenticated, choose **Enable desktop for this connection** locally to opt in. The existing separate desktop helper shows a visible **Stop Node Goblin desktop access** control. Closing that helper or pressing its Stop revokes desktop access while ordinary shell/files access can continue.

The manager also offers **Stop desktop access** and reports readiness/revocation. A locked, disconnected, elevated, or secure Windows desktop is not a blanket supported control target. Unlocking does not silently re-enable access. The helper reports actual Windows accessibility failures; it does not claim to distinguish every UAC/lock-screen cause.

Grant the intended agent **Mod: Node Goblin → node_goblin_desktop** in Burrow. Existing desktop actions cover status, a primary-display JPEG screenshot, eligible window enumeration, UI Automation inspection and invocation of supported controls. A screenshot may contain anything visible on the primary display; it is returned using Burrow's existing attachment route, not saved as a screenshot on the host or in its operation journal. An interrupted invoke is not replayable: inspect before retrying. This is not a live remote-desktop viewer or a promise to automate arbitrary/elevated applications.

Local desktop controls govern the desktop tool; they are not a command-denylist for separately authorized shell access as the same account.

## Update and uninstall

Drain active work, then run the newer **Setup.exe** normally. Setup asks the owning manager to stop, checks that installed executables are no longer in use, and replaces its application files. It refuses an unrelated process still using the bundled Node instead of silently killing it. Reopen Node Goblin from Start Menu after updating. Desktop consent is not carried across a restart.

Remove **Node Goblin** through Windows **Installed Apps**. Uninstall stops its manager, removes its application/shortcuts and owned sign-in entry, and **preserves configuration, pairing identity and operation history** for reinstall. It is not a credential purge.

Locations under your account:

- `%LOCALAPPDATA%\NodeGoblin\app`: installed manager, bundled Node and gateway runtime.
- `%LOCALAPPDATA%\NodeGoblin\config`: connection settings and consent bound to those settings.
- `%LOCALAPPDATA%\NodeGoblin\state`: identity, controller trust and operation journal.

Treat configuration, state and their backups as sensitive. Existing unexpected ACL owners/identities or reparse points are reported rather than followed. These checks do not protect against the owning account, administrators, privileged concurrent changes, or an already-authorized process with equivalent rights.

## Existing foreground developer installs

The old PowerShell scripts remain for compatibility and development; they are **not the normal installation path**. Stop any old foreground `run` console before moving to Setup.exe. Setup uses a separate `app` directory and reuses existing protected `config`/`state`; existing pairing can be retained, but the GUI still requires explicit consent before it starts the connection. Old manually installed `runtime` files are not silently deleted.

## Verification boundary

The native installer acceptance job exercises the actual downloadable installer under a disposable standard Windows account: installation without Node on PATH, GUI configuration/current-code pairing, authenticated PowerShell/files, desktop opt-in and revocation, tray/singleton behavior, saved-trust sign-in-command restart, process cancellation/owned-child shutdown, update, uninstall, and data/ACL preservation. Installed payload hashes and version/source metadata are checked. These checks use Windows Server 2025's interactive desktop; they are not evidence of testing every Windows laptop, a literal machine reboot, UAC elevation, or arbitrary applications.

For development, build on Windows using `gateway/deploy/windows/installer/build.ps1`. The build machine needs Node 24 and Inno Setup 6.7.x; those are **build dependencies**, not end-user setup chores. The bundled Node archive is pinned by SHA-256 and its license is included. Linux packaging and the existing outbound pairing protocol are unchanged.
