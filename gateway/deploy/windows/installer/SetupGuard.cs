using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal static class SetupGuard
{
    static readonly SecurityIdentifier User = WindowsIdentity.GetCurrent().User;
    static readonly SecurityIdentifier[] Allowed = {
        User, new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
        new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null)
    };

    static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2 || (args[1] != "owned" && args[1] != "new"))
                throw new ArgumentException("Invalid installer safety check arguments.");
            if (new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
                throw new IOException("Run Node Goblin Setup as the signed-in user without elevation.");

            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (!Path.IsPathRooted(local) || local.StartsWith(@"\\", StringComparison.Ordinal))
                throw new IOException("Local AppData must be on a local Windows drive.");
            local = Path.GetFullPath(local);
            string root = Path.Combine(local, "NodeGoblin");
            string app = Path.Combine(root, "app");
            if (!String.Equals(args[0], app, StringComparison.OrdinalIgnoreCase))
                throw new IOException("Node Goblin must use " + app);

            for (string ancestor = local; ancestor != null; ancestor = Path.GetDirectoryName(ancestor))
                if (!PlainPath(ancestor, true)) throw new DirectoryNotFoundException(ancestor);
            if (!PlainPath(root, true)) CreateProtectedRoot(root);
            CheckAcl(root, true, true);
            foreach (string name in new[] { "config", "state" })
            {
                string data = Path.Combine(root, name);
                if (PlainPath(data, true)) CheckAcl(data, true, false);
            }

            if (!PlainPath(app, true)) return Ready();
            CheckAcl(app, true, false);
            if (args[1] == "new")
            {
                using (var entries = Directory.EnumerateFileSystemEntries(app).GetEnumerator())
                    if (entries.MoveNext()) throw new IOException("The application folder belongs to an unrecognized installation: " + app);
                return Ready();
            }

            CheckTree(app, app, false);
            StopInstalledManager(app);
            CheckTree(app, app, true);
            return Ready();
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 1;
        }
    }

    static int Ready()
    {
        Console.WriteLine(User.Value);
        return 0;
    }

    static bool PlainPath(string path, bool directory)
    {
        FileAttributes attributes;
        try { attributes = File.GetAttributes(path); }
        catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
        if ((attributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Refusing Windows reparse point at " + path);
        if (((attributes & FileAttributes.Directory) != 0) != directory)
            throw new IOException("Unexpected file type at " + path);
        return true;
    }

    static void CreateProtectedRoot(string path)
    {
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        foreach (var sid in Allowed)
            security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None, AccessControlType.Allow));
        Directory.CreateDirectory(path, security);
    }

    static void CheckAcl(string path, bool directory, bool requireProtection)
    {
        FileSystemSecurity security = directory ? (FileSystemSecurity)Directory.GetAccessControl(path) : File.GetAccessControl(path);
        if ((requireProtection && !security.AreAccessRulesProtected) ||
            Array.IndexOf(Allowed, (SecurityIdentifier)security.GetOwner(typeof(SecurityIdentifier))) < 0)
            throw new IOException("Unexpected security owner or inheritance at " + path);

        // The raw descriptor distinguishes a missing/null DACL from an empty DACL.
        var descriptor = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
        if (descriptor.DiscretionaryAcl == null || descriptor.DiscretionaryAcl.Count == 0)
            throw new IOException("Missing access rules at " + path);
        foreach (GenericAce ace in descriptor.DiscretionaryAcl)
        {
            var allowed = ace as CommonAce;
            if (allowed == null || allowed.AceType != AceType.AccessAllowed ||
                Array.IndexOf(Allowed, allowed.SecurityIdentifier) < 0)
                throw new IOException("Unexpected access rule at " + path);
        }
    }

    static void CheckTree(string app, string directory, bool checkLocks)
    {
        foreach (string path in Directory.EnumerateFileSystemEntries(directory))
        {
            bool isDirectory = (File.GetAttributes(path) & FileAttributes.Directory) != 0;
            if (!PlainPath(path, isDirectory)) throw new IOException("Application file disappeared at " + path);
            CheckAcl(path, isDirectory, false);
            if (isDirectory)
            {
                CheckTree(app, path, checkLocks);
                continue;
            }

            // Inno's uninstaller and this version's guard can have open image or log handles.
            bool installerFile = directory == app && Regex.IsMatch(Path.GetFileName(path),
                @"\A(?:unins[0-9]{3}\.(?:exe|dat|msg)|setup-guard-[0-9a-f]{64}\.exe)\z", RegexOptions.IgnoreCase);
            uint access = checkLocks && !installerFile ? 0xC0000000 : 0x80; // read/write, or read attributes
            uint sharing = checkLocks && !installerFile ? 0u : 7u;
            using (var handle = CreateFile(path, access, sharing, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero))
            {
                FileInformation information;
                if (handle.IsInvalid || !GetFileInformationByHandle(handle, out information))
                    throw new IOException("Cannot access application file " + path + ". Close programs using it and run Setup again.",
                        new Win32Exception());
                if ((information.Attributes & (uint)FileAttributes.ReparsePoint) != 0 || information.Links != 1)
                    throw new IOException("Refusing linked application file " + path);
            }
        }
    }

    static void StopInstalledManager(string app)
    {
        string manager = Path.Combine(app, "NodeGoblin.exe");
        string node = Path.Combine(app, "node", "node.exe");
        if (IsRunning(manager))
        {
            var start = new ProcessStartInfo(manager, "--shutdown") {
                WorkingDirectory = app, UseShellExecute = false, CreateNoWindow = true
            };
            using (var request = Process.Start(start))
                if (!request.WaitForExit(15000) || request.ExitCode != 0)
                    throw new IOException("Node Goblin did not shut down. Close the manager and run Setup again.");
        }
        var deadline = Stopwatch.StartNew();
        while (IsRunning(manager) || IsRunning(node))
        {
            if (deadline.ElapsedMilliseconds >= 3000)
                throw new IOException("An installed Node Goblin process is still running. Close it and run Setup again.");
            Thread.Sleep(100);
        }
    }

    static bool IsRunning(string image)
    {
        var candidates = Process.GetProcessesByName(Path.GetFileNameWithoutExtension(image));
        try
        {
            foreach (var process in candidates)
            {
                using (var handle = OpenProcess(0x1000, false, process.Id)) // PROCESS_QUERY_LIMITED_INFORMATION
                {
                    if (handle.IsInvalid)
                    {
                        int error = Marshal.GetLastWin32Error();
                        // A foreign or exited process need not be readable. CheckTree also probes
                        // for write access to the protected executables before any replacement.
                        if (error == 5 || error == 87) continue;
                        throw new Win32Exception(error);
                    }
                    var path = new StringBuilder(32768);
                    int size = path.Capacity;
                    if (!QueryFullProcessImageName(handle, 0, path, ref size))
                    {
                        if (process.HasExited) continue;
                        throw new Win32Exception();
                    }
                    if (String.Equals(image, path.ToString(), StringComparison.OrdinalIgnoreCase)) return true;
                }
            }
            return false;
        }
        finally
        {
            foreach (var process in candidates) process.Dispose();
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct FileInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint sharing,
        IntPtr attributes, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern SafeWaitHandle OpenProcess(uint access, bool inherit, int process);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageName(SafeWaitHandle process, int flags, StringBuilder image, ref int size);
}
