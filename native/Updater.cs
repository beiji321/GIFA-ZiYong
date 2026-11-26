using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

internal static class Updater
{
    internal const string AppExe = "GIFA.exe";
    internal const string HelperName = "GIFA-Updater.exe";
    internal const string WorkerName = "GIFA-Update-Worker.exe";
    internal const string WorkName = ".gifa-update-work";
    internal const string StagePrefix = "GIFA-Update-";
    internal const string UninstallExe = "Uninstall GIFA.exe";
    private const string AppGuid = "9a279b0e-4f43-5a8c-8a1c-f4cd5dacd4fb";
    internal const int ManifestLimit = 64 * 1024;
    internal const long ArtifactLimit = 1024L * 1024L * 1024L;
    internal static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly Regex VersionSyntax = new Regex(@"\A(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})\z", RegexOptions.CultureInvariant);
    internal static readonly string[] PortableRoots = {
        "README-绿色版.txt", "portable.flag", "chrome_100_percent.pak", "chrome_200_percent.pak",
        "d3dcompiler_47.dll", "dxcompiler.dll", "electron_wer.dll", "ffmpeg.dll", "icudtl.dat",
        "locales", "resources.pak", "snapshot_blob.bin", "v8_context_snapshot.bin", "vk_swiftshader.dll",
        "vk_swiftshader_icd.json", "vulkan-1.dll", "resources", AppExe
    };

    [STAThread]
    private static int Main(string[] args)
    {
        WinFiles.RemoveCurrentDirectoryFromDllSearch();
        try
        {
            if (String.IsNullOrEmpty(UpdateBuildKey.Modulus) || String.IsNullOrEmpty(UpdateBuildKey.Exponent))
                throw Rejected("This build has no trusted update key.", "NO_KEY");
            using (WindowsIdentity self = WindowsIdentity.GetCurrent())
                if (!new WindowsPrincipal(self).IsInRole(WindowsBuiltInRole.Administrator))
                    throw Rejected("Updates require GIFA to be running as administrator.", "NOT_ELEVATED");
            if (args.Length == 1 && args[0] == "--worker") return RunWorker();
            if (args.Length != 7 || args[0] != "--apply") throw Rejected("Invalid updater arguments.");
            Prepare(args);
            return 0;
        }
        catch (Exception error)
        {
            try
            {
                byte[] line = Utf8.GetBytes("GIFA_UPDATE_ERROR " + ErrorCode(error) + "\r\n");
                using (Stream stderr = Console.OpenStandardError()) stderr.Write(line, 0, line.Length);
            }
            catch (IOException) { }
            return 1;
        }
    }

    internal static InvalidDataException Rejected(string explanation, string code = "PREPARE_FAILED")
    {
        InvalidDataException error = new InvalidDataException(explanation);
        error.Data["UpdateCode"] = code;
        return error;
    }

    private static string ErrorCode(Exception error)
    {
        string code = error.Data["UpdateCode"] as string;
        return code == "LEGACY_DATA" || code == "SCOPE" || code == "UNSAFE_PATH" || code == "INTERRUPTED" ||
            code == "NO_KEY" || code == "NOT_ELEVATED" || code == "BUSY" ? code : "PREPARE_FAILED";
    }

    private sealed class Job
    {
        internal string Mode, Directory, Identity, Version, Scope;
        internal uint Parent;
        internal ulong Created;

        internal void Save(string file)
        {
            WritePrivate(file, String.Join("\n", new[] { Mode, Directory, Identity, Version, Scope,
                Parent.ToString(CultureInfo.InvariantCulture), Created.ToString(CultureInfo.InvariantCulture) }));
        }

        internal static Job Load(string file)
        {
            string[] fields;
            using (FileStream input = WinFiles.ReadFile(file)) fields = Utf8.GetString(ReadLimited(input, 4096)).Split('\n');
            uint pid;
            ulong created;
            if (fields.Length != 7 || !ValidMode(fields[0]) ||
                !UInt32.TryParse(fields[5], NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid == 0 ||
                !UInt64.TryParse(fields[6], NumberStyles.None, CultureInfo.InvariantCulture, out created) || created == 0 ||
                (fields[0] == "portable" ? fields[4] != "-" : fields[4] != "/allusers" && fields[4] != "/currentuser"))
                throw Rejected("Invalid staged update job.");
            ParseVersion(fields[3]);
            return new Job { Mode = fields[0], Directory = WinFiles.FullLocalPath(fields[1]), Identity = fields[2],
                Version = fields[3], Scope = fields[4], Parent = pid, Created = created };
        }
    }

    private static bool ValidMode(string mode)
    {
        return mode == "installed" || mode == "portable";
    }

    private static string SelfPath { get { return WinFiles.FullLocalPath(typeof(Updater).Assembly.Location); } }
    private static string HelperPath(string program) { return Path.Combine(program, "resources", HelperName); }
    private static string MainPath(string program) { return Path.Combine(program, AppExe); }
    private static bool Same(string left, string right) { return String.Equals(left, right, StringComparison.OrdinalIgnoreCase); }

    private static WinFiles.PathPin ProtectProgramData(out string directory)
    {
        directory = WinFiles.FullLocalPath(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData));
        return WinFiles.PinDirectory(directory, WinFiles.Trust.Privileged, false);
    }

    private static void Prepare(string[] args)
    {
        string mode = args[1];
        uint parentId;
        if (!ValidMode(mode) || !UInt32.TryParse(args[3], NumberStyles.None, CultureInfo.InvariantCulture, out parentId) || parentId == 0)
            throw Rejected("Invalid update mode or application process ID.");
        string program = WinFiles.FullLocalPath(args[2]);
        Version current = ParseVersion(args[4]);
        if (!Same(SelfPath, HelperPath(program))) throw Rejected("The updater must run from this GIFA installation.");
        using (WinProcess parent = WinProcess.Open(parentId))
        {
            ulong created = parent.CheckParent(MainPath(program), 0);
            string scope = mode == "installed" ? FindInstalledScope(program, current) : "-";
            using (WinFiles.PathPin target = PinTarget(program, scope))
            {
                ValidateTarget(program, mode, scope, current, true);
                string common;
                using (ProtectProgramData(out common))
                {
                    if (IsInside(program, common) || IsInside(common, program))
                        throw Rejected("The program is not separate from the protected updater area.");
                    string stage = Path.Combine(common, StagePrefix + Guid.NewGuid().ToString("N"));
                    WinFiles.CreateExclusive(stage, WinFiles.Trust.Stage);
                    WinProcess worker = null;
                    bool armed = false;
                    try
                    {
                        using (WinFiles.PinDirectory(stage, WinFiles.Trust.Stage, true, WinFiles.Trust.Privileged))
                        {
                            string manifest = WinFiles.FullLocalPath(args[5]);
                            string source = WinFiles.FullLocalPath(args[6]);
                            byte[] wire;
                            using (FileStream input = WinFiles.ReadFile(manifest)) wire = ReadLimited(input, ManifestLimit);
                            Asset asset = VerifyManifest(wire, mode, current);
                            if (!String.Equals(Path.GetFileName(source), asset.Name, StringComparison.Ordinal))
                                throw Rejected("The downloaded file name does not match the signed manifest.");
                            string artifact = Path.Combine(stage, asset.Name);
                            using (FileStream input = WinFiles.ReadFile(source)) CheckAsset(input, asset, artifact);
                            WritePrivate(Path.Combine(stage, "manifest.json"), wire);
                            if (mode == "installed") CheckSetup(artifact, asset.Version);
                            else
                            {
                                string payload = Path.Combine(stage, "payload");
                                WinFiles.CreateExclusive(payload, WinFiles.Trust.Stage);
                                using (FileStream input = WinFiles.ReadFile(artifact)) PortableZip.Extract(input, payload, true);
                                CheckVersion(MainPath(payload), asset.Version);
                            }
                            string workerFile = Path.Combine(stage, WorkerName);
                            using (FileStream input = WinFiles.ReadFile(SelfPath))
                            using (FileStream output = NewFile(workerFile, WinFiles.Trust.Stage)) { input.CopyTo(output); output.Flush(true); }
                            new Job { Mode = mode, Directory = program, Identity = target.Identity, Scope = scope,
                                Version = args[4], Parent = parentId, Created = created }.Save(Path.Combine(stage, "job"));
                            parent.CheckParent(MainPath(program), created);
                            worker = WinProcess.Start(workerFile, "--worker", stage, true);
                            string ready = Path.Combine(stage, "ready");
                            Stopwatch timer = Stopwatch.StartNew();
                            while (!Directory.Exists(ready))
                            {
                                if (worker.Wait(75))
                                {
                                    string failure = Path.Combine(stage, "error");
                                    if (!File.Exists(failure)) throw Rejected("The update worker could not start.");
                                    using (FileStream input = WinFiles.ReadFile(failure))
                                        throw Rejected("The update worker rejected this request.", Utf8.GetString(ReadLimited(input, 64)));
                                }
                                if (timer.ElapsedMilliseconds >= 30000) throw Rejected("The update worker did not become ready.");
                            }
                            if (worker.Wait(0)) throw Rejected("The update worker exited before handoff.");
                            WinFiles.CreateExclusive(Path.Combine(stage, "go"), WinFiles.Trust.Stage);
                            armed = true;
                        }
                    }
                    finally
                    {
                        if (worker != null)
                        {
                            if (!armed && !worker.Wait(0)) worker.StopUnarmed();
                            worker.Dispose();
                        }
                        if (!armed) TryDeleteTree(stage);
                    }
                }
            }
        }
    }

