// SPDX-License-Identifier: GPL-3.0-only
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal sealed class RawGamepadInput : IDisposable {
  const uint WM_INPUT_DEVICE_CHANGE = 0x00fe;
  const uint WM_INPUT = 0x00ff;
  const uint WM_QUIT = 0x0012;
  const uint GIDC_ARRIVAL = 1;
  const uint GIDC_REMOVAL = 2;
  const uint RIDEV_REMOVE = 0x0001;
  const uint RIDEV_INPUTSINK = 0x0100;
  const uint RIDEV_DEVNOTIFY = 0x2000;
  const uint RID_HEADER = 0x10000005;
  const uint RID_INPUT = 0x10000003;
  const uint RIDI_DEVICENAME = 0x20000007;
  const uint RIDI_DEVICEINFO = 0x2000000b;
  const uint RIM_TYPEHID = 2;
  const ushort GenericDesktop = 0x01;
  const ushort Joystick = 0x04;
  const ushort Gamepad = 0x05;
  const uint QS_ALLINPUT = 0x1cff;
  const uint MWMO_INPUTAVAILABLE = 0x0004;
  const uint PM_REMOVE = 0x0001;
  const uint WAIT_OBJECT_0 = 0;
  const uint WAIT_TIMEOUT = 258;
  const uint WAIT_FAILED = uint.MaxValue;
  const uint GENERIC_READ = 0x80000000;
  const uint FILE_SHARE_READ_WRITE = 0x0003;
  const uint OPEN_EXISTING = 3;
  const uint FILE_FLAG_OVERLAPPED = 0x40000000;
  const int ERROR_INSUFFICIENT_BUFFER = 122;
  const int ERROR_IO_INCOMPLETE = 996;
  const int ERROR_IO_PENDING = 997;
  const int HIDP_STATUS_SUCCESS = 0x00110000;
  const int FirstSonySlot = 4;
  const int MaxSonyDevices = 16;
  const int MaxHidReportBytes = 1024;
  const int MaxPacketBytes = 64 * 1024;
  const int MaxMessagesPerPump = 64;
  static readonly int[] RetryDelaysMs = { 60, 200, 800 };
  static readonly long PumpBudget = Stopwatch.Frequency * 4 / 1000;
  static readonly IntPtr MessageOnlyWindow = new IntPtr(-3);
  static readonly int HeaderBytes = Marshal.SizeOf(typeof(RawInputHeader));
  static readonly int ReportOffset = HeaderBytes + 2 * sizeof(uint);
  static readonly uint DeviceInfoBytes = (uint)Marshal.SizeOf(typeof(RawDeviceInfo));
  static readonly uint RegistrationBytes = (uint)Marshal.SizeOf(typeof(RawInputDevice));
  static readonly uint DeviceListEntryBytes = (uint)Marshal.SizeOf(typeof(RawDeviceListEntry));
  static readonly int OverlappedBytes = Marshal.SizeOf(typeof(Overlapped));

  [StructLayout(LayoutKind.Sequential)]
  struct RawInputHeader {
    public uint Type, Size;
    public IntPtr Device;
    public UIntPtr Param;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct RawInputDevice {
    public ushort UsagePage, Usage;
    public uint Flags;
    public IntPtr Target;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct RawDeviceListEntry {
    public IntPtr Handle;
    public uint Type;
  }

  // RID_DEVICE_INFO 的 union 为 24 字节。只读取其中的 HID 成员。
  [StructLayout(LayoutKind.Explicit, Size = 32)]
  struct RawDeviceInfo {
    [FieldOffset(0)] public uint Size;
    [FieldOffset(4)] public uint Type;
    [FieldOffset(8)] public uint Vendor;
    [FieldOffset(12)] public uint Product;
    [FieldOffset(20)] public ushort UsagePage;
    [FieldOffset(22)] public ushort Usage;
  }

  [StructLayout(LayoutKind.Explicit, Size = 64)]
  struct HidCaps {
    [FieldOffset(0)] public ushort Usage;
    [FieldOffset(2)] public ushort UsagePage;
    [FieldOffset(4)] public ushort InputReportByteLength;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct Overlapped {
    public UIntPtr Internal, InternalHigh;
    public uint Offset, OffsetHigh;
    public IntPtr Event;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct WindowClass {
    public uint Style;
    public IntPtr Procedure;
    public int ClassExtra, WindowExtra;
    public IntPtr Instance, Icon, Cursor, Background, MenuName;
    public string Name;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct WindowMessage {
    public IntPtr Window;
    public uint Message;
    public UIntPtr WParam;
    public IntPtr LParam;
    public uint Time;
    public int PointX, PointY;
    public uint Reserved;
  }

  [UnmanagedFunctionPointer(CallingConvention.Winapi)]
  delegate IntPtr WindowProcedure(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern IntPtr GetModuleHandleW(string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern SafeWaitHandle CreateEventW(IntPtr security, bool manualReset, bool signaled, string name);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  static extern bool ReadFile(SafeFileHandle file, IntPtr buffer, uint bytes, IntPtr bytesRead, IntPtr overlapped);
  [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
  static extern bool GetOverlappedResult(SafeFileHandle file, IntPtr overlapped, out uint bytes, bool wait);
  [DllImport("kernel32.dll", ExactSpelling = true)]
  static extern bool CancelIoEx(SafeFileHandle file, IntPtr overlapped);
  [DllImport("hid.dll", ExactSpelling = true)]
  [return: MarshalAs(UnmanagedType.U1)]
  static extern bool HidD_GetPreparsedData(SafeFileHandle file, out IntPtr data);
  [DllImport("hid.dll", ExactSpelling = true)]
  [return: MarshalAs(UnmanagedType.U1)]
  static extern bool HidD_FreePreparsedData(IntPtr data);
  [DllImport("hid.dll", ExactSpelling = true)]
  static extern int HidP_GetCaps(IntPtr data, out HidCaps caps);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern ushort RegisterClassW(ref WindowClass windowClass);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern bool UnregisterClassW(string className, IntPtr instance);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern IntPtr CreateWindowExW(uint exStyle, string className, string name, uint style,
    int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll", ExactSpelling = true)]
  static extern bool DestroyWindow(IntPtr window);
  [DllImport("user32.dll", ExactSpelling = true)]
  static extern IntPtr DefWindowProcW(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
  static extern bool RegisterRawInputDevices([In] RawInputDevice[] devices, uint count, uint deviceSize);
  [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
  static extern uint GetRawInputDeviceList(IntPtr devices, ref uint count, uint deviceSize);
  [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
  static extern uint GetRawInputDeviceList([Out] RawDeviceListEntry[] devices, ref uint count, uint deviceSize);
  [DllImport("user32.dll", ExactSpelling = true)]
  static extern uint GetRawInputDeviceInfoW(IntPtr device, uint command, ref RawDeviceInfo info, ref uint size);
  [DllImport("user32.dll", ExactSpelling = true)]
  static extern uint GetRawInputDeviceInfoW(IntPtr device, uint command, IntPtr data, ref uint size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern uint GetRawInputDeviceInfoW(IntPtr device, uint command, StringBuilder name, ref uint size);
  [DllImport("user32.dll", ExactSpelling = true)]
  static extern uint GetRawInputData(IntPtr input, uint command, out RawInputHeader header, ref uint size, uint headerSize);
  [DllImport("user32.dll", ExactSpelling = true)]
  static extern uint GetRawInputData(IntPtr input, uint command, [Out] byte[] data, ref uint size, uint headerSize);
  [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)]
  static extern uint MsgWaitForMultipleObjectsEx(uint count, [In] IntPtr[] handles, uint timeout, uint wakeMask, uint flags);
  [DllImport("user32.dll", ExactSpelling = true)]
  static extern bool PeekMessageW(out WindowMessage message, IntPtr window, uint first, uint last, uint remove);
  [DllImport("user32.dll", ExactSpelling = true)]
  static extern IntPtr DispatchMessageW(ref WindowMessage message);

  // Raw Input 每进程只允许为同一 usage 注册一个接收窗口。
  static RawGamepadInput current;
  static long nextSlot = FirstSonySlot;
  static readonly WindowProcedure windowProcedure = WindowCallback;

  sealed class HidReader : IDisposable {
    readonly SafeFileHandle file;
    readonly SafeWaitHandle ready;
    GCHandle pinned;
    IntPtr overlapped;
    bool pending;
    internal readonly byte[] Report;
    internal IntPtr ReadyHandle { get { return ready.DangerousGetHandle(); } }

    HidReader(SafeFileHandle file, SafeWaitHandle ready, int reportSize) {
      this.file = file;
      this.ready = ready;
      Report = new byte[reportSize];
      try {
        pinned = GCHandle.Alloc(Report, GCHandleType.Pinned);
        overlapped = Marshal.AllocHGlobal(OverlappedBytes);
        Marshal.StructureToPtr(new Overlapped { Event = ReadyHandle }, overlapped, false);
      } catch {
        Dispose();
        throw;
      }
    }

    internal static HidReader Open(IntPtr device) {
      uint chars = 0;
      if (GetRawInputDeviceInfoW(device, RIDI_DEVICENAME, IntPtr.Zero, ref chars) != 0 || chars == 0 || chars > 4096)
        return null;
      var name = new StringBuilder((int)chars);
      if (GetRawInputDeviceInfoW(device, RIDI_DEVICENAME, name, ref chars) == uint.MaxValue || name.Length == 0)
        return null;

      SafeFileHandle file = CreateFileW(name.ToString(), GENERIC_READ, FILE_SHARE_READ_WRITE, IntPtr.Zero,
        OPEN_EXISTING, FILE_FLAG_OVERLAPPED, IntPtr.Zero);
      SafeWaitHandle ready = null;
      try {
        if (file.IsInvalid) return null;
        IntPtr preparsed;
        if (!HidD_GetPreparsedData(file, out preparsed)) return null;
        HidCaps caps;
        try {
          if (HidP_GetCaps(preparsed, out caps) != HIDP_STATUS_SUCCESS || !IsGamepad(caps.UsagePage, caps.Usage) ||
              caps.InputReportByteLength == 0 || caps.InputReportByteLength > MaxHidReportBytes) return null;
        } finally {
          HidD_FreePreparsedData(preparsed);
        }
        ready = CreateEventW(IntPtr.Zero, true, false, null);
        if (ready.IsInvalid) return null;
        var reader = new HidReader(file, ready, caps.InputReportByteLength);
        file = null;
        ready = null;
        if (reader.BeginRead()) return reader;
        reader.Dispose();
        return null;
      } finally {
        if (ready != null) ready.Dispose();
        if (file != null) file.Dispose();
      }
    }

    internal bool BeginRead() {
      // ReadFile resets the event before using OVERLAPPED; the remaining fields stay fixed.
      Marshal.WriteIntPtr(overlapped, 0, IntPtr.Zero);
      Marshal.WriteIntPtr(overlapped, IntPtr.Size, IntPtr.Zero);
      pending = ReadFile(file, pinned.AddrOfPinnedObject(), (uint)Report.Length, IntPtr.Zero, overlapped) ||
        Marshal.GetLastWin32Error() == ERROR_IO_PENDING;
      return pending;
    }

    // Zero means the request has not completed yet; -1 means this reader failed.
    internal int Complete() {
      uint bytes;
      if (!GetOverlappedResult(file, overlapped, out bytes, false)) {
        if (Marshal.GetLastWin32Error() == ERROR_IO_INCOMPLETE) return 0;
        pending = false;
        return -1;
      }
      pending = false;
      return bytes > 0 && bytes <= Report.Length ? (int)bytes : -1;
    }

    public void Dispose() {
      if (pending) {
        // Cancellation only requests completion. The OS owns the pointers until it finishes.
        CancelIoEx(file, overlapped);
        uint ignored;
        GetOverlappedResult(file, overlapped, out ignored, true);
        pending = false;
      }
      file.Dispose();
      ready.Dispose();
      if (pinned.IsAllocated) pinned.Free();
      if (overlapped != IntPtr.Zero) {
        Marshal.FreeHGlobal(overlapped);
        overlapped = IntPtr.Zero;
      }
    }
  }

  sealed class Device {
    internal readonly IntPtr Handle;
    internal readonly string Model;
    internal int Slot;
    internal HidReader Reader;
    internal long NextOpen;
    internal int Retries;

    internal Device(IntPtr handle, string model) { Handle = handle; Model = model; }

    internal void RetryOpen() {
      NextOpen = Retries == RetryDelaysMs.Length ? long.MaxValue :
        Stopwatch.GetTimestamp() + (long)RetryDelaysMs[Retries++] * Stopwatch.Frequency / 1000;
    }

    internal void CloseReader() {
      if (Reader == null) return;
      Reader.Dispose();
      Reader = null;
    }
  }

  readonly Action<int, string, XGamepad> onInput;
  readonly Action<int> onDisconnected;
  readonly int ownerThread = Thread.CurrentThread.ManagedThreadId;
  readonly string className = "GIFA.RawGamepad." + Guid.NewGuid().ToString("N");
  readonly RawInputDevice[] registrations = {
    new RawInputDevice { UsagePage = GenericDesktop, Usage = Joystick },
    new RawInputDevice { UsagePage = GenericDesktop, Usage = Gamepad }
  };
  // null 表示已经确认不受支持。瞬时查询失败留待下一次消息重试。
  readonly Dictionary<IntPtr, Device> devices = new Dictionary<IntPtr, Device>();
  readonly List<Device> sonyDevices = new List<Device>(MaxSonyDevices);
  readonly IntPtr[] waitHandles = new IntPtr[1 + MaxSonyDevices];
  byte[] packet = new byte[256];
  IntPtr instance;
  IntPtr window;
  bool classRegistered;
  bool inputRegistered;
  bool disposed;
  bool pumping;
  ExceptionDispatchInfo callbackError;

  internal RawGamepadInput(Action<int, string, XGamepad> onInput, Action<int> onDisconnected) {
    if (onInput == null) throw new ArgumentNullException("onInput");
    if (onDisconnected == null) throw new ArgumentNullException("onDisconnected");
    this.onInput = onInput;
    this.onDisconnected = onDisconnected;
    if (Interlocked.CompareExchange(ref current, this, null) != null)
      throw new InvalidOperationException("A Raw Input gamepad window already exists.");

    try {
      instance = GetModuleHandleW(null);
      if (instance == IntPtr.Zero) throw LastError("GetModuleHandleW");
      var windowClass = new WindowClass {
        Procedure = Marshal.GetFunctionPointerForDelegate(windowProcedure), Instance = instance, Name = className
      };
      if (RegisterClassW(ref windowClass) == 0) throw LastError("RegisterClassW");
      classRegistered = true;
      window = CreateWindowExW(0, className, null, 0, 0, 0, 0, 0, MessageOnlyWindow, IntPtr.Zero, instance, IntPtr.Zero);
      if (window == IntPtr.Zero) throw LastError("CreateWindowExW");
      if (!RegisterDevices(RIDEV_INPUTSINK | RIDEV_DEVNOTIFY, window)) throw LastError("RegisterRawInputDevices");
      inputRegistered = true;
      EnumerateDevices(); // Subscribe before taking the snapshot so hotplug is not lost.
    } catch {
      Release();
      throw;
    }
  }

  internal void WaitAndDispatch(WaitHandle stop, int timeoutMs) {
    CheckThread();
    if (disposed) throw new ObjectDisposedException("RawGamepadInput");
    if (pumping) throw new InvalidOperationException("The gamepad message pump cannot be reentered.");
    if (stop == null) throw new ArgumentNullException("stop");
    if (timeoutMs < Timeout.Infinite) throw new ArgumentOutOfRangeException("timeoutMs");
    pumping = true;
    try {
      WaitAndDispatchCore(stop, timeoutMs);
    } finally {
      pumping = false;
    }
  }

  void WaitAndDispatchCore(WaitHandle stop, int timeoutMs) {
    long started = Stopwatch.GetTimestamp();
    long nextOpen = long.MaxValue;
    uint handleCount = 1;
    foreach (var device in sonyDevices) {
      OpenReaderIfDue(device, started);
      if (device.Reader != null) waitHandles[handleCount++] = device.Reader.ReadyHandle;
      else if (device.NextOpen < nextOpen) nextOpen = device.NextOpen;
    }
    long now = Stopwatch.GetTimestamp();
    if (timeoutMs != Timeout.Infinite)
      timeoutMs = Math.Max(0, timeoutMs - (int)((now - started) * 1000 / Stopwatch.Frequency));
    if (nextOpen != long.MaxValue) {
      int retryMs = (int)Math.Ceiling(Math.Max(0, nextOpen - now) * 1000.0 / Stopwatch.Frequency);
      timeoutMs = timeoutMs == Timeout.Infinite ? retryMs : Math.Min(timeoutMs, retryMs);
    }

    SafeWaitHandle safeStop = stop.SafeWaitHandle;
    bool addedRef = false;
    uint result;
    try {
      safeStop.DangerousAddRef(ref addedRef);
      waitHandles[0] = safeStop.DangerousGetHandle();
      result = MsgWaitForMultipleObjectsEx(handleCount, waitHandles, unchecked((uint)timeoutMs), QS_ALLINPUT, MWMO_INPUTAVAILABLE);
      if (result == WAIT_FAILED) throw LastError("MsgWaitForMultipleObjectsEx");
    } finally {
      if (addedRef) safeStop.DangerousRelease();
    }
    ThrowCallbackError();
    if (result == WAIT_OBJECT_0 || result == WAIT_TIMEOUT) return;
    if (result > WAIT_OBJECT_0 + handleCount) throw new Win32Exception(0, "Unexpected gamepad wait result: " + result);

    // Service hotplug before reads, even when a continuously ready HID handle won the wait.
    PumpMessages();
    foreach (var device in sonyDevices) {
      var reader = device.Reader;
      if (reader == null) continue;
      int read = reader.Complete();
      if (read == 0) continue;
      if (read > 0) {
        if (Publish(device, reader.Report, 0, read)) device.Retries = 0;
        if (reader.BeginRead()) continue;
      }
      device.CloseReader();
      device.RetryOpen();
      Disconnect(device);
    }
  }

  static void OpenReaderIfDue(Device device, long now) {
    if (device.Reader != null || device.NextOpen > now) return;
    device.Reader = HidReader.Open(device.Handle);
    if (device.Reader == null) device.RetryOpen();
  }

  void PumpMessages() {
    // INPUTAVAILABLE also wakes for messages already observed but not yet removed.
    long started = Stopwatch.GetTimestamp();
    for (int i = 0; i < MaxMessagesPerPump; i++) {
      WindowMessage message;
      bool available = PeekMessageW(out message, IntPtr.Zero, 0, 0, PM_REMOVE);
      ThrowCallbackError(); // PeekMessage 也会递送线程收到的非排队消息。
      if (!available) break;
      if (message.Message == WM_QUIT) throw new Win32Exception(0, "The gamepad message thread received WM_QUIT.");
      DispatchMessageW(ref message);
      ThrowCallbackError();
      if (Stopwatch.GetTimestamp() - started >= PumpBudget) break;
    }
  }

  static IntPtr WindowCallback(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam) {
    RawGamepadInput input = current;
    if (input != null && hwnd == input.window && (message == WM_INPUT || message == WM_INPUT_DEVICE_CHANGE)) {
      if (input.inputRegistered && input.callbackError == null) {
        try {
          if (message == WM_INPUT) input.ReadInput(lParam);
          else input.DeviceChanged(wParam.ToUInt64(), lParam);
        } catch (Exception error) {
          // 异常留在托管消息泵抛出，不能跨出 Win32 WindowProc。
          input.callbackError = ExceptionDispatchInfo.Capture(error);
        }
      }
      if (message == WM_INPUT_DEVICE_CHANGE) return IntPtr.Zero;
    }
    // 让系统清理 WM_INPUT，前台输入要求调用默认窗口过程。
    return DefWindowProcW(hwnd, message, wParam, lParam);
  }

  void EnumerateDevices() {
    for (int attempt = 0; attempt < 3; attempt++) {
      uint count = 0;
      if (GetRawInputDeviceList(IntPtr.Zero, ref count, DeviceListEntryBytes) != 0 || count == 0 || count > 4096) return;
      var entries = new RawDeviceListEntry[count];
      uint read = GetRawInputDeviceList(entries, ref count, DeviceListEntryBytes);
      if (read == uint.MaxValue && Marshal.GetLastWin32Error() == ERROR_INSUFFICIENT_BUFFER) continue;
      if (read > entries.Length) return;
      for (int i = 0; i < read; i++) {
        if (entries[i].Type == RIM_TYPEHID && entries[i].Handle != IntPtr.Zero) FindDevice(entries[i].Handle);
      }
      return;
    }
  }

  void DeviceChanged(ulong change, IntPtr handle) {
    if (handle == IntPtr.Zero) return;
    if (change == GIDC_ARRIVAL) {
      FindDevice(handle);
    } else if (change == GIDC_REMOVAL) {
      Device device;
      if (!devices.TryGetValue(handle, out device)) return;
      devices.Remove(handle);
      if (device == null) return;
      sonyDevices.Remove(device);
      device.CloseReader();
      Disconnect(device);
    }
  }

  void Disconnect(Device device) {
    if (device.Slot < FirstSonySlot) return;
    int slot = device.Slot;
    device.Slot = 0;
    onDisconnected(slot);
  }

  static bool IsGamepad(ushort page, ushort usage) {
    return page == GenericDesktop && (usage == Joystick || usage == Gamepad);
  }

  Device FindDevice(IntPtr handle) {
    Device device;
    if (devices.TryGetValue(handle, out device)) return device;
    uint size = DeviceInfoBytes;
    var info = new RawDeviceInfo { Size = size };
    if (GetRawInputDeviceInfoW(handle, RIDI_DEVICEINFO, ref info, ref size) == uint.MaxValue) return null;
    string model;
    if (info.Type == RIM_TYPEHID && IsGamepad(info.UsagePage, info.Usage) && SonyGamepad.TryGetModel(info.Vendor, info.Product, out model)) {
      if (sonyDevices.Count == MaxSonyDevices) return null;
      device = new Device(handle, model);
      sonyDevices.Add(device);
    }
    devices.Add(handle, device);
    return device;
  }

  void ReadInput(IntPtr rawInput) {
    uint size = (uint)HeaderBytes;
    RawInputHeader header;
    uint read = GetRawInputData(rawInput, RID_HEADER, out header, ref size, (uint)HeaderBytes);
    if (read != HeaderBytes || header.Type != RIM_TYPEHID || header.Device == IntPtr.Zero ||
        header.Size < ReportOffset || header.Size > MaxPacketBytes) return;
    Device device = FindDevice(header.Device);
    if (device == null) return;
    // Arrival and input can already be queued together; give the direct reader the first chance.
    if (device.Reader == null) OpenReaderIfDue(device, Stopwatch.GetTimestamp());
    if (device.Reader != null) return;

    if (header.Size > packet.Length)
      packet = new byte[Math.Min(MaxPacketBytes, Math.Max((int)header.Size, packet.Length * 2))];
    size = (uint)packet.Length;
    read = GetRawInputData(rawInput, RID_INPUT, packet, ref size, (uint)HeaderBytes);
    if (read != header.Size || read > packet.Length) return;
    uint reportBytes = BitConverter.ToUInt32(packet, HeaderBytes);
    uint count = BitConverter.ToUInt32(packet, HeaderBytes + sizeof(uint));
    if (reportBytes == 0 || count == 0 || count > (read - ReportOffset) / reportBytes) return;

    int length = (int)reportBytes;
    int offset = ReportOffset;
    for (int i = 0; i < (int)count; i++, offset += length) Publish(device, packet, offset, length);
  }

  bool Publish(Device device, byte[] bytes, int offset, int length) {
    XGamepad pad;
    if (!SonyGamepad.TryDecode(device.Model, bytes, offset, length, out pad)) return false;
    if (device.Slot < FirstSonySlot) {
      if (nextSlot > int.MaxValue) return false;
      device.Slot = (int)nextSlot++;
    }
    onInput(device.Slot, device.Model, pad);
    return true;
  }

  bool RegisterDevices(uint flags, IntPtr target) {
    for (int i = 0; i < registrations.Length; i++) {
      registrations[i].Flags = flags;
      registrations[i].Target = target;
    }
    return RegisterRawInputDevices(registrations, (uint)registrations.Length, RegistrationBytes);
  }

  static Win32Exception LastError(string operation) {
    int code = Marshal.GetLastWin32Error();
    return new Win32Exception(code, operation + " failed (" + code + "): " + new Win32Exception(code).Message);
  }

  void ThrowCallbackError() {
    if (callbackError == null) return;
    ExceptionDispatchInfo error = callbackError;
    callbackError = null;
    error.Throw();
  }

  void CheckThread() {
    if (Thread.CurrentThread.ManagedThreadId != ownerThread)
      throw new InvalidOperationException("The Raw Input window must be used on its owning thread.");
  }

  public void Dispose() {
    CheckThread();
    if (disposed) return;
    if (pumping) throw new InvalidOperationException("The gamepad message pump cannot be disposed by a callback.");
    disposed = true;
    Release();
  }

  void Release() {
    if (inputRegistered) {
      inputRegistered = false;
      RegisterDevices(RIDEV_REMOVE, IntPtr.Zero);
    }
    foreach (var device in sonyDevices) device.CloseReader();
    sonyDevices.Clear();
    devices.Clear();
    if (window != IntPtr.Zero) {
      DestroyWindow(window);
      window = IntPtr.Zero;
    }
    if (classRegistered) {
      UnregisterClassW(className, instance);
      classRegistered = false;
    }
    Interlocked.CompareExchange(ref current, null, this);
  }
}
