// Compiled inside the per-run PowerShell host; no native addon or external compiler is required.
// Keep the C# compatible with Windows PowerShell 5.1's compiler and .NET Framework.
export const WINDOWS_JOB_SUPERVISOR_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Dirac.WindowsOwnership
{
    public static class JobSupervisor
    {
        const uint CREATE_SUSPENDED = 0x00000004;
        const uint CREATE_NO_WINDOW = 0x08000000;
        const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        const uint STARTF_USESTDHANDLES = 0x00000100;
        const uint HANDLE_FLAG_INHERIT = 1;
        const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        const uint WAIT_OBJECT_0 = 0;
        const uint WAIT_TIMEOUT = 258;
        const int ERROR_BROKEN_PIPE = 109;
        const int ERROR_NO_DATA = 232;
        const int CLEANUP_TIMEOUT_MS = 30000;
        static readonly IntPtr HANDLE_LIST = new IntPtr(0x00020002);
        // Windows 10+: assignment is atomic with creation, including if this supervisor crashes.
        static readonly IntPtr JOB_LIST = new IntPtr(0x0002000D);
        static readonly object OutputLock = new object();
        static readonly Stream ProtocolOutput = Console.OpenStandardOutput();
        static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

        [StructLayout(LayoutKind.Sequential)]
        struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
            public uint dwFlags;
            public short wShowWindow, cbReserved2;
            public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct PROCESS_INFORMATION
        {
            public IntPtr hProcess, hThread;
            public uint dwProcessId, dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IO_COUNTERS
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        {
            public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool QueryInformationJobObject(IntPtr job, int infoClass,
            out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returnLength);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
            IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);
        [DllImport("kernel32.dll")]
        static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CreateProcessW(string applicationName, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
            IntPtr environment, string currentDirectory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool ReadFile(IntPtr file, byte[] buffer, uint count, out uint read, IntPtr overlapped);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool WriteFile(IntPtr file, byte[] buffer, uint count, out uint written, IntPtr overlapped);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint SearchPathW(string searchPath, string fileName, string extension,
            uint bufferLength, StringBuilder buffer, IntPtr filePart);

        static void Check(bool success, string operation)
        {
            if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }

        static void Close(ref IntPtr handle)
        {
            if (handle == IntPtr.Zero) return;
            Check(CloseHandle(handle), "CloseHandle");
            handle = IntPtr.Zero;
        }

        static void Frame(string frame)
        {
            byte[] bytes = Utf8.GetBytes(frame + "\n");
            lock (OutputLock)
            {
                ProtocolOutput.Write(bytes, 0, bytes.Length);
                ProtocolOutput.Flush();
            }
        }

        static string Encoded(string value)
        {
            // Bound diagnostic frames below the adapter's 64 KiB limit, even for non-ASCII messages.
            if (value.Length > 8000) value = value.Substring(0, 8000);
            return Convert.ToBase64String(Encoding.UTF8.GetBytes(value));
        }

        static string ResolveExecutable(string executable, string cwd)
        {
            if (Path.IsPathRooted(executable)) return executable;
            if (executable.IndexOf('\\') >= 0 || executable.IndexOf('/') >= 0)
                return Path.GetFullPath(Path.Combine(cwd.Length == 0 ? Environment.CurrentDirectory : cwd, executable));
            StringBuilder buffer = new StringBuilder(32768);
            uint length = SearchPathW(null, executable, ".exe", (uint)buffer.Capacity, buffer, IntPtr.Zero);
            if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "SearchPathW: " + executable);
            if (length >= buffer.Capacity) throw new IOException("Resolved executable path exceeds supported length");
            return buffer.ToString();
        }

        static string ReadField(StreamReader reader)
        {
            string line = reader.ReadLine();
            if (line == null) throw new EndOfStreamException("Parent closed startup input");
            return Utf8.GetString(Convert.FromBase64String(line));
        }

        sealed class Workers
        {
            public readonly ManualResetEvent Cancelled = new ManualResetEvent(false);
            public readonly ManualResetEvent Failed = new ManualResetEvent(false);
            public Exception Failure;
            public Thread Output, Error, Input;

            void RecordFailure(Exception error)
            {
                Interlocked.CompareExchange(ref Failure, error, null);
                Failed.Set();
            }

            public void WatchParent(StreamReader reader)
            {
                // Only this thread reads after startup; even buffered cancellation bytes are retained.
                Thread watcher = new Thread(delegate()
                {
                    try
                    {
                        string command = reader.ReadLine();
                        if (command != null && command != "cancel")
                            RecordFailure(new IOException("Invalid parent control frame"));
                    }
                    catch (Exception error) { RecordFailure(error); }
                    finally { Cancelled.Set(); }
                });
                watcher.IsBackground = true;
                watcher.Start();
            }

            public Thread Pump(PipeHandle pipe, string stream)
            {
                Thread thread = new Thread(delegate()
                {
                    try
                    {
                        byte[] buffer = new byte[16384];
                        while (true)
                        {
                            uint count;
                            if (!ReadFile(pipe.Handle, buffer, (uint)buffer.Length, out count, IntPtr.Zero))
                            {
                                int code = Marshal.GetLastWin32Error();
                                if (code == ERROR_BROKEN_PIPE || code == ERROR_NO_DATA) break;
                                throw new Win32Exception(code, "Read child " + stream);
                            }
                            if (count == 0) break;
                            Frame(stream + "\t" + Convert.ToBase64String(buffer, 0, (int)count));
                        }
                    }
                    catch (Exception error) { RecordFailure(error); }
                });
                thread.IsBackground = true;
                return thread;
            }

            public Thread WriteInput(PipeHandle pipe, byte[] input)
            {
                Thread thread = new Thread(delegate()
                {
                    try
                    {
                        int offset = 0;
                        while (offset < input.Length)
                        {
                            int length = Math.Min(16384, input.Length - offset);
                            byte[] chunk = new byte[length];
                            Buffer.BlockCopy(input, offset, chunk, 0, length);
                            uint written;
                            if (!WriteFile(pipe.Handle, chunk, (uint)length, out written, IntPtr.Zero))
                            {
                                int code = Marshal.GetLastWin32Error();
                                // A program may intentionally exit without consuming all its input.
                                if (code == ERROR_BROKEN_PIPE || code == ERROR_NO_DATA) break;
                                throw new Win32Exception(code, "Write child stdin");
                            }
                            if (written == 0) throw new IOException("Child stdin made no progress");
                            offset += (int)written;
                        }
                    }
                    catch (Exception error) { RecordFailure(error); }
                    finally
                    {
                        try { Close(ref pipe.Handle); }
                        catch (Exception error) { RecordFailure(error); }
                    }
                });
                thread.IsBackground = true;
                return thread;
            }
        }

        // Mutable holders keep ownership explicit when the stdin worker closes its pipe.
        sealed class PipeHandle { public IntPtr Handle; }

        static bool AttemptCleanup(Action action, ref Exception failure)
        {
            try { action(); return true; }
            catch (Exception error)
            {
                failure = failure == null ? error : new AggregateException(failure, error);
                return false;
            }
        }

        static void Join(Thread thread)
        {
            if (thread != null && (thread.ThreadState & System.Threading.ThreadState.Unstarted) == 0 &&
                !thread.Join(CLEANUP_TIMEOUT_MS)) throw new TimeoutException("Child pipe worker did not drain");
        }

        static void WaitForExit(IntPtr process)
        {
            uint result = WaitForSingleObject(process, CLEANUP_TIMEOUT_MS);
            if (result == WAIT_TIMEOUT) throw new TimeoutException("Child did not terminate");
            if (result != WAIT_OBJECT_0) throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject");
        }

        static void WaitForEmptyJob(IntPtr job)
        {
            Stopwatch timer = Stopwatch.StartNew();
            while (true)
            {
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
                Check(QueryInformationJobObject(job, 1, out accounting,
                    (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero),
                    "QueryInformationJobObject");
                if (accounting.ActiveProcesses == 0) return;
                if (timer.ElapsedMilliseconds >= CLEANUP_TIMEOUT_MS)
                    throw new TimeoutException("Job still contains active processes");
                Thread.Sleep(10);
            }
        }

        public static int Run()
        {
            IntPtr job = IntPtr.Zero, childInput = IntPtr.Zero, childOutput = IntPtr.Zero, childError = IntPtr.Zero;
            IntPtr attributes = IntPtr.Zero, handleList = IntPtr.Zero, jobList = IntPtr.Zero;
            bool attributesInitialized = false;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            PipeHandle input = new PipeHandle(), output = new PipeHandle(), error = new PipeHandle();
            Workers workers = new Workers();
            Exception operationFailure = null, cleanupFailure = null;
            int exitCode = -1;
            try
            {
                StreamReader reader = new StreamReader(Console.OpenStandardInput(), Utf8, false, 4096);
                string executable = ReadField(reader);
                string commandLine = ReadField(reader);
                string cwd = ReadField(reader);
                byte[] payload = Utf8.GetBytes(ReadField(reader));
                if (executable.Length == 0 || commandLine.Length == 0)
                    throw new ArgumentException("Executable and command line must not be empty");
                workers.WatchParent(reader);
                if (!workers.Cancelled.WaitOne(0))
                {
                    job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
                    Check(job != IntPtr.Zero, "CreateJobObjectW");
                    Check(SetHandleInformation(job, HANDLE_FLAG_INHERIT, 0), "Make job handle non-inheritable");
                    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    Check(SetInformationJobObject(job, 9, ref limits,
                        (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))), "SetInformationJobObject");

                    SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES();
                    security.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
                    security.bInheritHandle = true;
                    Check(CreatePipe(out childInput, out input.Handle, ref security, 0), "Create stdin pipe");
                    Check(CreatePipe(out output.Handle, out childOutput, ref security, 0), "Create stdout pipe");
                    Check(CreatePipe(out error.Handle, out childError, ref security, 0), "Create stderr pipe");
                    Check(SetHandleInformation(input.Handle, HANDLE_FLAG_INHERIT, 0), "Protect parent stdin pipe");
                    Check(SetHandleInformation(output.Handle, HANDLE_FLAG_INHERIT, 0), "Protect parent stdout pipe");
                    Check(SetHandleInformation(error.Handle, HANDLE_FLAG_INHERIT, 0), "Protect parent stderr pipe");

                    IntPtr size = IntPtr.Zero;
                    InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                    if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Size attribute list");
                    attributes = Marshal.AllocHGlobal(size);
                    Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "Initialize attribute list");
                    attributesInitialized = true;
                    handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                    Marshal.WriteIntPtr(handleList, 0, childInput);
                    Marshal.WriteIntPtr(handleList, IntPtr.Size, childOutput);
                    Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, childError);
                    Check(UpdateProcThreadAttribute(attributes, 0, HANDLE_LIST, handleList,
                        new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "Set inherited handle list");
                    jobList = Marshal.AllocHGlobal(IntPtr.Size);
                    Marshal.WriteIntPtr(jobList, job);
                    Check(UpdateProcThreadAttribute(attributes, 0, JOB_LIST, jobList,
                        new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Set atomic job list (Windows 10+ required)");
                    STARTUPINFOEX startup = new STARTUPINFOEX();
                    startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
                    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
                    startup.StartupInfo.hStdInput = childInput;
                    startup.StartupInfo.hStdOutput = childOutput;
                    startup.StartupInfo.hStdError = childError;
                    startup.lpAttributeList = attributes;
                    Check(CreateProcessW(ResolveExecutable(executable, cwd), new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
                        CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero,
                        cwd.Length == 0 ? null : cwd, ref startup, out process), "CreateProcessW");
                    // The job-list attribute assigns ownership inside CreateProcessW, before any child code runs.
                    Close(ref childInput);
                    Close(ref childOutput);
                    Close(ref childError);
                    Frame("started\t" + process.dwProcessId);
                    workers.Output = workers.Pump(output, "stdout");
                    workers.Error = workers.Pump(error, "stderr");
                    workers.Input = workers.WriteInput(input, payload);
                    workers.Output.Start();
                    workers.Error.Start();
                    workers.Input.Start();
                    if (!workers.Cancelled.WaitOne(0))
                    {
                        if (ResumeThread(process.hThread) == UInt32.MaxValue)
                            throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
                        while (!workers.Cancelled.WaitOne(0) && !workers.Failed.WaitOne(0))
                        {
                            uint result = WaitForSingleObject(process.hProcess, 20);
                            if (result == WAIT_OBJECT_0)
                            {
                                uint nativeExitCode;
                                Check(GetExitCodeProcess(process.hProcess, out nativeExitCode), "GetExitCodeProcess");
                                exitCode = unchecked((int)nativeExitCode);
                                break;
                            }
                            if (result != WAIT_TIMEOUT)
                                throw new Win32Exception(Marshal.GetLastWin32Error(), "Wait for leader");
                        }
                    }
                }
            }
            catch (Exception failure) { operationFailure = failure; }

            // Cleanup is a separate phase. No successful terminal frame is emitted from a catch/finally shortcut.
            if (job != IntPtr.Zero)
            {
                AttemptCleanup(delegate { Check(TerminateJobObject(job, 1), "TerminateJobObject"); }, ref cleanupFailure);
                AttemptCleanup(delegate { WaitForEmptyJob(job); }, ref cleanupFailure);
            }
            if (process.hProcess != IntPtr.Zero)
                AttemptCleanup(delegate { WaitForExit(process.hProcess); }, ref cleanupFailure);
            AttemptCleanup(delegate { Close(ref childInput); }, ref cleanupFailure);
            AttemptCleanup(delegate { Close(ref childOutput); }, ref cleanupFailure);
            AttemptCleanup(delegate { Close(ref childError); }, ref cleanupFailure);
            bool inputJoined = AttemptCleanup(delegate { Join(workers.Input); }, ref cleanupFailure);
            bool outputJoined = AttemptCleanup(delegate { Join(workers.Output); }, ref cleanupFailure);
            bool errorJoined = AttemptCleanup(delegate { Join(workers.Error); }, ref cleanupFailure);
            if (workers.Failure != null)
                cleanupFailure = cleanupFailure == null ? workers.Failure : new AggregateException(cleanupFailure, workers.Failure);

            // Never close a pipe underneath a worker that failed to join. OS process teardown owns
            // those handles on the error-only path; closing them here could race native HANDLE reuse.
            IntPtr[] handles = { childInput, childOutput, childError,
                inputJoined ? input.Handle : IntPtr.Zero,
                outputJoined ? output.Handle : IntPtr.Zero,
                errorJoined ? error.Handle : IntPtr.Zero,
                process.hThread, process.hProcess, job };
            foreach (IntPtr handle in handles)
            {
                if (handle == IntPtr.Zero) continue;
                if (!CloseHandle(handle) && cleanupFailure == null)
                    cleanupFailure = new Win32Exception(Marshal.GetLastWin32Error(), "Close native resource");
            }
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);

            if (cleanupFailure != null)
            {
                Frame("error\t" + Encoded(cleanupFailure.ToString()));
                return 1;
            }
            if (operationFailure != null) Frame("failure\t" + Encoded(operationFailure.ToString()));
            Frame("settled\t" + (operationFailure == null ? exitCode : -1) + "\t" +
                (workers.Cancelled.WaitOne(0) ? "1" : "0"));
            return 0;
        }
    }
}
`

// This file is written to a per-run .ps1 by the adapter, never passed on the command line.
// User executable/argv/cwd/input are read only by C# from stdin, never interpolated into PowerShell.
export const WINDOWS_JOB_SUPERVISOR_BOOTSTRAP = `
$ErrorActionPreference = 'Stop'
try {
    $source = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(WINDOWS_JOB_SUPERVISOR_SOURCE, "utf8").toString("base64")}'))
    Add-Type -TypeDefinition $source -Language CSharp | Out-Null
    $result = [Dirac.WindowsOwnership.JobSupervisor]::Run()
    exit $result
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
`
