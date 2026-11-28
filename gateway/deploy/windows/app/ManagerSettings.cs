using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace NodeGoblin
{
    public sealed class GatewaySettings
    {
        public const string ControllerKey = "BURROW_GATEWAY_CONTROLLER_URL";
        public const string IdKey = "BURROW_GATEWAY_ID";
        public string Controller { get; private set; }
        public string GatewayId { get; private set; }

        public GatewaySettings(string controller, string gatewayId)
        {
            controller = (controller ?? "").Trim();
            gatewayId = (gatewayId ?? "").Trim();
            var match = Regex.Match(controller, @"\Atls://(\[[a-f0-9:.]+\]|[a-z0-9._-]+):([0-9]{1,5})/?\z",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
            int port;
            IPAddress address;
            if (!match.Success || !Int32.TryParse(match.Groups[2].Value, out port) || port < 1 || port > 65535 ||
                (match.Groups[1].Value.StartsWith("[") &&
                 (!IPAddress.TryParse(match.Groups[1].Value.Trim('[', ']'), out address) ||
                  address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetworkV6)))
                throw new ArgumentException("Enter the controller as tls://host:port, with an explicit port.");
            if (gatewayId == "local" || !Regex.IsMatch(gatewayId, @"\A[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}\z"))
                throw new ArgumentException("Enter a Burrow gateway ID using letters, digits, dots, underscores or hyphens.");
            Controller = controller;
            GatewayId = gatewayId;
        }

        internal string ConsentRecord
        {
            get { return "Node Goblin access consent v1\n" + Controller + "\n" + GatewayId + "\n"; }
        }
    }

    public sealed class ManagerSettings
    {
        internal static readonly SecurityIdentifier User = WindowsIdentity.GetCurrent().User;
        internal static readonly SecurityIdentifier[] Allowed = {
            User, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null)
        };

        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunEntry = "NodeGoblin";
        readonly string root;
        readonly string config;
        readonly string consent;
        public string StateDirectory { get; private set; }
        public string AppDirectory { get; private set; }

        public ManagerSettings(string localAppData)
        {
            root = Path.Combine(Path.GetFullPath(localAppData), "NodeGoblin");
            AppDirectory = Path.Combine(root, "app");
            StateDirectory = Path.Combine(root, "state");
            config = Path.Combine(root, "config", "gateway.env");
            consent = Path.Combine(root, "config", "manager-consent");
        }

        internal static void ValidateAcl(string path, CommonObjectSecurity security, Type ruleType)
        {
            if (Array.IndexOf(Allowed, (SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier))) < 0)
                throw new IOException("Unexpected security owner for " + path);
            foreach (AuthorizationRule entry in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            {
                var rule = entry as AccessRule;
                if (rule == null || !ruleType.IsInstanceOfType(rule) || rule.AccessControlType != AccessControlType.Allow ||
                    Array.IndexOf(Allowed, (SecurityIdentifier)entry.IdentityReference) < 0)
                    throw new IOException("Unexpected access rule for " + path);
            }
        }

        static FileAttributes? Attributes(string path)
        {
            try { return File.GetAttributes(path); }
            catch (FileNotFoundException) { return null; }
            catch (DirectoryNotFoundException) { return null; }
        }

        static void AssertPlainPath(string path)
        {
            for (var current = Path.GetFullPath(path); current != null; current = Path.GetDirectoryName(current))
            {
                var attributes = Attributes(current);
                if (attributes.HasValue && (attributes.Value & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("Refusing Windows reparse point at " + current);
            }
        }

        static bool CheckPath(string path, bool directory)
        {
            AssertPlainPath(path);
            var attributes = Attributes(path);
            if (!attributes.HasValue) return false;
            if (((attributes.Value & FileAttributes.Directory) != 0) != directory)
                throw new IOException("Unexpected file type at " + path);
            var acl = directory ? (FileSystemSecurity)Directory.GetAccessControl(path) : File.GetAccessControl(path);
            ValidateAcl(path, acl, typeof(FileSystemAccessRule));
            return true;
        }

        static void ProtectDirectory(string path)
        {
            bool exists = CheckPath(path, true);
            var acl = new DirectorySecurity();
            acl.SetAccessRuleProtection(true, false);
            foreach (var sid in Allowed)
                acl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                    PropagationFlags.None, AccessControlType.Allow));
            if (exists) Directory.SetAccessControl(path, acl);
            else Directory.CreateDirectory(path, acl);
            CheckPath(path, true);
            if (!Directory.GetAccessControl(path).AreAccessRulesProtected)
                throw new IOException("Could not protect " + path);
        }

        public void Prepare()
        {
            ProtectDirectory(root);
            ProtectDirectory(Path.GetDirectoryName(config));
            ProtectDirectory(StateDirectory);
            foreach (string entry in Directory.EnumerateFileSystemEntries(StateDirectory))
                CheckPath(entry, false);
            CheckPath(config, false);
            CheckPath(consent, false);
        }

        public string RequireAppFile(string relative)
        {
            var path = Path.GetFullPath(Path.Combine(AppDirectory, relative));
            if (!path.StartsWith(AppDirectory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("The installed file must be inside the application directory.", "relative");
            for (var parent = Path.GetDirectoryName(path); parent != root; parent = Path.GetDirectoryName(parent))
                if (!CheckPath(parent, true)) throw new IOException("Missing installed directory " + parent);
            if (!CheckPath(path, false)) throw new IOException("Missing installed file " + path);
            return path;
        }

        public void CheckRuntime()
        {
            RequireAppFile("NodeGoblin.exe");
            RequireAppFile(@"node\node.exe");
            RequireAppFile(@"gateway\deploy\windows\manager-host.mjs");
            RequireAppFile(@"gateway\VERSION");
            var libraries = Path.Combine(AppDirectory, "gateway", "lib");
            if (!CheckPath(libraries, true)) throw new IOException("Missing installed gateway libraries.");
            foreach (string file in Directory.EnumerateFileSystemEntries(libraries))
                CheckPath(file, false);
        }

        public IDictionary<string, string> ReadConfig()
        {
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            if (CheckPath(config, false))
            {
                foreach (string line in File.ReadLines(config))
                {
                    if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal)) continue;
                    var match = Regex.Match(line, @"\A([A-Z0-9_]+)=(.*)\z");
                    if (!match.Success) throw new IOException("Invalid line in gateway.env.");
                    values[match.Groups[1].Value] = match.Groups[2].Value;
                }
            }
            return values;
        }

        public bool HasConsent(GatewaySettings settings)
        {
            return CheckPath(consent, false) && File.ReadAllText(consent) == settings.ConsentRecord;
        }

        public void SaveConsent(GatewaySettings settings)
        {
            var values = ReadConfig();
            values[GatewaySettings.ControllerKey] = settings.Controller;
            values[GatewaySettings.IdKey] = settings.GatewayId;
            var content = new StringBuilder();
            foreach (var entry in values) content.Append(entry.Key).Append('=').Append(entry.Value).Append('\n');
            WriteProtected(config, content.ToString());
            WriteProtected(consent, settings.ConsentRecord);
        }

        static void WriteProtected(string destination, string content)
        {
            var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
                    writer.Write(content);
                CheckPath(temporary, false);
                if (CheckPath(destination, false)) File.Replace(temporary, destination, null);
                else File.Move(temporary, destination);
            }
            finally { File.Delete(temporary); }
        }

        string RunCommand { get { return "\"" + Path.Combine(AppDirectory, "NodeGoblin.exe") + "\" --background"; } }

        public bool StartsOnSignIn()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(RunKey))
                return key != null && String.Equals(key.GetValue(RunEntry) as string, RunCommand, StringComparison.OrdinalIgnoreCase);
        }

        public void SetStartOnSignIn(bool enabled)
        {
            if (enabled) RequireAppFile("NodeGoblin.exe");
            using (var key = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (enabled) key.SetValue(RunEntry, RunCommand, RegistryValueKind.String);
                else key.DeleteValue(RunEntry, false);
            }
        }
    }
}
