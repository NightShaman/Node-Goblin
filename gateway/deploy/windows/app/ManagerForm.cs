using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

namespace NodeGoblin
{
    internal sealed class ManagerForm : Form
    {
        readonly ManagerSettings store = new ManagerSettings(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        readonly TextBox controller = Named(new TextBox(), "ControllerUrl", "Controller URL");
        readonly TextBox gatewayId = Named(new TextBox(), "GatewayId", "Gateway ID");
        readonly CheckBox consent = Named(new CheckBox(), "AccessConsent", "I grant Burrow the access described above");
        readonly CheckBox signIn = Named(new CheckBox(), "StartOnSignIn", "Start Node Goblin on Windows sign-in");
        readonly Button start = Named(new Button(), "StartGateway", "Save consent and start");
        readonly Button stop = Named(new Button(), "StopGateway", "Stop gateway");
        readonly Label connectionStatus = Named(new Label(), "ConnectionStatus", "Connection status");
        readonly Label errorStatus = Named(new Label(), "GatewayError", "Gateway error");
        readonly TextBox pairingCode = Named(new TextBox(), "PairingCode", "Current pairing code");
        readonly CheckBox compared = Named(new CheckBox(), "PairingCompared", "This code matches the current code in Burrow");
        readonly Button confirm = Named(new Button(), "ConfirmPairing", "Confirm pairing on this computer");
        readonly Button desktopButton = Named(new Button(), "DesktopAccess", "Enable desktop for this connection");
        readonly Label desktopStatus = Named(new Label(), "DesktopStatus", "Desktop status");
        readonly NotifyIcon tray;
        readonly ToolStripMenuItem trayStart;
        readonly ToolStripMenuItem trayStop;
        readonly Timer timer = new Timer { Interval = 150 };
        OwnedGateway gateway;
        bool updatingSignIn;
        bool stopping;
        bool exitRequested;
        bool allowClose;
        bool desktopGranted;
        bool desktopSupported;
        bool desktopSessionUnavailable;
        int connection;
        string confirmedCode;
        bool fatalReported;

        static T Named<T>(T control, string id, string name) where T : Control
        {
            control.Name = id;
            control.AccessibleName = name;
            return control;
        }

        public ManagerForm(ManagerInstance instance)
        {
            Name = "NodeGoblinManager";
            AccessibleName = "Node Goblin";
            Text = "Node Goblin";
            Icon = SystemIcons.Application;
            Font = SystemFonts.MessageBoxFont;
            AutoScaleMode = AutoScaleMode.Font;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(620, 625);
            MinimumSize = new Size(480, 400);
            BuildLayout();

            var menu = new ContextMenuStrip();
            menu.Items.Add("Open Node Goblin", null, (s, e) => ShowManager());
            trayStart = (ToolStripMenuItem)menu.Items.Add("Start gateway", null, (s, e) => StartSaved());
            trayStop = (ToolStripMenuItem)menu.Items.Add("Stop gateway", null, (s, e) => StopGateway());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Exit Node Goblin", null, (s, e) => RequestExit());
            tray = new NotifyIcon { Icon = Icon, ContextMenuStrip = menu, Text = "Node Goblin" };
            tray.DoubleClick += (s, e) => ShowManager();

            consent.CheckedChanged += (s, e) => UpdateControls();
            controller.TextChanged += (s, e) => SettingsChanged();
            gatewayId.TextChanged += (s, e) => SettingsChanged();
            signIn.CheckedChanged += (s, e) => SaveSignIn();
            start.Click += (s, e) => StartFromForm();
            stop.Click += (s, e) => StopGateway();
            compared.CheckedChanged += (s, e) => UpdateControls();
            confirm.Click += (s, e) => ConfirmPairing();
            desktopButton.Click += (s, e) => ToggleDesktop();
            Resize += (s, e) => { if (WindowState == FormWindowState.Minimized) Hide(); };

            timer.Tick += (s, e) =>
            {
                if (instance.Shutdown.WaitOne(0)) RequestExit();
                if (!IsDisposed && instance.Open.WaitOne(0)) ShowManager();
            };
            SystemEvents.SessionSwitch += SessionSwitch;
        }

        void BuildLayout()
        {
            var panel = new TableLayoutPanel
            {
                Dock = DockStyle.Fill, AutoScroll = true, ColumnCount = 1, Padding = new Padding(16)
            };
            panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Controls.Add(panel);

            Add(panel, new Label { Text = "Connect Node Goblin to Burrow", Font = new Font(Font, FontStyle.Bold) });
            Add(panel, Caption("Controller address (tls://host:port)"));
            controller.MaxLength = 512;
            Add(panel, controller);
            Add(panel, Caption("Gateway ID from Burrow"));
            gatewayId.MaxLength = 255;
            Add(panel, gatewayId);
            var explanation = Caption("Pairing lets Burrow run shell commands and access files as your Windows user. " +
                "Burrow can work in your workspace and reach other files your account can access. Gateway operations are not sandboxed.");
            explanation.MaximumSize = new Size(420, 0);
            Add(panel, explanation);
            consent.Text = consent.AccessibleName;
            Add(panel, consent);
            signIn.Text = signIn.AccessibleName;
            Add(panel, signIn);
            Add(panel, ButtonRow(start, stop));
            Add(panel, connectionStatus);
            errorStatus.MaximumSize = new Size(420, 0);
            Add(panel, errorStatus);

            var pairingInstructions = Caption("Compare the current code with the pairing request in Burrow. Confirm the match here and approve the request in Burrow.");
            pairingInstructions.MaximumSize = new Size(420, 0);
            Add(panel, pairingInstructions);
            pairingCode.ReadOnly = true;
            Add(panel, pairingCode);
            compared.Text = compared.AccessibleName;
            Add(panel, compared);
            Add(panel, ButtonRow(confirm));
            Add(panel, ButtonRow(desktopButton));
            desktopStatus.MaximumSize = new Size(420, 0);
            Add(panel, desktopStatus);
            var version = (AssemblyInformationalVersionAttribute)Attribute.GetCustomAttribute(
                typeof(ManagerForm).Assembly, typeof(AssemblyInformationalVersionAttribute));
            if (version != null) Add(panel, Caption("Version " + version.InformationalVersion));
        }

        static Label Caption(string text) { return new Label { Text = text }; }

        static void Add(TableLayoutPanel panel, Control control)
        {
            control.AutoSize = true;
            control.Dock = DockStyle.Top;
            panel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            panel.Controls.Add(control, 0, panel.RowCount++);
        }

        static FlowLayoutPanel ButtonRow(params Button[] buttons)
        {
            var row = new FlowLayoutPanel { AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink };
            foreach (var button in buttons)
            {
                button.AutoSize = true;
                button.Text = button.AccessibleName;
                row.Controls.Add(button);
            }
            return row;
        }

        public void Initialize(bool background)
        {
            // Create a handle for pipe and session callbacks even when starting in the tray.
            var handle = Handle;
            SetConnection("Stopped");
            SetDesktop("desktop_disabled");
            try
            {
                store.Prepare();
                var values = store.ReadConfig();
                string value;
                if (values.TryGetValue(GatewaySettings.ControllerKey, out value)) controller.Text = value;
                if (values.TryGetValue(GatewaySettings.IdKey, out value)) gatewayId.Text = value;
                consent.Checked = SavedConsentForFields();
                updatingSignIn = true;
                try { signIn.Checked = store.StartsOnSignIn(); }
                finally { updatingSignIn = false; }
            }
            catch (Exception error) { ShowError(error.Message); }
            UpdateControls();
            tray.Visible = true;
            timer.Start();
            if (!background) ShowManager();
            else if (signIn.Checked && consent.Checked) StartSaved();
        }

        void ShowManager()
        {
            if (exitRequested) return;
            WindowState = FormWindowState.Normal;
            Show();
            Activate();
        }

        protected override void OnFormClosing(FormClosingEventArgs args)
        {
            if (args.CloseReason == CloseReason.WindowsShutDown)
            {
                if (gateway != null && !stopping) Send(new { type = "stop" });
            }
            else if (!allowClose)
            {
                args.Cancel = true;
                Hide();
            }
            base.OnFormClosing(args);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                SystemEvents.SessionSwitch -= SessionSwitch;
                timer.Dispose();
                if (tray != null)
                {
                    tray.Visible = false;
                    tray.ContextMenuStrip.Dispose();
                    tray.Dispose();
                }
            }
            base.Dispose(disposing);
        }

