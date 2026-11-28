using System;
using System.Diagnostics;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

namespace NodeGoblin
{
    internal static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            bool shutdown = args.Length == 1 && args[0] == "--shutdown";
            bool background = args.Length == 1 && args[0] == "--background";
            if (args.Length != 0 && !shutdown && !background) return 2;

            try
            {
                if (Process.GetCurrentProcess().SessionId == 0 || (!shutdown &&
                    new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)))
                    throw new InvalidOperationException("Run Node Goblin as a non-elevated user in a signed-in Windows session.");

                using (var instance = new ManagerInstance())
                {
                    if (!instance.TryOwn(0))
                    {
                        if (shutdown)
                        {
                            instance.Shutdown.Set();
                            return instance.TryOwn(10000) ? 0 : 1;
                        }
                        if (!background) instance.Open.Set();
                        return 0;
                    }
                    if (shutdown) return 0;
                    // An open request racing startup must still show a background launch.
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    using (var loop = new ApplicationContext())
                    using (var form = new ManagerForm(instance))
                    {
                        form.FormClosed += (sender, eventArgs) => loop.ExitThread();
                        form.Initialize(background);
                        Application.Run(loop);
                    }
                }
                return 0;
            }
            catch (Exception error)
            {
                if (!shutdown && !background)
                    MessageBox.Show(error.Message, "Node Goblin", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
    }

    internal sealed class ManagerInstance : IDisposable
    {
        readonly Mutex owner;
        bool owned;
        public EventWaitHandle Open { get; private set; }
        public EventWaitHandle Shutdown { get; private set; }

        public ManagerInstance()
        {
            string name = @"Global\Burrow.NodeGoblin.Manager." + ManagerSettings.User.Value;
            bool created;
            var mutexSecurity = new MutexSecurity();
            var eventSecurity = new EventWaitHandleSecurity();
            foreach (var sid in ManagerSettings.Allowed)
            {
                mutexSecurity.AddAccessRule(new MutexAccessRule(sid, MutexRights.FullControl, AccessControlType.Allow));
                eventSecurity.AddAccessRule(new EventWaitHandleAccessRule(sid, EventWaitHandleRights.FullControl, AccessControlType.Allow));
            }
            owner = new Mutex(false, name, out created, mutexSecurity);
            try
            {
                ManagerSettings.ValidateAcl(name, owner.GetAccessControl(), typeof(MutexAccessRule));
                Open = NewEvent(name + ".Open", eventSecurity);
                Shutdown = NewEvent(name + ".Shutdown", eventSecurity);
            }
            catch
            {
                Dispose();
                throw;
            }
        }

        static EventWaitHandle NewEvent(string name, EventWaitHandleSecurity security)
        {
            bool created;
            var signal = new EventWaitHandle(false, EventResetMode.AutoReset, name, out created, security);
            try
            {
                ManagerSettings.ValidateAcl(name, signal.GetAccessControl(), typeof(EventWaitHandleAccessRule));
                return signal;
            }
            catch
            {
                signal.Dispose();
                throw;
            }
        }

        public bool TryOwn(int milliseconds)
        {
            try { owned = owner.WaitOne(milliseconds); }
            catch (AbandonedMutexException) { owned = true; }
            return owned;
        }

        public void Dispose()
        {
            if (Open != null) Open.Dispose();
            if (Shutdown != null) Shutdown.Dispose();
            if (owned) owner.ReleaseMutex();
            owner.Dispose();
        }
    }
}
