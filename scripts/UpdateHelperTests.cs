using System;
using System.ComponentModel;
using System.IO;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;

[assembly: AssemblyFileVersion("0.2.8.0")]

internal static class UpdateHelperTests
{
    private static readonly Version Current = new Version(0, 2, 7);
    private static readonly Version Next = new Version(0, 2, 8);
    private static int assertions;

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--fixture-child") { System.Threading.Thread.Sleep(1300); return 42; }
            if (args.Length == 3 && args[0] == "--verify-zip")
            {
                using (FileStream input = WinFiles.ReadFile(args[1])) PortableZip.Extract(input, args[2]);
                Console.WriteLine("Packaged portable ZIP extracted successfully.");
                return 0;
            }
            if (args.Length != 1) throw new Exception("Need the isolated fixture directory.");
            string root = Path.GetFullPath(args[0]);
            Assert(Path.GetFileName(root).StartsWith("gifa-native-update-fixtures-", StringComparison.Ordinal), "disposable temp root");
            ManifestTests(root);
            ZipAndPublishTests(root);
            BoundaryTests(root);
            ProcessTests(root);
            Console.WriteLine("Native updater tests passed (" + assertions + " checks).");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }

    private static void Assert(bool success, string description)
    {
        if (!success) throw new Exception("Assertion failed: " + description);
        assertions++;
    }

    private static void Reject(Action action, string description, string expected = null)
    {
        try { action(); }
        catch (Exception error)
        {
            if (!(error is IOException || error is Win32Exception || error is UnauthorizedAccessException ||
                error is FormatException || error is ArgumentException || error is InvalidDataException)) throw;
            if (expected != null && error.Message.IndexOf(expected, StringComparison.OrdinalIgnoreCase) < 0)
                throw new Exception("Unexpected rejection for " + description, error);
            assertions++;
            return;
        }
        throw new Exception("Expected rejection: " + description);
    }

    private static string Dir(string location)
    {
        Directory.CreateDirectory(location);
        return location;
    }

    private static void ManifestTests(string root)
    {
        Assert(Updater.ParseVersion("65535.0.1").Major == 65535, "upper stable range");
        foreach (string value in new[] { "65536.0.0", "01.2.3", "1.2", " 1.2.3", "1.2.3-beta", "1.2.3+local", "1.2.3\n", "1.２.3" })
            Reject(delegate { Updater.ParseVersion(value); }, value);
        string valid = Path.Combine(root, "valid.json");
        byte[] manifest = File.ReadAllBytes(valid);
        Updater.Asset portable = Updater.VerifyManifest(manifest, "portable", Current);
        Updater.Asset setup = Updater.VerifyManifest(manifest, "installed", Current);
        Assert(portable.Version.Equals(Next) && portable.Name == "GIFA-0.2.8-win-x64.zip" && setup.Name == "GIFA-0.2.8-Setup.exe", "wire contract");
        Reject(delegate { Updater.VerifyManifest(manifest, "installed", Next); }, "update to same version", "newer");
        Reject(delegate { Updater.VerifyManifest(manifest, "installed", new Version(1, 0, 0)); }, "downgrade", "newer");
        foreach (string bad in Directory.GetFiles(root, "bad-manifest-*.json"))
            Reject(delegate { Updater.VerifyManifest(File.ReadAllBytes(bad), "portable", Current); }, Path.GetFileName(bad));
        string source = Path.Combine(root, portable.Name);
        string copied = Path.Combine(root, "copied.zip");
        using (FileStream input = WinFiles.ReadFile(source)) Updater.CheckAsset(input, portable, copied, WinFiles.Trust.Inherit);
        Assert(new FileInfo(copied).Length == portable.Size, "verified copy");
        string installed = Path.Combine(root, setup.Name);
        using (FileStream input = WinFiles.ReadFile(installed)) Updater.CheckAsset(input, setup, null);
        Reject(delegate
        {
            using (FileStream input = WinFiles.ReadFile(Path.Combine(root, "bad-hash.zip"))) Updater.CheckAsset(input, portable, null);
        }, "same-size modified ZIP", "SHA-256");
        Reject(delegate
        {
            using (FileStream input = WinFiles.ReadFile(Path.Combine(root, "bad-size.zip"))) Updater.CheckAsset(input, portable, null);
        }, "truncated ZIP", "size");
    }

    private static void ZipAndPublishTests(string root)
    {
        string payload = Dir(Path.Combine(root, "extracted"));
        using (FileStream input = WinFiles.ReadFile(Path.Combine(root, "copied.zip"))) PortableZip.Extract(input, payload);
        Updater.CheckVersion(Path.Combine(payload, Updater.AppExe), Next);
        Reject(delegate { Updater.CheckVersion(Path.Combine(payload, Updater.AppExe), Current); }, "binary version mismatch", "version");
        Assert(!Directory.Exists(Path.Combine(payload, "data")), "archive data never staged");
        foreach (string name in Updater.PortableRoots) Assert(WinFiles.Exists(Path.Combine(payload, name)), "staged " + name);
        foreach (string bad in Directory.GetFiles(root, "unsafe-*.zip"))
        {
            string reject = Dir(Path.Combine(root, Path.GetFileNameWithoutExtension(bad)));
            Reject(delegate { using (FileStream input = WinFiles.ReadFile(bad)) PortableZip.Extract(input, reject); }, Path.GetFileName(bad));
        }
        Assert(!File.Exists(Path.Combine(root, "escape.bin")), "malformed archives never escape isolated directory");

        string app = Existing(root, "portable-成功");
        Updater.PublishPortable(app, payload, false, delegate
        {
            Updater.CheckVersion(Path.Combine(app, Updater.AppExe), Next);
            Updater.CheckMarker(Path.Combine(app, "portable.flag"), "portable", WinFiles.Trust.Owner);
        });
        Assert(File.ReadAllText(Path.Combine(app, "resources", "app.asar")) == "new asar", "new runtime installed");
        Assert(!File.Exists(Path.Combine(app, "resources", "old-runtime")), "old runtime no longer in app");
        Assert(!Directory.Exists(Path.Combine(app, Updater.WorkName)), "successful update cleaned transaction");
        AssertData(app);

        string locked = Existing(root, "rollback-locked");
        string lockedEntry = Path.Combine(locked, "d3dcompiler_47.dll");
        using (FileStream owner = new FileStream(lockedEntry, FileMode.Open, FileAccess.Read, FileShare.Read))
            Reject(delegate { Updater.PublishPortable(locked, payload, false, delegate { }); }, "occupied runtime entry", "Cannot replace");
        Assert(File.ReadAllText(Path.Combine(locked, "chrome_200_percent.pak")) == "old", "previously moved runtime rolled back");
        Assert(File.ReadAllText(Path.Combine(locked, lockedEntry)) == "old", "locked runtime unchanged");
        Assert(File.ReadAllText(Path.Combine(locked, "resources", "app.asar")) == "old asar", "old resources unchanged");
        Assert(!Directory.Exists(Path.Combine(locked, Updater.WorkName)), "complete rollback cleaned transaction");
        AssertData(locked);

        string recovery = Existing(root, "rollback-keep-backup");
        FileStream pinned = null;
        try
        {
            Reject(delegate { Updater.PublishPortable(recovery, payload, false, delegate
            {
                pinned = new FileStream(Path.Combine(recovery, "d3dcompiler_47.dll"), FileMode.Open, FileAccess.Read, FileShare.Read);
                throw new IOException("simulated interrupted validation");
            }); }, "incomplete rollback preserves backup", "incomplete");
        }
        finally { if (pinned != null) pinned.Dispose(); }
        string saved = Path.Combine(recovery, Updater.WorkName, "old", "d3dcompiler_47.dll");
        Assert(File.ReadAllText(saved) == "old", "recoverable old runtime on disk");
        Reject(delegate { Updater.PublishPortable(recovery, payload, false, delegate { }); }, "interrupted transaction is not overwritten");
        Assert(File.ReadAllText(saved) == "old", "recovery files survived retry");
        AssertData(recovery);
    }

    private static string Existing(string root, string name)
    {
        string app = Dir(Path.Combine(root, name));
        foreach (string entry in Updater.PortableRoots)
        {
            string target = Path.Combine(app, entry);
            if (Updater.RuntimeDirectory(entry)) Dir(target);
            else File.WriteAllText(target, "old");
        }
        File.WriteAllText(Path.Combine(app, "resources", "app.asar"), "old asar");
        File.WriteAllText(Path.Combine(app, "resources", "old-runtime"), "superseded runtime");
        File.WriteAllText(Path.Combine(Dir(Path.Combine(app, "data")), "settings.json"), "keep data");
        File.WriteAllText(Path.Combine(app, "notes.txt"), "keep notes");
        return app;
    }

    private static void AssertData(string app)
    {
        Assert(File.ReadAllText(Path.Combine(app, "data", "settings.json")) == "keep data", "application data untouched");
        Assert(File.ReadAllText(Path.Combine(app, "notes.txt")) == "keep notes", "unrelated root files untouched");
    }

    private static Updater.Registration Registration(string root, string scope)
    {
        return new Updater.Registration { Exists = true, Location = root,
            Uninstall = "\"" + Path.Combine(root, Updater.UninstallExe) + "\" " + scope, Version = Current.ToString(3) };
    }

    private static void BoundaryTests(string root)
    {
        string user = Dir(Path.Combine(root, "per-user 安装"));
        string machine = Dir(Path.Combine(root, "all-users 安装"));
        Updater.Registration none = new Updater.Registration();
        Updater.Registration perUser = Registration(user, "/currentuser");
        Updater.Registration perMachine = Registration(machine, "/allusers");
        Assert(Updater.SelectScope(user, Current, perUser, perMachine) == "/currentuser", "separate HKLM install is not used for HKCU path");
        Assert(Updater.SelectScope(machine, Current, none, perMachine) == "/allusers", "matching machine registration");
        Reject(delegate { Updater.SelectScope(machine, Current, perUser, perMachine); }, "machine scope cannot uninstall the per-user copy", "per-user");
        Reject(delegate { Updater.SelectScope(user, Current, perUser, Registration(user, "/allusers")); }, "ambiguous scope");
        Reject(delegate { Updater.SelectScope(root, Current, perUser, perMachine); }, "refuse arbitrary target");
        perUser.Uninstall = "\"" + Path.Combine(machine, Updater.UninstallExe) + "\" /currentuser";
        Reject(delegate { Updater.SelectScope(user, Current, perUser, none); }, "uninstaller path disagrees with registered installation", "uninstall");
        string marker = Path.Combine(user, "installed.flag");
        File.WriteAllText(marker, "installed\r\n");
        Updater.CheckMarker(marker, "installed", WinFiles.Trust.Owner);
        Reject(delegate { Updater.CheckMarker(marker, "portable", WinFiles.Trust.Owner); }, "wrong mode marker", "marker");
        using (WinFiles.PinDirectory(user, WinFiles.Trust.Owner, true)) { }
        string unsafeAcl = Dir(Path.Combine(root, "unsafe-acl"));
        DirectorySecurity security = Directory.GetAccessControl(unsafeAcl);
        security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null), FileSystemRights.Modify, AccessControlType.Allow));
        Directory.SetAccessControl(unsafeAcl, security);
        Reject(delegate { using (WinFiles.PinDirectory(unsafeAcl, WinFiles.Trust.Owner, true)) { } }, "other principals can write", "Another account");
        Reject(delegate { using (WinFiles.PinDirectory(Path.Combine(root, "linked-folder"), WinFiles.Trust.Inherit, false)) { } }, "junction refused");
        Reject(delegate { using (WinFiles.ReadFile(Path.Combine(root, "linked-file"))) { } }, "hardlink refused");
        Assert(File.ReadAllText(Path.Combine(root, "outside", "kept.txt")) == "outside", "link target unaffected");
    }

    private static void ProcessTests(string root)
    {
        string child = Path.Combine(root, "incoming", Updater.AppExe);
        using (WinProcess launched = WinProcess.Start(child, "--fixture-child", root, true))
        using (WinProcess read = WinProcess.Open(launched.ProcessId))
        {
            ulong created = read.CheckParent(child, 0);
            Assert(created != 0 && !read.Wait(0), "verified live worker parent handle");
            Reject(delegate { read.CheckParent(child, created + 1); }, "PID with wrong creation timestamp", "original");
            Reject(delegate { read.CheckParent(Path.Combine(root, Updater.AppExe), created); }, "different executable identity", "original");
            Assert(read.Wait(5000) && launched.ExitCode == 42, "original process wait and controlled detached launch");
        }
    }
}