        void SessionSwitch(object sender, SessionSwitchEventArgs args)
        {
            Post(() =>
            {
                if (args.Reason == SessionSwitchReason.SessionLock ||
                    args.Reason == SessionSwitchReason.ConsoleDisconnect ||
                    args.Reason == SessionSwitchReason.RemoteDisconnect)
                {
                    desktopSessionUnavailable = true;
                    if (desktopGranted)
                    {
                        Send(new { type = "desktopOff" });
                        SetDesktop("desktop_session_inactive");
                    }
                }
                else if (args.Reason == SessionSwitchReason.SessionUnlock ||
                    args.Reason == SessionSwitchReason.ConsoleConnect ||
                    args.Reason == SessionSwitchReason.RemoteConnect)
                    desktopSessionUnavailable = false;
                UpdateControls();
            });
        }

        void Post(Action action)
        {
            try { BeginInvoke(action); }
            catch (InvalidOperationException) { }
        }

        GatewaySettings Fields() { return new GatewaySettings(controller.Text, gatewayId.Text); }

        bool SavedConsentForFields()
        {
            try { return store.HasConsent(Fields()); }
            catch (ArgumentException) { return false; }
        }

        void SettingsChanged()
        {
            consent.Checked = false;
            UpdateControls();
        }

        void SaveSignIn()
        {
            if (updatingSignIn) return;
            try { store.SetStartOnSignIn(signIn.Checked); }
            catch (Exception error)
            {
                ShowError(error.Message);
                updatingSignIn = true;
                signIn.Checked = !signIn.Checked;
                updatingSignIn = false;
            }
        }

