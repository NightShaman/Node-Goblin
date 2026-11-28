using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace NodeGoblin
{
    internal sealed class OwnedGateway
    {
        readonly Process process;
        readonly ProcessJob job;
        readonly JavaScriptSerializer writer = new JavaScriptSerializer();

        public OwnedGateway(ManagerSettings store, Action<string> message, Action<int> exited)
        {
            var start = new ProcessStartInfo(store.RequireAppFile(@"node\node.exe"),
                "\"" + store.RequireAppFile(@"gateway\deploy\windows\manager-host.mjs") + "\"")
            {
                WorkingDirectory = store.AppDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = new System.Text.UTF8Encoding(false)
            };
            foreach (string key in start.EnvironmentVariables.Keys.Cast<string>().ToArray())
            {
                if (key.StartsWith("BURROW_GATEWAY_", StringComparison.OrdinalIgnoreCase) ||
                    key.StartsWith("NODE_", StringComparison.OrdinalIgnoreCase) ||
                    key.StartsWith("OTEL_", StringComparison.OrdinalIgnoreCase) ||
                    key.Equals("SSLKEYLOGFILE", StringComparison.OrdinalIgnoreCase))
                    start.EnvironmentVariables.Remove(key);
            }
            job = new ProcessJob();
            process = new Process { StartInfo = start };
            process.OutputDataReceived += (sender, args) => { if (args.Data != null) message(args.Data); };
            bool started = false;
            try
            {
                started = process.Start();
                if (!started) throw new IOException("Could not start the bundled Node runtime.");
                // The adapter opens no connection until a start command, sent only after assignment.
                job.Assign(process);
                process.BeginOutputReadLine();
                Task.Run(() =>
                {
                    try
                    {
                        process.WaitForExit();
                        exited(process.ExitCode);
                    }
                    catch (InvalidOperationException) { }
                });
                // Stderr can contain raw library or child-process details. Drain without storing it.
                process.StandardError.BaseStream.CopyToAsync(Stream.Null);
            }
            catch
            {
                if (started && !process.HasExited)
                {
                    try { process.Kill(); }
                    catch (InvalidOperationException) { }
                }
                job.Dispose();
                process.Dispose();
                throw;
            }
        }

        public void Send(object command)
        {
            // Make the pipe independent of the operator's console code page.
            var bytes = new System.Text.UTF8Encoding(false).GetBytes(writer.Serialize(command) + "\n");
            var input = process.StandardInput.BaseStream;
            input.Write(bytes, 0, bytes.Length);
            input.Flush();
        }

        // Called away from the UI thread. Keep the job until all owned processes
        // are gone, including children that outlive the Node process.
        public void Stop(bool graceful)
        {
            if (graceful && !process.HasExited)
            {
                try { Send(new { type = "stop" }); }
                catch (IOException) { }
                catch (InvalidOperationException) { }
                process.WaitForExit(3500);
            }
            job.Stop();
            if (!process.WaitForExit(2000)) throw new IOException("The gateway process did not exit.");
            process.Dispose();
            job.Dispose();
        }
    }

    internal sealed class ProcessJob : IDisposable
    {
        const uint KillOnJobClose = 0x2000;
        readonly SafeFileHandle handle;

        public ProcessJob()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle.IsInvalid) throw new Win32Exception();
            var settings = new ExtendedLimits();
            settings.Basic.LimitFlags = KillOnJobClose;
            if (!SetInformationJobObject(handle, 9, ref settings, Marshal.SizeOf(typeof(ExtendedLimits))))
            {
                var failure = new Win32Exception();
                handle.Dispose();
                throw failure;
            }
        }

        public void Assign(Process process)
        {
            if (!AssignProcessToJobObject(handle, process.Handle)) throw new Win32Exception();
        }

        uint ActiveProcesses()
        {
            BasicAccounting state;
            if (!QueryInformationJobObject(handle, 1, out state, Marshal.SizeOf(typeof(BasicAccounting)), IntPtr.Zero))
                throw new Win32Exception();
            return state.ActiveProcesses;
        }

        public void Stop()
        {
            if (ActiveProcesses() == 0) return;
            if (!TerminateJobObject(handle, 1) && ActiveProcesses() != 0) throw new Win32Exception();
            var clock = Stopwatch.StartNew();
            while (ActiveProcesses() != 0)
            {
                if (clock.ElapsedMilliseconds >= 2000) throw new IOException("Gateway child processes did not exit.");
                Thread.Sleep(25);
            }
        }

        public void Dispose() { handle.Dispose(); }

        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits Basic;
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct BasicAccounting
        {
            public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref ExtendedLimits value, int size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out BasicAccounting value, int size, IntPtr returnedSize);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(SafeFileHandle job, uint code);
    }
}
