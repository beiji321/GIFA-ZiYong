// SPDX-License-Identifier: GPL-3.0-only
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

[StructLayout(LayoutKind.Sequential, Pack = 4)]
internal struct XGamepad {
  public ushort wButtons;
  public byte bLeftTrigger;
  public byte bRightTrigger;
  public short sThumbLX;
  public short sThumbLY;
  public short sThumbRX;
  public short sThumbRY;
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
internal struct XState {
  public uint dwPacketNumber;
  public XGamepad Gamepad;
}

internal static class GamepadPoller {
  const int SlotCount = 4;
  const int PollMs = 16;
  const uint LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x00000800;

  [UnmanagedFunctionPointer(CallingConvention.Winapi)]
  delegate uint GetStateFn(uint user, out XState state);
  [DllImport("kernel32", CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern IntPtr LoadLibraryExW(string name, IntPtr file, uint flags);
  [DllImport("kernel32", CharSet = CharSet.Ansi, ExactSpelling = true)]
  static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("kernel32", ExactSpelling = true)]
  static extern bool FreeLibrary(IntPtr module);

  static GetStateFn fn;

  static bool Probe() {
    if (fn != null) return true;
    foreach (string name in new[] { "xinput1_4.dll", "xinput1_3.dll", "xinput9_1_0.dll" }) {
      IntPtr lib = LoadLibraryExW(name, IntPtr.Zero, LOAD_LIBRARY_SEARCH_SYSTEM32);
      if (lib == IntPtr.Zero) continue;
      IntPtr address = GetProcAddress(lib, "XInputGetState");
      if (address != IntPtr.Zero) {
        fn = (GetStateFn)Marshal.GetDelegateForFunctionPointer(address, typeof(GetStateFn));
        return true;
      }
      FreeLibrary(lib);
    }
    return false;
  }

  static bool SameGamepad(XGamepad left, XGamepad right) {
    return left.wButtons == right.wButtons
      && left.bLeftTrigger == right.bLeftTrigger
      && left.bRightTrigger == right.bRightTrigger
      && left.sThumbLX == right.sThumbLX
      && left.sThumbLY == right.sThumbLY
      && left.sThumbRX == right.sThumbRX
      && left.sThumbRY == right.sThumbRY;
  }

  static void Emit(string line) {
    Console.Out.WriteLine(line);
    Console.Out.Flush();
  }

  sealed class Reports {
    readonly Dictionary<int, XGamepad> last = new Dictionary<int, XGamepad>();
    internal bool HasDevices { get { return last.Count != 0; } }

    internal void Update(int slot, string model, XGamepad pad) {
      XGamepad previous;
      if (last.TryGetValue(slot, out previous)) {
        if (slot < SlotCount) {
          if (SameGamepad(previous, pad)) return;
        } else {
          // 索尼手柄可能以较高频率报告。圆盘只用 L3 与按住 L3 时的右摇杆。
          bool pressed = (pad.wButtons & 0x0040) != 0;
          bool wasPressed = (previous.wButtons & 0x0040) != 0;
          if (wasPressed == pressed && (!pressed ||
              (previous.sThumbRX == pad.sThumbRX && previous.sThumbRY == pad.sThumbRY))) return;
        }
      }
      last[slot] = pad;
      Emit(string.Format(CultureInfo.InvariantCulture,
        @"{{""slot"":{0},""model"":""{1}"",""b"":{2},""lt"":{3},""rt"":{4},""lx"":{5},""ly"":{6},""rx"":{7},""ry"":{8}}}",
        slot, model, pad.wButtons, pad.bLeftTrigger, pad.bRightTrigger, pad.sThumbLX, pad.sThumbLY, pad.sThumbRX, pad.sThumbRY));
    }

    internal void Remove(int slot) {
      if (last.Remove(slot)) Emit(string.Format(CultureInfo.InvariantCulture, @"{{""slot"":{0},""none"":1}}", slot));
    }

    internal void RemoveSony() {
      foreach (int slot in new List<int>(last.Keys)) {
        if (slot >= SlotCount) Remove(slot);
      }
    }
  }

  static void PollXbox(Reports reports) {
    for (int slot = 0; slot < SlotCount; slot++) {
      XState state;
      if (fn((uint)slot, out state) == 0) reports.Update(slot, "xinput", state.Gamepad);
      else reports.Remove(slot);
    }
  }

  static RawGamepadInput OpenRawInput(Reports reports) {
    try {
      return new RawGamepadInput(reports.Update, reports.Remove);
    } catch (Win32Exception error) {
      Console.Error.WriteLine("Raw Input: " + error.Message);
      return null;
    }
  }

  static int Run(Task parentEof) {
    var reports = new Reports();
    bool hasXbox = Probe();
    RawGamepadInput raw = OpenRawInput(reports);
    if (!hasXbox && raw == null) {
      Emit(@"{""error"":""gamepad-backends-unavailable""}");
      return 1;
    }
    try {
      var stop = ((IAsyncResult)parentEof).AsyncWaitHandle;
      var clock = Stopwatch.StartNew();
      long interval = Stopwatch.Frequency * PollMs / 1000;
      if (parentEof.IsCompleted) return 0;
      if (hasXbox) PollXbox(reports);
      if (!reports.HasDevices) Emit(@"{""none"":1}");
      long nextPoll = clock.ElapsedTicks + interval;
      while (!parentEof.IsCompleted) {
        long remaining = nextPoll - clock.ElapsedTicks;
        if (hasXbox && remaining <= 0) {
          PollXbox(reports);
          nextPoll = clock.ElapsedTicks + interval;
          remaining = interval;
        }
        int waitMs = hasXbox ? (int)Math.Ceiling(remaining * 1000.0 / Stopwatch.Frequency) : Timeout.Infinite;
        if (raw == null) {
          stop.WaitOne(waitMs);
          continue;
        }
        try {
          raw.WaitAndDispatch(stop, waitMs);
        } catch (Win32Exception error) {
          if (!hasXbox) throw;
          Console.Error.WriteLine("Raw Input: " + error.Message);
          raw.Dispose();
          raw = null;
          reports.RemoveSony();
        }
      }
      return 0;
    } finally {
      if (raw != null) raw.Dispose();
    }
  }

  static int Main() {
    try {
      // 父进程退出或关闭 stdin 时，等待句柄会同时唤醒 XInput 和 Raw Input。
      using (Stream input = Console.OpenStandardInput()) {
        return Run(input.ReadAsync(new byte[1], 0, 1));
      }
    } catch (Exception error) {
      Console.Error.WriteLine(error.Message);
      return 2;
    }
  }
}