        void StartFromForm()
        {
            if (gateway != null || !consent.Checked || exitRequested) return;
            try
            {
                var settings = Fields();
                store.Prepare();
                store.CheckRuntime();
                store.SaveConsent(settings);
                StartGateway(settings);
            }
            catch (Exception error) { ShowError(error.Message); }
        }

        void StartSaved()
        {
            if (gateway != null || exitRequested) return;
            try
            {
                store.Prepare();
                var values = store.ReadConfig();
                string address, id;
                if (!values.TryGetValue(GatewaySettings.ControllerKey, out address) ||
                    !values.TryGetValue(GatewaySettings.IdKey, out id))
                    throw new InvalidOperationException("Enter the controller and gateway ID, then grant access before starting.");
                var settings = new GatewaySettings(address, id);
                if (!store.HasConsent(settings))
                    throw new InvalidOperationException("Open Node Goblin and save access consent for this controller and gateway ID.");
                store.CheckRuntime();
                controller.Text = settings.Controller;
                gatewayId.Text = settings.GatewayId;
                consent.Checked = true;
                StartGateway(settings);
            }
            catch (Exception error) { ShowError(error.Message); ShowManager(); }
        }

        void StartGateway(GatewaySettings settings)
        {
            OwnedGateway worker = null;
            worker = new OwnedGateway(store,
                line => Post(() => { if (gateway == worker && !stopping) Receive(line); }),
                code => Post(() => { if (gateway == worker && !stopping) GatewayExited(code); }));
            gateway = worker;
            fatalReported = false;
            ShowError("");
            SetConnection("Starting gateway…");
            if (!Send(new { type = "start", controller = settings.Controller, gatewayId = settings.GatewayId, stateDir = store.StateDirectory }))
                StopGateway();
            UpdateControls();
        }

        bool Send(object command)
        {
            try { gateway.Send(command); return true; }
            catch (Exception error)
            {
                ShowError("Could not send the command to the gateway. " + error.Message);
                return false;
            }
        }

        void GatewayExited(int code)
        {
            if (!fatalReported)
                ShowError(code == 0 ? "The gateway ended its session." : "The gateway exited with code " + code + ".");
            StopGateway(false);
        }

        void RequestExit()
        {
            exitRequested = true;
            if (gateway == null) FinishExit();
            else StopGateway();
        }

        void FinishExit()
        {
            allowClose = true;
            Close();
        }

        async void StopGateway(bool graceful = true)
        {
            if (gateway == null || stopping) return;
            var worker = gateway;
            stopping = true;
            ResetConnection();
            SetConnection("Stopping gateway…");
            UpdateControls();
            try
            {
                await Task.Run(() => worker.Stop(graceful));
                gateway = null;
                SetConnection("Stopped");
            }
            catch (Exception error)
            {
                exitRequested = false;
                SetConnection("Gateway shutdown incomplete");
                ShowError(error.Message);
                ShowManager();
            }
            finally
            {
                stopping = false;
                UpdateControls();
            }
            if (exitRequested) FinishExit();
        }

        void ConfirmPairing()
        {
            if (!compared.Checked || pairingCode.Text.Length == 0 || gateway == null || stopping) return;
            if (!Send(new { type = "confirm", code = pairingCode.Text })) return;
            confirmedCode = pairingCode.Text;
            compared.Checked = false;
            UpdateControls();
        }

        void ToggleDesktop()
        {
            if (connection == 0 || !desktopSupported || stopping) return;
            if (desktopGranted)
            {
                if (Send(new { type = "desktopOff" })) SetDesktop("desktop_stopping");
                return;
            }
            if (desktopSessionUnavailable) return;
            try { store.RequireAppFile(@"gateway\deploy\windows\desktop-helper.ps1"); }
            catch (Exception error) { SetDesktop("desktop_helper_absent"); ShowError(error.Message); return; }
            if (Send(new { type = "desktopOn", connection })) SetDesktop("desktop_starting");
        }