    private static int RunWorker()
    {
        string self = SelfPath;
        string stage = Path.GetDirectoryName(self);
        string common;
        using (ProtectProgramData(out common))
        {
            if (!Same(Path.GetDirectoryName(stage), common) || Path.GetFileName(self) != WorkerName ||
                !Regex.IsMatch(Path.GetFileName(stage), @"\AGIFA-Update-[0-9a-f]{32}\z", RegexOptions.CultureInvariant))
                throw Rejected("The worker is not in its protected update staging directory.");
            bool armed = false;
            bool keepStage = false;
            using (WinFiles.PinDirectory(stage, WinFiles.Trust.Stage, true, WinFiles.Trust.Privileged))
            {
                try
                {
                    Job job = Job.Load(Path.Combine(stage, "job"));
                    RunJob(job, stage, ref armed, ref keepStage);
                    return 0;
                }
                catch (Exception error)
                {
                    if (!armed)
                    {
                        try { WritePrivate(Path.Combine(stage, "error"), ErrorCode(error)); } catch (IOException) { }
                    }
                    else ShowFailure(error.Message);
                    return 1;
                }
                finally
                {
                    if (armed && !keepStage) FinishStage(stage, self);
                }
            }
        }
    }

    private static void RunJob(Job job, string stage, ref bool armed, ref bool keepStage)
    {
        Version current = ParseVersion(job.Version);
        bool parentExited = false;
        bool mayRelaunch = true;
        bool completed = false;
        string program = job.Directory;
        string exe = MainPath(program);
        using (Mutex gate = AcquireGate(job.Identity, job.Mode))
        using (WinProcess parent = WinProcess.Open(job.Parent))
        {
            try
            {
                Asset asset;
                using (FileStream input = WinFiles.ReadFile(Path.Combine(stage, "manifest.json")))
                    asset = VerifyManifest(ReadLimited(input, ManifestLimit), job.Mode, current);
                string artifact = Path.Combine(stage, asset.Name);
                using (FileStream input = WinFiles.ReadFile(artifact)) CheckAsset(input, asset, null);
                using (WinFiles.PathPin target = PinTarget(program, job.Scope))
                {
                    CheckIdentity(target, job.Identity);
                    ValidateTarget(program, job.Mode, job.Scope, current, true);
                    parent.CheckParent(exe, job.Created);
                    WinFiles.CreateExclusive(Path.Combine(stage, "ready"), WinFiles.Trust.Stage);
                    Stopwatch timer = Stopwatch.StartNew();
                    while (!Directory.Exists(Path.Combine(stage, "go")))
                    {
                        if (timer.ElapsedMilliseconds >= 35000) throw Rejected("Update handoff was cancelled.");
                        Thread.Sleep(50);
                    }
                    armed = true;
                    if (!parent.Wait(120000)) throw Rejected("GIFA did not exit in time. The update was not installed.");
                    parentExited = true;
                    WaitForAppProcesses(program, job.Mode == "installed", 15000);
                    ValidateTarget(program, job.Mode, job.Scope, current, true);
                    if (job.Mode == "portable")
                    {
                        string payload = Path.Combine(stage, "payload");
                        using (WinFiles.PinDirectory(payload, WinFiles.Trust.Stage, true, WinFiles.Trust.Privileged))
                            PublishPortable(program, payload, true, delegate
                            {
                                ValidateTarget(program, job.Mode, job.Scope, asset.Version, false);
                            });
                    }
                }
                if (job.Mode == "installed")
                {
                    using (WinFiles.PathPin parentDirectory = WinFiles.PinDirectory(Path.GetDirectoryName(program), TargetTrust(job.Scope), false))
                    {
                        mayRelaunch = false;
                        using (FileStream pinnedSetup = WinFiles.ReadFile(artifact))
                        using (WinProcess setup = WinProcess.Start(artifact, "--updated /S " + job.Scope, stage, false))
                        {
                            const uint FifteenMinutes = 15 * 60 * 1000;
                            if (!setup.Wait(FifteenMinutes))
                            {
                                keepStage = true;
                                ShowFailure("The installer has not finished. Do not run a second installer.\n\n" + artifact);
                                setup.Wait(UInt32.MaxValue);
                            }
                            mayRelaunch = true;
                            if (setup.ExitCode != 0)
                            {
                                keepStage = true;
                                throw Rejected("The installer exited with code " + setup.ExitCode + ". To repair GIFA, run the verified installer at:\n" + artifact);
                            }
                        }
                        using (PinTarget(program, job.Scope)) ValidateTarget(program, job.Mode, job.Scope, asset.Version, false);
                    }
                }
                completed = true;
                using (PinTarget(program, job.Scope)) LaunchGifa(program, true);
            }
            catch (Exception error)
            {
                string detail = error.Message;
                if (parentExited && mayRelaunch && !completed)
                {
                    try
                    {
                        using (WinFiles.PathPin target = PinTarget(program, job.Scope))
                        {
                            CheckIdentity(target, job.Identity);
                            ValidateTarget(program, job.Mode, job.Scope, current, true);
                            WaitForAppProcesses(program, false, 0);
                            LaunchGifa(program, false);
                        }
                        detail += "\n\nThe previous version was restarted.";
                    }
                    catch (Exception) { }
                }
                if (completed) detail = "GIFA was updated, but could not restart. Start GIFA.exe manually.\n\n" + detail;
                throw Rejected(detail);
            }
            finally { gate.ReleaseMutex(); }
        }
    }

    private static void ValidateTarget(string program, string mode, string scope, Version version, bool beforeUpdate)
    {
        WinFiles.Trust trust = TargetTrust(scope);
        string expectedMarker = mode + ".flag";
        string contrary = (mode == "installed" ? "portable" : "installed") + ".flag";
        if (WinFiles.Exists(Path.Combine(program, contrary))) throw Rejected("The install mode markers conflict.");
        CheckMarker(Path.Combine(program, expectedMarker), mode, trust);
        WinFiles.CheckFile(MainPath(program), trust);
        CheckVersion(MainPath(program), version);
        WinFiles.CheckFile(HelperPath(program), trust);
        WinFiles.CheckFile(Path.Combine(program, "resources", "app.asar"), trust);
        if (beforeUpdate && WinFiles.Exists(Path.Combine(program, WorkName)))
            throw Rejected("An interrupted update was found. Keep its backup files and inspect " + Path.Combine(program, WorkName), "INTERRUPTED");
        int remaining = 20000;
        if (mode == "installed")
        {
            if (WinFiles.Exists(Path.Combine(program, "data")))
                throw Rejected("Move the data directory out of the NSIS installation before updating.", "LEGACY_DATA");
            if (FindInstalledScope(program, version) != scope) throw Rejected("The NSIS installation scope changed.", "SCOPE");
            WinFiles.CheckFile(Path.Combine(program, UninstallExe), trust);
            foreach (string child in Directory.GetFileSystemEntries(program)) WinFiles.CheckTree(child, trust, ref remaining);
        }
        else
        {
            foreach (string entry in PortableRoots)
            {
                string child = Path.Combine(program, entry);
                if (!WinFiles.Exists(child)) continue;
                WinFiles.CheckKind(child, RuntimeDirectory(entry));
                WinFiles.CheckTree(child, trust, ref remaining);
            }
            if (WinFiles.Exists(Path.Combine(program, "data")))
                using (WinFiles.PinDirectory(Path.Combine(program, "data"), trust, false)) { }
        }
    }