        void Receive(string line)
        {
            Dictionary<string, object> data;
            try { data = json.Deserialize<Dictionary<string, object>>(line); }
            catch (ArgumentException) { return; }
            catch (InvalidOperationException) { return; }
            if (data == null) return;
            var code = TextValue(data, "code");
            switch (TextValue(data, "type"))
            {
                case "connecting":
                    SetConnection("Connecting to controller…");
                    break;
                case "connected":
                    SetConnection("TLS connected. Waiting for Burrow authentication…");
                    break;
                case "connectionError":
                    ShowError("Connection error: " + SafeCode(code));
                    break;
                case "authenticationError":
                    ShowError("Authentication error: " + SafeCode(code));
                    break;
                case "disconnected":
                    ResetConnection();
                    SetConnection("Disconnected. Reconnecting…");
                    break;
                case "pairing":
                    if (!Regex.IsMatch(code, @"\A[A-F0-9]{4}(?:-[A-F0-9]{4}){2}\z")) break;
                    if (pairingCode.Text == code) break;
                    ClearPairing();
                    pairingCode.Text = code;
                    SetConnection("Pairing pending. Compare the current code in Burrow.");
                    ShowError("");
                    break;
                case "confirmed":
                    SetConnection("Confirmed on this computer. Waiting for Burrow approval…");
                    break;
                case "confirmationExpired":
                    ShowError("The pairing request changed or expired. Compare the current code before confirming.");
                    confirmedCode = null;
                    break;
                case "authenticated":
                    ClearPairing();
                    object supported;
                    desktopSupported = data.TryGetValue("desktopSupported", out supported) && Equals(supported, true);
                    int.TryParse(TextValue(data, "connection"), out connection);
                    SetConnection("Connected and authenticated with Burrow");
                    ShowError("");
                    break;
                case "desktop":
                    var state = TextValue(data, "state");
                    if (!desktopSessionUnavailable || state != "available") SetDesktop(state);
                    break;
                case "fatal":
                    fatalReported = true;
                    ShowError("Gateway error: " + SafeCode(code));
                    StopGateway();
                    break;
            }
            UpdateControls();
        }

        static string TextValue(Dictionary<string, object> data, string key)
        {
            object value;
            return data.TryGetValue(key, out value) ? Convert.ToString(value) : "";
        }

        static string SafeCode(string code)
        {
            return Regex.IsMatch(code, @"\A[A-Za-z0-9_]{1,64}\z") ? code : "gateway_error";
        }

        void ResetConnection()
        {
            ClearPairing();
            connection = 0;
            desktopSupported = false;
            SetDesktop("desktop_disabled");
        }

        void ClearPairing()
        {
            confirmedCode = null;
            pairingCode.Clear();
            compared.Checked = false;
        }

        void SetConnection(string text)
        {
            connectionStatus.Text = connectionStatus.AccessibleName = text;
            tray.Text = "Node Goblin · " + (text.Length > 46 ? text.Substring(0, 46) : text);
        }

        void ShowError(string text) { errorStatus.Text = errorStatus.AccessibleName = text; }

        void SetDesktop(string state)
        {
            desktopGranted = state == "available" || state == "desktop_starting" || state == "desktop_stopping";
            switch (state)
            {
                case "available": desktopStatus.Text = "Desktop access is enabled for this connection."; break;
                case "desktop_starting": desktopStatus.Text = "Starting the visible desktop helper…"; break;
                case "desktop_stopping": desktopStatus.Text = "Stopping desktop access…"; break;
                case "desktop_disabled":
                    desktopStatus.Text = "Desktop access is off. Enabling it lets Burrow view and interact with this Windows desktop.";
                    break;
                case "desktop_helper_absent": desktopStatus.Text = "Desktop access is off. The helper stopped or is unavailable."; break;
                case "desktop_session_inactive": desktopStatus.Text = "Desktop access is off. The Windows session is locked or inactive."; break;
                default: desktopStatus.Text = "Desktop access is off. " + SafeCode(state); break;
            }
            desktopStatus.AccessibleName = desktopStatus.Text;
            desktopButton.Text = desktopButton.AccessibleName = desktopGranted
                ? "Stop desktop access" : "Enable desktop for this connection";
            UpdateControls();
        }

        void UpdateControls()
        {
            bool idle = gateway == null && !exitRequested;
            controller.Enabled = gatewayId.Enabled = consent.Enabled = idle;
            start.Enabled = idle && consent.Checked;
            stop.Enabled = trayStop.Enabled = !idle && gateway != null && !stopping;
            trayStart.Enabled = idle;
            compared.Enabled = pairingCode.Text.Length != 0 && pairingCode.Text != confirmedCode && !stopping;
            confirm.Enabled = compared.Enabled && compared.Checked;
            desktopButton.Enabled = connection != 0 && desktopSupported && !stopping &&
                (!desktopSessionUnavailable || desktopGranted);
        }
    }
}