    private static void CheckIdentity(WinFiles.PathPin target, string expected)
    {
        if (target.Identity != expected) throw Rejected("The GIFA program directory changed during preparation.");
    }

    private static WinFiles.Trust TargetTrust(string scope)
    {
        return scope == "/allusers" ? WinFiles.Trust.Privileged : WinFiles.Trust.Owner;
    }

    private static WinFiles.PathPin PinTarget(string program, string scope)
    {
        if (program.Length < 4 || program.Length > 200 ||
            (scope != "-" && program.IndexOfAny(new[] { '\'', '\u2018', '\u2019', '\u201a', '\u201b' }) >= 0))
            throw Rejected("The installation path is not safe for updating.", "UNSAFE_PATH");
        try { return WinFiles.PinDirectory(program, TargetTrust(scope), true); }
        catch (InvalidDataException error) { throw Rejected(error.Message, "UNSAFE_PATH"); }
    }

    private static bool IsInside(string path, string root)
    {
        return path != null && (Same(path, root) || path.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase));
    }

    private static void WaitForAppProcesses(string program, bool checkOtherInstallations, int timeout)
    {
        Stopwatch timer = Stopwatch.StartNew();
        for (;;)
        {
            bool found = false;
            foreach (Process candidate in Process.GetProcesses())
            using (candidate)
            {
                string name;
                try { name = candidate.ProcessName; }
                catch (InvalidOperationException) { continue; }
                bool isApp = Same(name, "GIFA") || Same(name, "GIFA.Gamepad");
                bool isSetup = checkOtherInstallations && Regex.IsMatch(name, @"\AGIFA-[0-9.]+-Setup\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
                if (!isApp && !isSetup) continue;
                if (checkOtherInstallations) { found = true; continue; }
                string image;
                if (!WinProcess.TryImage((uint)candidate.Id, out image) || IsInside(image, program)) found = true;
            }
            if (!found) return;
            if (timer.ElapsedMilliseconds >= timeout) throw Rejected("Close other GIFA windows and installers before updating.");
            Thread.Sleep(150);
        }
    }

    private static void LaunchGifa(string program, bool updated)
    {
        string exe = MainPath(program);
        using (FileStream pinned = WinFiles.ReadFile(exe))
        using (WinProcess started = WinProcess.Start(exe, updated ? "--gifa-updated" : "", program, false)) { }
    }

    internal sealed class Registration
    {
        internal bool Exists;
        internal string Location, Uninstall, Version;
    }

    private static Registration ReadRegistration(RegistryHive hive)
    {
        using (RegistryKey root = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64))
        using (RegistryKey product = root.OpenSubKey(@"Software\" + AppGuid))
        using (RegistryKey uninstall = root.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + AppGuid))
            return new Registration { Exists = product != null || uninstall != null,
                Location = RegistryString(product, "InstallLocation"), Uninstall = RegistryString(uninstall, "UninstallString"),
                Version = RegistryString(uninstall, "DisplayVersion") };
    }

    private static string RegistryString(RegistryKey key, string value)
    {
        return key == null ? null : key.GetValue(value, null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
    }

    private static string FindInstalledScope(string program, Version version)
    {
        return SelectScope(program, version, ReadRegistration(RegistryHive.CurrentUser), ReadRegistration(RegistryHive.LocalMachine));
    }

    internal static string SelectScope(string program, Version version, Registration user, Registration machine)
    {
        bool userPath = Same(user.Location, program);
        bool machinePath = Same(machine.Location, program);
        if (userPath == machinePath) throw Rejected("The program path has no unambiguous GIFA NSIS registration.", "SCOPE");
        if (machinePath && user.Exists)
            throw Rejected("A separate per-user GIFA registration prevents updating the all-users install safely.", "SCOPE");
        string scope = userPath ? "/currentuser" : "/allusers";
        Registration selected = userPath ? user : machine;
        string expected = "\"" + Path.Combine(program, UninstallExe) + "\" " + scope;
        if (!selected.Exists || !Same(selected.Uninstall, expected) || selected.Version != version.ToString(3))
            throw Rejected("The GIFA NSIS uninstall registration does not match the running installation.", "SCOPE");
        return scope;
    }

    private static Mutex AcquireGate(string identity, string mode)
    {
        string name = @"Global\GIFA-Update-" + (mode == "installed" ? AppGuid : identity);
        MutexSecurity security = new MutexSecurity();
        security.SetAccessRuleProtection(true, false);
        foreach (SecurityIdentifier sid in WinFiles.PrivilegedSids)
            security.AddAccessRule(new MutexAccessRule(sid, MutexRights.FullControl, AccessControlType.Allow));
        bool created;
        Mutex gate = new Mutex(false, name, out created, security);
        try
        {
            try { if (!gate.WaitOne(0)) throw Rejected("Another update is already in progress.", "BUSY"); }
            catch (AbandonedMutexException) { }
            return gate;
        }
        catch { gate.Dispose(); throw; }
    }

    internal static Version ParseVersion(string text)
    {
        if (text == null || !VersionSyntax.IsMatch(text)) throw Rejected("Invalid stable update version.");
        string[] parts = text.Split('.');
        ushort major, minor, patch;
        if (!UInt16.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out major) ||
            !UInt16.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out minor) ||
            !UInt16.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out patch))
            throw Rejected("The stable version is outside the Windows version range.");
        return new Version(major, minor, patch);
    }

    private static void CheckSetup(string installer, Version expected)
    {
        using (FileStream input = WinFiles.ReadFile(installer))
        using (BinaryReader binary = new BinaryReader(input))
        {
            if (input.Length < 64 || binary.ReadUInt16() != 0x5a4d) throw Rejected("The signed setup is not a Windows executable.");
            input.Position = 60;
            uint header = binary.ReadUInt32();
            if (header < 64 || header + 24L > input.Length) throw Rejected("Invalid setup executable header.");
            input.Position = header;
            if (binary.ReadUInt32() != 0x00004550) throw Rejected("Invalid setup executable signature.");
            ushort machine = binary.ReadUInt16();
            input.Position = header + 22;
            ushort characteristics = binary.ReadUInt16();
            if ((machine != 0x014c && machine != 0x8664) || (characteristics & 0x2002) != 2)
                throw Rejected("The signed setup is not a supported NSIS executable.");
        }
        CheckVersion(installer, expected);
    }

    internal static void CheckVersion(string image, Version expected)
    {
        using (FileStream pinned = WinFiles.ReadFile(image))
        {
            FileVersionInfo info = FileVersionInfo.GetVersionInfo(image);
            if (info.FileMajorPart != expected.Major || info.FileMinorPart != expected.Minor ||
                info.FileBuildPart != expected.Build || info.FilePrivatePart != 0 || String.IsNullOrEmpty(info.FileVersion))
                throw Rejected("GIFA.exe does not have the expected file version " + expected.ToString(3) + ".");
        }
    }

    internal static void CheckMarker(string marker, string expected, WinFiles.Trust trust)
    {
        WinFiles.CheckFile(marker, trust);
        using (FileStream input = WinFiles.ReadFile(marker))
        using (StringReader text = new StringReader(Utf8.GetString(ReadLimited(input, 4096))))
            if (text.ReadLine() != expected) throw Rejected("The GIFA distribution marker is not valid.");
    }

    internal sealed class Asset
    {
        internal string Name, Sha256;
        internal long Size;
        internal Version Version;
    }

    internal static Asset VerifyManifest(byte[] wire, string mode, Version current)
    {
        if (wire == null || wire.Length == 0 || wire.Length > ManifestLimit || !ValidMode(mode))
            throw Rejected("Invalid release manifest size or update mode.");
        Dictionary<string, object> envelope = WireJson.Parse(wire);
        ExactFields(envelope, "payload", "signature");
        byte[] payload = CanonicalBase64(FieldString(envelope, "payload"));
        byte[] signature = CanonicalBase64(FieldString(envelope, "signature"));
        if (payload.Length > ManifestLimit) throw Rejected("The signed manifest exceeds its size limit.");
        RSAParameters key = new RSAParameters { Modulus = CanonicalBase64(UpdateBuildKey.Modulus), Exponent = CanonicalBase64(UpdateBuildKey.Exponent) };
        using (RSACryptoServiceProvider rsa = new RSACryptoServiceProvider(new CspParameters(24) { Flags = CspProviderFlags.CreateEphemeralKey }))
        {
            rsa.ImportParameters(key);
            if (rsa.KeySize < 2048 || signature.Length != (rsa.KeySize + 7) / 8 ||
                !rsa.VerifyData(payload, CryptoConfig.MapNameToOID("SHA256"), signature))
                throw Rejected("The release manifest signature is not valid.");
        }
        Dictionary<string, object> manifest = WireJson.Parse(payload);
        ExactFields(manifest, "schema", "version", "artifacts");
        if (!(manifest["schema"] is long) || (long)manifest["schema"] != 1) throw Rejected("Unknown release manifest schema.");
        string text = FieldString(manifest, "version");
        Version version = ParseVersion(text);
        if (version.CompareTo(current) <= 0) throw Rejected("The release is not newer than the installed version.");
        Dictionary<string, object> artifacts = AsObject(manifest["artifacts"]);
        ExactFields(artifacts, "installed", "portable");
        Asset setup = ReadAsset(AsObject(artifacts["installed"]), "GIFA-" + text + "-Setup.exe", version);
        Asset zip = ReadAsset(AsObject(artifacts["portable"]), "GIFA-" + text + "-win-x64.zip", version);
        return mode == "installed" ? setup : zip;
    }

    private static Asset ReadAsset(Dictionary<string, object> item, string expected, Version version)
    {
        ExactFields(item, "name", "size", "sha256");
        string name = FieldString(item, "name");
        string sha256 = FieldString(item, "sha256");
        if (name != expected || !(item["size"] is long) || (long)item["size"] <= 0 || (long)item["size"] > ArtifactLimit ||
            !Regex.IsMatch(sha256, @"\A[0-9a-f]{64}\z", RegexOptions.CultureInvariant)) throw Rejected("Invalid signed artifact metadata.");
        return new Asset { Name = name, Sha256 = sha256, Size = (long)item["size"], Version = version };
    }

    private static Dictionary<string, object> AsObject(object value)
    {
        Dictionary<string, object> record = value as Dictionary<string, object>;
        if (record == null) throw Rejected("Expected an object in the release manifest.");
        return record;
    }

    private static void ExactFields(Dictionary<string, object> record, params string[] fields)
    {
        if (record.Count != fields.Length) throw Rejected("Unexpected release manifest fields.");
        foreach (string field in fields) if (!record.ContainsKey(field)) throw Rejected("Missing release manifest field: " + field);
    }

    private static string FieldString(Dictionary<string, object> record, string field)
    {
        string text = record[field] as string;
        if (String.IsNullOrEmpty(text)) throw Rejected("Missing release manifest string: " + field);
        return text;
    }

    private static byte[] CanonicalBase64(string text)
    {
        if (String.IsNullOrEmpty(text)) throw Rejected("The update key or manifest encoding is missing.");
        byte[] decoded = Convert.FromBase64String(text);
        if (Convert.ToBase64String(decoded) != text) throw Rejected("The update key or manifest is not canonical Base64.");
        return decoded;
    }

    internal static byte[] ReadLimited(Stream input, int maximum)
    {
        using (MemoryStream collected = new MemoryStream())
        {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.Read(buffer, 0, Math.Min(buffer.Length, maximum + 1 - (int)collected.Length))) != 0)
            {
                collected.Write(buffer, 0, count);
                if (collected.Length > maximum) throw Rejected("An update metadata file exceeds its size limit.");
            }
            return collected.ToArray();
        }
    }

    internal static void CheckAsset(FileStream input, Asset expected, string destination, WinFiles.Trust trust = WinFiles.Trust.Stage)
    {
        if (input.Length != expected.Size || input.Length > ArtifactLimit) throw Rejected("The downloaded artifact size does not match.");
        using (SHA256 hash = SHA256.Create())
        using (FileStream output = destination == null ? null : NewFile(destination, trust))
        {
            byte[] buffer = new byte[128 * 1024];
            long copied = 0;
            int count;
            while ((count = input.Read(buffer, 0, buffer.Length)) != 0)
            {
                copied += count;
                if (copied > expected.Size) throw Rejected("The update artifact grew while copying.");
                hash.TransformBlock(buffer, 0, count, buffer, 0);
                if (output != null) output.Write(buffer, 0, count);
            }
            hash.TransformFinalBlock(new byte[0], 0, 0);
            if (copied != expected.Size || BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant() != expected.Sha256)
                throw Rejected("The downloaded artifact SHA-256 does not match.");
            if (output != null) output.Flush(true);
        }
    }

    internal static FileStream NewFile(string path, WinFiles.Trust trust = WinFiles.Trust.Inherit)
    {
        return WinFiles.CreateExclusiveFile(path, trust);
    }

    private static void WritePrivate(string file, string text, WinFiles.Trust trust = WinFiles.Trust.Stage) { WritePrivate(file, Utf8.GetBytes(text), trust); }

    private static void WritePrivate(string file, byte[] data, WinFiles.Trust trust = WinFiles.Trust.Stage)
    {
        using (FileStream output = NewFile(file, trust)) { output.Write(data, 0, data.Length); output.Flush(true); }
    }

    internal static bool RuntimeDirectory(string name) { return name == "locales" || name == "resources"; }

    internal static void PublishPortable(string program, string payload, bool protect, Action verify)
    {
        string work = Path.Combine(program, WorkName);
        WinFiles.Trust privateTrust = protect ? WinFiles.Trust.Stage : WinFiles.Trust.Inherit;
        WinFiles.Trust runtimeTrust = protect ? WinFiles.Trust.Runtime : WinFiles.Trust.Inherit;
        WinFiles.CreateExclusive(work, privateTrust);
        string backup = Path.Combine(work, "old");
        string replacement = Path.Combine(work, "new");
        List<string> oldMoves = new List<string>(PortableRoots.Length);
        List<string> newMoves = new List<string>(PortableRoots.Length);
        bool restored = true;
        WinFiles.PathPin workPin = null;
        try
        {
            workPin = WinFiles.PinDirectory(work, privateTrust, protect, protect ? WinFiles.Trust.Owner : WinFiles.Trust.Inherit);
            WinFiles.CreateExclusive(backup, privateTrust);
            WinFiles.CreateExclusive(replacement, runtimeTrust);
            foreach (string name in PortableRoots)
                CopyRuntime(Path.Combine(payload, name), Path.Combine(replacement, name), RuntimeDirectory(name), runtimeTrust);
            WritePrivate(Path.Combine(work, "recovery.txt"), "GIFA portable update. Keep data and unrelated files unchanged.\r\n" +
                "If interrupted, old contains the previous runtime entries; new contains entries not yet installed.\r\n" + String.Join("\r\n", PortableRoots), privateTrust);
            foreach (string name in PortableRoots)
            {
                string destination = Path.Combine(program, name);
                if (WinFiles.Exists(destination))
                {
                    bool isDirectory = RuntimeDirectory(name);
                    if (protect)
                    {
                        int remaining = 20000;
                        WinFiles.CheckTree(destination, WinFiles.Trust.Owner, ref remaining);
                    }
                    WinFiles.CheckKind(destination, isDirectory);
                    WinFiles.Move(destination, Path.Combine(backup, name));
                    oldMoves.Add(name);
                }
                WinFiles.Move(Path.Combine(replacement, name), destination);
                newMoves.Add(name);
            }
            verify();
        }
        catch (Exception error)
        {
            for (int index = newMoves.Count - 1; index >= 0; index--)
            {
                string name = newMoves[index];
                try { WinFiles.Move(Path.Combine(program, name), Path.Combine(replacement, name)); }
                catch (Exception) { restored = false; }
            }
            for (int index = oldMoves.Count - 1; index >= 0; index--)
            {
                string name = oldMoves[index];
                try { WinFiles.Move(Path.Combine(backup, name), Path.Combine(program, name)); }
                catch (Exception) { restored = false; }
            }
            if (!restored) throw Rejected("Automatic rollback was incomplete. Previous files were kept in " + backup + "\n\n" + error.Message);
            throw;
        }
        finally
        {
            if (workPin != null)
            {
                if (restored) foreach (string entry in Directory.GetFileSystemEntries(work)) TryDeleteTree(entry);
                workPin.Dispose();
                if (restored) TryDeleteEmptyDirectory(work);
            }
        }
    }

    private static void CopyRuntime(string source, string destination, bool directory, WinFiles.Trust trust)
    {
        if (directory)
        {
            WinFiles.CheckKind(source, true);
            WinFiles.CreateExclusive(destination, trust);
            foreach (string entry in Directory.GetFileSystemEntries(source))
                CopyRuntime(entry, Path.Combine(destination, Path.GetFileName(entry)), (File.GetAttributes(entry) & FileAttributes.Directory) != 0, trust);
        }
        else
        {
            using (FileStream input = WinFiles.ReadFile(source))
            using (FileStream output = NewFile(destination, trust)) { input.CopyTo(output); output.Flush(true); }
        }
    }

    private static void TryDeleteEmptyDirectory(string path)
    {
        try { Directory.Delete(path, false); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static void TryDeleteTree(string root)
    {
        try
        {
            FileAttributes info = File.GetAttributes(root);
            if ((info & FileAttributes.Directory) != 0)
            {
                if ((info & FileAttributes.ReparsePoint) == 0)
                    foreach (string child in Directory.GetFileSystemEntries(root)) TryDeleteTree(child);
                Directory.Delete(root, false);
            }
            else File.Delete(root);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static void FinishStage(string stage, string self)
    {
        try
        {
            foreach (string entry in Directory.GetFileSystemEntries(stage)) if (!Same(entry, self)) TryDeleteTree(entry);
            WinFiles.DeleteOnReboot(self);
            WinFiles.DeleteOnReboot(stage);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static string Truncate(string message, int max) { return message.Length > max ? message.Substring(0, max) : message; }

    private static void ShowFailure(string message)
    {
        try { MessageBox.Show("原神跟跑助手更新未完成。\n\n" + Truncate(message, 2048), "GIFA 更新", MessageBoxButtons.OK,
            MessageBoxIcon.Error, MessageBoxDefaultButton.Button1, MessageBoxOptions.DefaultDesktopOnly); }
        catch (Exception) { }
    }
}

internal static class WinFiles
{
    internal enum Trust { Inherit, Owner, Privileged, Stage, Runtime }
    private const uint ShareRead = 1, ShareWrite = 2, ShareDelete = 4;
    private const uint ReadAttributes = 0x80, GenericRead = 0x80000000;
    private const uint OpenExisting = 3, OpenReparsePoint = 0x00200000, BackupSemantics = 0x02000000;
    private const int FileNotFound = 2, PathNotFound = 3;
    private const uint InvalidAttributes = UInt32.MaxValue;
    internal static readonly SecurityIdentifier[] PrivilegedSids = {
        new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
        new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null)
    };
    private static readonly SecurityIdentifier Servicing = new SecurityIdentifier("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");
    private static readonly SecurityIdentifier Users = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
    private static readonly SecurityIdentifier CurrentUser = GetCurrentUser();
    private static readonly Regex DeviceName = new Regex(@"\A(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9¹²³])\z",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static SecurityIdentifier GetCurrentUser()
    {
        using (WindowsIdentity self = WindowsIdentity.GetCurrent()) return self.User;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInformation
    {
        internal uint Attributes;
        internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
        internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr Descriptor;
        internal int Inherit;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr attributes, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateDirectoryW(string path, IntPtr security);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int infoClass, out uint info, uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributesW(string path);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileExW(string source, string destination, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern bool SetDllDirectoryW(string directory);

    internal static void RemoveCurrentDirectoryFromDllSearch() { SetDllDirectoryW(""); }

    internal static Win32Exception LastError(string operation)
    {
        int code = Marshal.GetLastWin32Error();
        return new Win32Exception(code, operation + ": " + new Win32Exception(code).Message);
    }

    internal static string FullLocalPath(string path)
    {
        if (path == null || path.Length < 3 || path.Length > 259 || path[1] != ':' || path[2] != '\\' ||
            !((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')))
            throw Updater.Rejected("Update paths must be absolute local Windows paths.");
        if (path.Length > 3)
            foreach (string part in path.Substring(3).Split('\\')) CheckSegment(part);
        if (!String.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase))
            throw Updater.Rejected("An update path is not canonical.");
        return path;
    }

    internal static void CheckSegment(string part)
    {
        if (String.IsNullOrEmpty(part) || part.Length > 255 || part.EndsWith(".", StringComparison.Ordinal) ||
            part.EndsWith(" ", StringComparison.Ordinal) || part.IndexOfAny(new[] { '<', '>', ':', '"', '/', '\\', '|', '?', '*', '~' }) >= 0 ||
            DeviceName.IsMatch(part.Split('.')[0].TrimEnd(' '))) throw Updater.Rejected("An update path has an unsafe Windows file name.");
        foreach (char character in part)
            if (character < 32 || character == 127) throw Updater.Rejected("An update path has a control character.");
    }

    internal sealed class PathPin : IDisposable
    {
        internal readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();
        internal string Identity;
        public void Dispose()
        {
            for (int index = Handles.Count - 1; index >= 0; index--) Handles[index].Dispose();
        }
    }

    internal static PathPin PinDirectory(string path, Trust trust, bool strictLeaf)
    {
        return PinDirectory(path, trust, strictLeaf, trust);
    }

    internal static PathPin PinDirectory(string path, Trust trust, bool strictLeaf, Trust ancestorTrust)
    {
        FullLocalPath(path);
        string root = path.Substring(0, 3);
        DriveInfo drive = new DriveInfo(root);
        if ((drive.DriveType != DriveType.Fixed && drive.DriveType != DriveType.Removable) ||
            !String.Equals(drive.DriveFormat, "NTFS", StringComparison.OrdinalIgnoreCase))
            throw Updater.Rejected("GIFA updates require a local NTFS volume.");
        string current = root;
        string[] parts = path.Length == 3 ? new string[0] : path.Substring(3).Split('\\');
        PathPin pins = new PathPin();
        try
        {
            for (int index = 0; index <= parts.Length; index++)
            {
                if (index != 0) current = Path.Combine(current, parts[index - 1]);
                SafeFileHandle handle = Open(current, ReadAttributes, ShareRead | ShareWrite, true);
                pins.Handles.Add(handle);
                FileInformation info = Inspect(handle, current, true);
                if (index == parts.Length)
                {
                    CheckAcl(current, true, trust, strictLeaf);
                    pins.Identity = info.Volume.ToString("x8") + info.IndexHigh.ToString("x8") + info.IndexLow.ToString("x8");
                }
                else CheckAcl(current, true, ancestorTrust, false);
            }
            return pins;
        }
        catch { pins.Dispose(); throw; }
    }

    private static SafeFileHandle Open(string path, uint access, uint share, bool directory)
    {
        SafeFileHandle handle = CreateFileW(path, access, share, IntPtr.Zero, OpenExisting,
            OpenReparsePoint | (directory ? BackupSemantics : 0), IntPtr.Zero);
        if (!handle.IsInvalid) return handle;
        Win32Exception error = LastError("Cannot open " + path);
        handle.Dispose();
        throw error;
    }

    private static FileInformation Inspect(SafeFileHandle handle, string path, bool directory)
    {
        FileInformation info;
        if (!GetFileInformationByHandle(handle, out info)) throw LastError("Cannot verify " + path);
        FileAttributes attributes = (FileAttributes)info.Attributes;
        if ((attributes & FileAttributes.ReparsePoint) != 0 || ((attributes & FileAttributes.Directory) != 0) != directory ||
            (!directory && info.Links != 1)) throw Updater.Rejected("A GIFA update path is a link or has the wrong type: " + path);
        StringBuilder actual = new StringBuilder(1024);
        uint length = GetFinalPathNameByHandleW(handle, actual, (uint)actual.Capacity, 0);
        if (length == 0 || length >= actual.Capacity || !String.Equals(actual.ToString(), @"\\?\" + path, StringComparison.OrdinalIgnoreCase))
            throw Updater.Rejected("A GIFA update path resolves to a different location: " + path);
        if (directory)
        {
            uint caseFlags;
            if (GetFileInformationByHandleEx(handle, 23, out caseFlags, 4))
            {
                if (caseFlags != 0) throw Updater.Rejected("Case-sensitive update directories are not supported: " + path);
            }
            else
            {
                int error = Marshal.GetLastWin32Error();
                if (error != 1 && error != 50 && error != 87) throw LastError("Cannot verify directory case policy");
            }
        }
        return info;
    }

    internal static FileStream ReadFile(string path)
    {
        FullLocalPath(path);
        using (PinDirectory(Path.GetDirectoryName(path), Trust.Inherit, false))
        {
            SafeFileHandle handle = Open(path, GenericRead, ShareRead, false);
            try
            {
                Inspect(handle, path, false);
                return new FileStream(handle, FileAccess.Read, 128 * 1024);
            }
            catch { handle.Dispose(); throw; }
        }
    }

    private static bool IsTrusted(SecurityIdentifier sid, Trust trust)
    {
        return sid == PrivilegedSids[0] || sid == PrivilegedSids[1] || (trust != Trust.Stage && sid == Servicing) ||
            ((trust == Trust.Owner || trust == Trust.Runtime) && sid == CurrentUser);
    }

    private static void CheckAcl(string path, bool directory, Trust trust, bool strict)
    {
        if (trust == Trust.Inherit) return;
        const int GenericAll = 0x10000000, GenericWrite = 0x40000000;
        const FileSystemRights ChangePath = FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.Delete |
            FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        const FileSystemRights ChangeContents = FileSystemRights.WriteData | FileSystemRights.AppendData |
            FileSystemRights.WriteExtendedAttributes | FileSystemRights.WriteAttributes;
        FileSystemSecurity security = directory ? (FileSystemSecurity)Directory.GetAccessControl(path, AccessControlSections.Owner | AccessControlSections.Access) :
            File.GetAccessControl(path, AccessControlSections.Owner | AccessControlSections.Access);
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
        if (descriptor.Owner == null || !IsTrusted(descriptor.Owner, trust) || descriptor.DiscretionaryAcl == null)
            throw Updater.Rejected("The owner or permissions are not trusted for " + path);
        int dangerous = (int)(ChangePath | (strict ? ChangeContents : 0)) | GenericAll | (strict ? GenericWrite : 0);
        foreach (GenericAce entry in descriptor.DiscretionaryAcl)
        {
            if ((entry.AceFlags & AceFlags.InheritOnly) != 0) continue;
            QualifiedAce rule = entry as QualifiedAce;
            if (rule == null) throw Updater.Rejected("Unsupported access control at " + path);
            if (rule.AceQualifier != AceQualifier.AccessAllowed || IsTrusted(rule.SecurityIdentifier, trust)) continue;
            if ((rule.AccessMask & dangerous) != 0) throw Updater.Rejected("Another account can modify the update path: " + path);
        }
    }

    internal static void CheckFile(string path, Trust trust)
    {
        using (ReadFile(path)) CheckAcl(path, false, trust, true);
    }

    internal static void CheckTree(string path, Trust trust, ref int remaining)
    {
        if (--remaining < 0) throw Updater.Rejected("The existing runtime tree is unexpectedly large.");
        FileAttributes state = File.GetAttributes(path);
        if ((state & FileAttributes.ReparsePoint) != 0) throw Updater.Rejected("An existing runtime path is a reparse point: " + path);
        if ((state & FileAttributes.Directory) == 0) { CheckFile(path, trust); return; }
        using (PinDirectory(path, trust, true))
            foreach (string child in Directory.GetFileSystemEntries(path)) CheckTree(child, trust, ref remaining);
    }

    internal static bool Exists(string path)
    {
        uint attributes = GetFileAttributesW(path);
        if (attributes != InvalidAttributes) return true;
        int error = Marshal.GetLastWin32Error();
        if (error == FileNotFound || error == PathNotFound) return false;
        throw LastError("Cannot inspect " + path);
    }

    internal static void CheckKind(string path, bool directory)
    {
        using (SafeFileHandle handle = Open(path, ReadAttributes, ShareRead | ShareWrite | ShareDelete, directory))
            Inspect(handle, path, directory);
    }

    internal static void CreateExclusive(string path, Trust trust)
    {
        FullLocalPath(path);
        WithAcl(trust, true, delegate(IntPtr security)
        {
            if (!CreateDirectoryW(path, security)) throw LastError("Cannot create the update directory " + path);
            return true;
        });
    }

    internal static FileStream CreateExclusiveFile(string path, Trust trust)
    {
        FullLocalPath(path);
        return WithAcl(trust, false, delegate(IntPtr security)
        {
            const uint GenericWrite = 0x40000000, CreateNew = 1;
            SafeFileHandle handle = CreateFileW(path, GenericWrite, 0, security, CreateNew, OpenReparsePoint, IntPtr.Zero);
            if (handle.IsInvalid)
            {
                Win32Exception error = LastError("Cannot create the update file " + path);
                handle.Dispose();
                throw error;
            }
            try { return new FileStream(handle, FileAccess.Write, 128 * 1024); }
            catch { handle.Dispose(); throw; }
        });
    }

    private static T WithAcl<T>(Trust trust, bool directory, Func<IntPtr, T> create)
    {
        if (trust == Trust.Inherit) return create(IntPtr.Zero);
        FileSystemSecurity acl = directory ? (FileSystemSecurity)new DirectorySecurity() : new FileSecurity();
        acl.SetAccessRuleProtection(true, false);
        acl.SetOwner(PrivilegedSids[0]);
        InheritanceFlags children = directory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
        foreach (SecurityIdentifier sid in PrivilegedSids)
            AddRule(acl, new FileSystemAccessRule(sid, FileSystemRights.FullControl, children, PropagationFlags.None, AccessControlType.Allow));
        if (trust == Trust.Runtime)
            AddRule(acl, new FileSystemAccessRule(Users, FileSystemRights.ReadAndExecute, children, PropagationFlags.None, AccessControlType.Allow));
        GCHandle pinned = GCHandle.Alloc(acl.GetSecurityDescriptorBinaryForm(), GCHandleType.Pinned);
        IntPtr native = IntPtr.Zero;
        try
        {
            SecurityAttributes attributes = new SecurityAttributes { Length = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = pinned.AddrOfPinnedObject() };
            native = Marshal.AllocHGlobal(attributes.Length);
            Marshal.StructureToPtr(attributes, native, false);
            return create(native);
        }
        finally
        {
            if (native != IntPtr.Zero) Marshal.FreeHGlobal(native);
            pinned.Free();
        }
    }

    private static void AddRule(FileSystemSecurity acl, FileSystemAccessRule rule)
    {
        FileSecurity file = acl as FileSecurity;
        if (file == null) ((DirectorySecurity)acl).AddAccessRule(rule);
        else file.AddAccessRule(rule);
    }

    internal static void Move(string source, string destination)
    {
        FullLocalPath(source);
        FullLocalPath(destination);
        if (!MoveFileExW(source, destination, 8)) throw LastError("Cannot replace " + Path.GetFileName(destination));
    }

    internal static void DeleteOnReboot(string path) { MoveFileExW(path, null, 4); }
}

internal sealed class WinProcess : IDisposable
{
    private const uint Query = 0x1000, Synchronize = 0x100000;
    private readonly IntPtr handle;
    private readonly uint id;

    private WinProcess(IntPtr handle, uint id) { this.handle = handle; this.id = id; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Startup
    {
        internal uint Size;
        internal string Reserved, Desktop, Title;
        internal uint X, Y, Width, Height, CountX, CountY, Fill, Flags;
        internal ushort ShowWindow, ReservedSize;
        internal IntPtr ReservedData, StdIn, StdOut, StdErr;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        internal IntPtr Process, Thread;
        internal uint ProcessId, ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder image, ref uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out ulong creation, out ulong exit, out ulong kernel, out ulong user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ProcessIdToSessionId(uint processid, out uint sessionId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentProcessId();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr handle, uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(string image, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
        bool inheritHandles, uint flags, IntPtr environment, string workingDirectory, ref Startup startup, out ProcessInfo process);

    internal static WinProcess Open(uint pid)
    {
        IntPtr handle = OpenProcess(Query | Synchronize, false, pid);
        if (handle == IntPtr.Zero) throw WinFiles.LastError("Cannot open the original GIFA process");
        return new WinProcess(handle, pid);
    }

    private bool QueryImage(out string image)
    {
        StringBuilder buffer = new StringBuilder(1024);
        uint length = (uint)buffer.Capacity;
        bool ok = QueryFullProcessImageNameW(handle, 0, buffer, ref length);
        image = ok ? buffer.ToString() : null;
        return ok;
    }

    internal static bool TryImage(uint pid, out string image)
    {
        image = null;
        IntPtr process = OpenProcess(Query | Synchronize, false, pid);
        if (process == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87;
        using (WinProcess inspected = new WinProcess(process, pid)) return inspected.QueryImage(out image) || inspected.Wait(0);
    }

    internal ulong CheckParent(string expectedImage, ulong expectedCreation)
    {
        string image;
        ulong created, exited, kernel, user;
        uint processSession, mySession;
        if (Wait(0) || !QueryImage(out image) || !String.Equals(image, expectedImage, StringComparison.OrdinalIgnoreCase) ||
            !GetProcessTimes(handle, out created, out exited, out kernel, out user) || (expectedCreation != 0 && created != expectedCreation) ||
            !ProcessIdToSessionId(id, out processSession) || !ProcessIdToSessionId(GetCurrentProcessId(), out mySession) || processSession != mySession)
            throw Updater.Rejected("The original GIFA process did not match the requested update.");
        IntPtr token;
        if (!OpenProcessToken(handle, 8, out token)) throw WinFiles.LastError("Cannot verify the original GIFA user");
        try
        {
            using (WindowsIdentity parent = new WindowsIdentity(token))
            using (WindowsIdentity self = WindowsIdentity.GetCurrent())
                if (parent.User != self.User) throw Updater.Rejected("The updater and GIFA process have different Windows users.");
        }
        finally { CloseHandle(token); }
        return created;
    }

    internal static WinProcess Start(string image, string arguments, string directory, bool independent)
    {
        WinFiles.FullLocalPath(image);
        WinFiles.FullLocalPath(directory);
        Startup startup = new Startup { Size = (uint)Marshal.SizeOf(typeof(Startup)) };
        StringBuilder command = new StringBuilder("\"" + image + "\"" + (arguments.Length == 0 ? "" : " " + arguments));
        ProcessInfo process;
        uint flags = independent ? 0x01000208u : 0;
        if (!CreateProcessW(image, command, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, directory, ref startup, out process))
            throw WinFiles.LastError("Cannot start " + Path.GetFileName(image));
        CloseHandle(process.Thread);
        return new WinProcess(process.Process, process.ProcessId);
    }

    internal bool Wait(uint timeout)
    {
        uint result = WaitForSingleObject(handle, timeout);
        if (result == 0) return true;
        if (result == 258) return false;
        throw WinFiles.LastError("Cannot wait for the update process");
    }

    internal uint ProcessId { get { return id; } }

    internal uint ExitCode
    {
        get
        {
            uint result;
            if (!GetExitCodeProcess(handle, out result)) throw WinFiles.LastError("Cannot read the installer exit code");
            return result;
        }
    }

    internal void StopUnarmed()
    {
        TerminateProcess(handle, 1);
        Wait(5000);
    }

    public void Dispose() { CloseHandle(handle); }
}

internal sealed class WireJson
{
    private readonly string text;
    private int position;
    private WireJson(string text) { this.text = text; }

    internal static Dictionary<string, object> Parse(byte[] bytes)
    {
        WireJson parser = new WireJson(Updater.Utf8.GetString(bytes));
        Dictionary<string, object> data = parser.ReadObject(0);
        parser.White();
        if (parser.position != parser.text.Length) throw Invalid();
        return data;
    }

    private static Exception Invalid() { return Updater.Rejected("Malformed or ambiguous release manifest JSON."); }

    private void White()
    {
        while (position < text.Length && (text[position] == ' ' || text[position] == '\t' || text[position] == '\r' || text[position] == '\n')) position++;
    }

    private bool Consume(char expected)
    {
        White();
        if (position == text.Length || text[position] != expected) return false;
        position++;
        return true;
    }

    private Dictionary<string, object> ReadObject(int depth)
    {
        if (depth > 4 || !Consume('{')) throw Invalid();
        Dictionary<string, object> fields = new Dictionary<string, object>(StringComparer.Ordinal);
        if (Consume('}')) return fields;
        do
        {
            string key = ReadString();
            if (fields.ContainsKey(key) || !Consume(':') || fields.Count >= 16) throw Invalid();
            White();
            if (position == text.Length) throw Invalid();
            object value;
            char first = text[position];
            if (first == '{') value = ReadObject(depth + 1);
            else if (first == '"') value = ReadString();
            else value = ReadInteger();
            fields.Add(key, value);
            if (Consume('}')) return fields;
        } while (Consume(','));
        throw Invalid();
    }

    private long ReadInteger()
    {
        int start = position;
        while (position < text.Length && text[position] >= '0' && text[position] <= '9') position++;
        long value;
        if (position == start || (text[start] == '0' && position - start > 1) ||
            !Int64.TryParse(text.Substring(start, position - start), NumberStyles.None, CultureInfo.InvariantCulture, out value)) throw Invalid();
        return value;
    }

    private string ReadString()
    {
        if (!Consume('"')) throw Invalid();
        StringBuilder value = new StringBuilder();
        while (position < text.Length)
        {
            char character = text[position++];
            if (character == '"')
            {
                string result = value.ToString();
                Updater.Utf8.GetByteCount(result);
                return result;
            }
            if (character < 32) throw Invalid();
            if (character == '\\')
            {
                if (position == text.Length) throw Invalid();
                character = text[position++];
                switch (character)
                {
                    case '"': case '\\': case '/': break;
                    case 'b': character = '\b'; break;
                    case 'f': character = '\f'; break;
                    case 'n': character = '\n'; break;
                    case 'r': character = '\r'; break;
                    case 't': character = '\t'; break;
                    case 'u':
                        int code = 0;
                        for (int digit = 0; digit < 4; digit++)
                        {
                            if (position == text.Length) throw Invalid();
                            char hex = text[position++];
                            int converted = hex >= '0' && hex <= '9' ? hex - '0' : hex >= 'a' && hex <= 'f' ? hex - 'a' + 10 : hex >= 'A' && hex <= 'F' ? hex - 'A' + 10 : -1;
                            if (converted < 0) throw Invalid();
                            code = code * 16 + converted;
                        }
                        character = (char)code;
                        break;
                    default: throw Invalid();
                }
            }
            value.Append(character);
        }
        throw Invalid();
    }
}

internal static class PortableZip
{
    private const string Prefix = "GIFA/";
    private const long ExpandedLimit = 2L * 1024L * 1024L * 1024L;
    private static readonly uint[] CrcTable = BuildCrcTable();
    private static readonly HashSet<string> Roots = new HashSet<string>(Updater.PortableRoots, StringComparer.Ordinal);

    private sealed class Entry
    {
        internal string Name, Destination;
        internal byte[] Bytes;
        internal bool Directory;
        internal ushort Flags, Method, Time, Date;
        internal uint Crc, Size, Compressed, Offset;
        internal long Data;
    }

    internal static void Extract(Stream input, string root, bool protect = false)
    {
        WinFiles.Trust trust = protect ? WinFiles.Trust.Stage : WinFiles.Trust.Inherit;
        using (BinaryReader reader = new BinaryReader(input, Updater.Utf8, true))
        {
            List<Entry> entries = Plan(reader, root);
            byte[] buffer = new byte[128 * 1024];
            foreach (Entry entry in entries)
            {
                if (entry.Destination == null) continue;
                if (entry.Directory) { WinFiles.CreateExclusive(entry.Destination, trust); continue; }
                input.Position = entry.Data;
                using (Stream inflater = new DeflateStream(new Slice(input, entry.Compressed), CompressionMode.Decompress))
                using (FileStream output = Updater.NewFile(entry.Destination, trust))
                {
                    uint crc = UInt32.MaxValue;
                    long size = 0;
                    int count;
                    while ((count = inflater.Read(buffer, 0, buffer.Length)) != 0)
                    {
                        size += count;
                        if (size > entry.Size) throw Bad("Expanded entry exceeds its declared size.");
                        for (int index = 0; index < count; index++) crc = CrcTable[(crc ^ buffer[index]) & 255] ^ (crc >> 8);
                        output.Write(buffer, 0, count);
                    }
                    if (size != entry.Size || ~crc != entry.Crc) throw Bad("An entry failed its ZIP length or CRC check.");
                }
            }
        }
        using (FileStream marker = WinFiles.ReadFile(Path.Combine(root, "portable.flag")))
        using (StringReader text = new StringReader(Updater.Utf8.GetString(Updater.ReadLimited(marker, 4096))))
            if (text.ReadLine() != "portable") throw Bad("The ZIP is missing a valid portable marker.");
    }

    private static List<Entry> Plan(BinaryReader reader, string root)
    {
        Stream stream = reader.BaseStream;
        if (!stream.CanSeek || stream.Length < 22 || stream.Length > Updater.ArtifactLimit) throw Bad("Invalid ZIP size.");
        long end = stream.Length - 22;
        stream.Position = end;
        if (reader.ReadUInt32() != 0x06054b50 || reader.ReadUInt16() != 0 || reader.ReadUInt16() != 0) throw Bad("Not a single-volume ZIP32 archive.");
        ushort count = reader.ReadUInt16();
        if (count == 0 || count > 8192 || reader.ReadUInt16() != count) throw Bad("Invalid ZIP entry count.");
        uint size = reader.ReadUInt32();
        uint central = reader.ReadUInt32();
        if ((long)central + size != end || reader.ReadUInt16() != 0) throw Bad("Invalid ZIP directory boundary.");
        stream.Position = central;
        List<Entry> entries = new List<Entry>(count);
        Dictionary<string, Entry> names = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
        long expanded = 0;
        for (int index = 0; index < count; index++)
        {
            if (stream.Position + 46 > end || reader.ReadUInt32() != 0x02014b50 || reader.ReadUInt16() != 20 || reader.ReadUInt16() != 20)
                throw Bad("Unexpected ZIP directory header.");
            Entry entry = new Entry { Flags = reader.ReadUInt16(), Method = reader.ReadUInt16(), Time = reader.ReadUInt16(), Date = reader.ReadUInt16(),
                Crc = reader.ReadUInt32(), Compressed = reader.ReadUInt32(), Size = reader.ReadUInt32() };
            ushort nameLength = reader.ReadUInt16();
            if (nameLength == 0 || nameLength > 1024 || reader.ReadUInt16() != 0 || reader.ReadUInt16() != 0 ||
                reader.ReadUInt16() != 0 || reader.ReadUInt16() != 0) throw Bad("Unexpected ZIP entry metadata.");
            uint attributes = reader.ReadUInt32();
            entry.Offset = reader.ReadUInt32();
            if (stream.Position + nameLength > end) throw Bad("Invalid ZIP name length.");
            entry.Bytes = reader.ReadBytes(nameLength);
            entry.Name = Updater.Utf8.GetString(entry.Bytes);
            entry.Directory = entry.Name.EndsWith("/", StringComparison.Ordinal);
            if (entry.Directory ? attributes != 0x10 || entry.Flags != 0x0800 || entry.Method != 0 || entry.Crc != 0 || entry.Size != 0 || entry.Compressed != 0 :
                attributes != 0 || entry.Flags != 0x0808 || entry.Method != 8 || entry.Compressed == 0)
                throw Bad("The ZIP contains unsupported flags, attributes, or link entries.");
            expanded += entry.Size;
            if (expanded > ExpandedLimit) throw Bad("The expanded ZIP is too large.");
            string key = entry.Directory ? entry.Name.Substring(0, entry.Name.Length - 1) : entry.Name;
            if (names.ContainsKey(key)) throw Bad("The ZIP contains case-colliding entries.");
            if (index == 0)
            {
                if (entry.Name != Prefix) throw Bad("The ZIP must have the GIFA/ root entry.");
            }
            else
            {
                if (!entry.Name.StartsWith(Prefix, StringComparison.Ordinal)) throw Bad("A ZIP entry is outside GIFA/.");
                int slash = key.LastIndexOf('/');
                Entry parent;
                string parentKey = key.Substring(0, slash);
                if (!names.TryGetValue(parentKey, out parent) || !parent.Directory || parent.Name != parentKey + "/")
                    throw Bad("A ZIP entry has an undeclared or case-conflicting parent.");
                string relative = key.Substring(Prefix.Length);
                string[] parts = relative.Split('/');
                if (parts.Length > 24) throw Bad("The ZIP directory nesting is excessive.");
                foreach (string part in parts) WinFiles.CheckSegment(part);
                if (parts[0] == "data")
                {
                    if (parts.Length != 1 || !entry.Directory) throw Bad("The portable ZIP data directory must be empty.");
                }
                else
                {
                    if (!Roots.Contains(parts[0]) || (parts.Length == 1 ? Updater.RuntimeDirectory(parts[0]) != entry.Directory : !Updater.RuntimeDirectory(parts[0])))
                        throw Bad("Unexpected ZIP runtime root: " + parts[0]);
                    entry.Destination = WinFiles.FullLocalPath(Path.Combine(root, relative.Replace('/', '\\')));
                }
            }
            names.Add(key, entry);
            entries.Add(entry);
        }
        if (stream.Position != end) throw Bad("The ZIP directory size does not match its entries.");
        foreach (string name in Updater.PortableRoots) Require(names, name, Updater.RuntimeDirectory(name));
        Require(names, "data", true);
        Require(names, "resources/app.asar", false);
        Require(names, "resources/" + Updater.HelperName, false);
        Require(names, "resources/GIFA.Gamepad.exe", false);
        Require(names, "locales/en-US.pak", false);
        Require(names, "locales/zh-CN.pak", false);
        long next = 0;
        foreach (Entry entry in entries) next = ValidateLocal(reader, entry, next, central);
        if (next != central) throw Bad("Unexpected bytes before the ZIP directory.");
        return entries;
    }

    private static void Require(Dictionary<string, Entry> entries, string relative, bool directory)
    {
        Entry entry;
        if (!entries.TryGetValue(Prefix + relative, out entry) || entry.Name != Prefix + relative + (directory ? "/" : "") ||
            entry.Directory != directory || (!directory && entry.Size == 0)) throw Bad("The portable ZIP lacks " + relative + ".");
    }

    private static long ValidateLocal(BinaryReader reader, Entry entry, long next, uint central)
    {
        Stream stream = reader.BaseStream;
        if (entry.Offset != next || next + 30 + entry.Bytes.Length + entry.Compressed + (entry.Directory ? 0 : 16) > central)
            throw Bad("ZIP local entries overlap or leave a gap.");
        stream.Position = next;
        if (reader.ReadUInt32() != 0x04034b50 || reader.ReadUInt16() != 20 || reader.ReadUInt16() != entry.Flags ||
            reader.ReadUInt16() != entry.Method || reader.ReadUInt16() != entry.Time || reader.ReadUInt16() != entry.Date ||
            reader.ReadUInt32() != 0 || reader.ReadUInt32() != 0 || reader.ReadUInt32() != 0 || reader.ReadUInt16() != entry.Bytes.Length ||
            reader.ReadUInt16() != 0) throw Bad("A ZIP local header conflicts with its directory.");
        foreach (byte expected in entry.Bytes) if (reader.ReadByte() != expected) throw Bad("A ZIP local entry name conflicts with its directory.");
        entry.Data = stream.Position;
        stream.Position += entry.Compressed;
        if (!entry.Directory && (reader.ReadUInt32() != 0x08074b50 || reader.ReadUInt32() != entry.Crc ||
            reader.ReadUInt32() != entry.Compressed || reader.ReadUInt32() != entry.Size)) throw Bad("A ZIP data descriptor conflicts with its directory.");
        return stream.Position;
    }

    private static Exception Bad(string detail) { return Updater.Rejected("Invalid GIFA portable update ZIP: " + detail); }

    private static uint[] BuildCrcTable()
    {
        uint[] table = new uint[256];
        for (uint index = 0; index < table.Length; index++)
        {
            uint value = index;
            for (int step = 0; step < 8; step++) value = (value >> 1) ^ ((value & 1) == 0 ? 0 : 0xedb88320);
            table[index] = value;
        }
        return table;
    }

    private sealed class Slice : Stream
    {
        private readonly Stream source;
        private long remaining;
        internal Slice(Stream source, long remaining) { this.source = source; this.remaining = remaining; }
        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { throw new NotSupportedException(); } }
        public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
        public override void Flush() { throw new NotSupportedException(); }
        public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count)
        {
            int obtained = source.Read(buffer, offset, (int)Math.Min(count, remaining));
            remaining -= obtained;
            return obtained;
        }
    }
}
