// SPDX-License-Identifier: GPL-3.0-only
internal static class SonyGamepad {
  const string DualShock4 = "dualshock4";
  const string DualSense = "dualsense";
  const string DualSenseEdge = "dualsense-edge";

  const byte BasicReportId = 0x01;
  const byte DualShock4BluetoothReportId = 0x11;
  const byte DualSenseBluetoothReportId = 0x31;
  const int BasicReportSize = 10;
  const int UsbReportSize = 64;
  const int BluetoothReportSize = 78;
  const int DualShock4LongBufferSize = 128;
  const int DualShock4MaxReportSize = 547;

  static readonly uint[] CrcTable = CreateCrcTable();

  // Sony 产品编号与 Edge 的共用输入布局见 Linux 和 SDL。
  // https://github.com/torvalds/linux/blob/master/drivers/hid/hid-ids.h
  // https://github.com/torvalds/linux/blob/master/drivers/hid/hid-playstation.c
  internal static bool TryGetModel(uint vendor, uint product, out string model) {
    model = null;
    if (vendor != 0x054c) return false;
    switch (product) {
      case 0x05c4:
      case 0x09cc: model = DualShock4; return true;
      case 0x0ce6: model = DualSense; return true;
      case 0x0df2: model = DualSenseEdge; return true;
      default: return false;
    }
  }

  // offset 指向报告 ID。Windows RAWHID 的 dwSizeHid 包含 ID 和该份报告的填充。
  // https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-rawhid
  internal static bool TryDecode(string model, byte[] bytes, int offset, int length, out XGamepad pad) {
    pad = default(XGamepad);
    if (bytes == null || offset < 0 || offset > bytes.Length || length <= 0 || length > bytes.Length - offset) {
      return false;
    }

    int sticks;
    int buttons;
    int triggers;
    byte id = bytes[offset];
    switch (model) {
      case DualShock4:
        // 0x01 的 USB 全报与蓝牙简报共用前 10 字节的布局。
        // SDL 的 Windows 读取路径记录了 128 字节的报告。DS4 蓝牙描述符的最大输入报告为 547 字节。
        // https://github.com/libsdl-org/SDL/blob/main/src/joystick/hidapi/SDL_hidapi_ps4.c
        // https://github.com/torvalds/linux/blob/19f4c2ba869517048add62c202f9645b6adf5dfb/drivers/hid/hid-sony.c
        if (id == BasicReportId && (length == BasicReportSize || length == UsbReportSize ||
            length == BluetoothReportSize || length == DualShock4LongBufferSize || length == DualShock4MaxReportSize)) {
          sticks = offset + 1;
        } else if (id == DualShock4BluetoothReportId && length >= BluetoothReportSize &&
            length <= DualShock4MaxReportSize && (bytes[offset + 1] & 0x80) != 0 && HasBluetoothCrc(bytes, offset)) {
          sticks = offset + 3;
        } else {
          return false;
        }
        buttons = sticks + 4;
        triggers = sticks + 7;
        break;
      case DualSense:
      case DualSenseEdge:
        // 0x01 USB 全报为 64 字节。SDL 以 10 或 78 字节识别蓝牙简报，后者含 Windows 填充。
        // 0x31 蓝牙全报的轴数据位于 ID 和标头之后，沿用 USB 全报的字段顺序。
        // https://github.com/libsdl-org/SDL/blob/main/src/joystick/hidapi/SDL_hidapi_ps5.c
        if (id == BasicReportId && (length == BasicReportSize || length == BluetoothReportSize)) {
          sticks = offset + 1;
          buttons = sticks + 4;
          triggers = sticks + 7;
        } else {
          if (id == BasicReportId && length == UsbReportSize) {
            sticks = offset + 1;
          } else if (id == DualSenseBluetoothReportId && length == BluetoothReportSize && HasBluetoothCrc(bytes, offset)) {
            sticks = offset + 2;
          } else {
            return false;
          }
          buttons = sticks + 7;
          triggers = sticks + 4;
        }
        break;
      default:
        return false;
    }

    pad.sThumbLX = DecodeAxis(bytes[sticks], false);
    pad.sThumbLY = DecodeAxis(bytes[sticks + 1], true);
    pad.sThumbRX = DecodeAxis(bytes[sticks + 2], false);
    pad.sThumbRY = DecodeAxis(bytes[sticks + 3], true);
    pad.wButtons = DecodeButtons(bytes[buttons], bytes[buttons + 1]);
    pad.bLeftTrigger = bytes[triggers];
    pad.bRightTrigger = bytes[triggers + 1];
    return true;
  }

  static short DecodeAxis(byte raw, bool invert) {
    int centered = raw - 128;
    int inputRange = centered < 0 ? 128 : 127;
    int signed = invert ? -centered : centered;
    int outputRange = signed < 0 ? 32768 : 32767;
    return (short)(signed * outputRange / inputRange);
  }

  // wButtons 与 XINPUT_GAMEPAD 的按钮位一致。第三个 Sony 按钮字节不参与映射。
  // https://learn.microsoft.com/windows/win32/api/xinput/ns-xinput-xinput_gamepad
  static ushort DecodeButtons(byte faceAndHat, byte shouldersAndSticks) {
    int buttons = 0;
    if ((faceAndHat & 0x10) != 0) buttons |= 0x4000; // Square
    if ((faceAndHat & 0x20) != 0) buttons |= 0x1000; // Cross
    if ((faceAndHat & 0x40) != 0) buttons |= 0x2000; // Circle
    if ((faceAndHat & 0x80) != 0) buttons |= 0x8000; // Triangle
    if ((shouldersAndSticks & 0x01) != 0) buttons |= 0x0100; // L1
    if ((shouldersAndSticks & 0x02) != 0) buttons |= 0x0200; // R1
    if ((shouldersAndSticks & 0x10) != 0) buttons |= 0x0020; // Share / Create
    if ((shouldersAndSticks & 0x20) != 0) buttons |= 0x0010; // Options
    if ((shouldersAndSticks & 0x40) != 0) buttons |= 0x0040; // L3
    if ((shouldersAndSticks & 0x80) != 0) buttons |= 0x0080; // R3

    switch (faceAndHat & 0x0f) {
      case 0: buttons |= 0x0001; break;
      case 1: buttons |= 0x0009; break;
      case 2: buttons |= 0x0008; break;
      case 3: buttons |= 0x000a; break;
      case 4: buttons |= 0x0002; break;
      case 5: buttons |= 0x0006; break;
      case 6: buttons |= 0x0004; break;
      case 7: buttons |= 0x0005; break;
    }
    return (ushort)buttons;
  }

  static bool HasBluetoothCrc(byte[] bytes, int offset) {
    // HIDP 的输入标头 0xa1 参与 CRC-32。缓冲区从报告 ID 开始，CRC 在原始 78 字节报告的末 4 字节。
    int crcOffset = offset + BluetoothReportSize - 4;
    uint expected = (uint)bytes[crcOffset] | ((uint)bytes[crcOffset + 1] << 8) |
      ((uint)bytes[crcOffset + 2] << 16) | ((uint)bytes[crcOffset + 3] << 24);
    uint crc = UpdateCrc(0xffffffffu, 0xa1);
    for (int index = offset; index < crcOffset; index++) crc = UpdateCrc(crc, bytes[index]);
    return ~crc == expected;
  }

  static uint UpdateCrc(uint crc, byte value) {
    return (crc >> 8) ^ CrcTable[(crc ^ value) & 0xff];
  }

  static uint[] CreateCrcTable() {
    var table = new uint[256];
    for (uint value = 0; value < table.Length; value++) {
      uint crc = value;
      for (int bit = 0; bit < 8; bit++) {
        crc = (crc >> 1) ^ ((crc & 1) == 0 ? 0u : 0xedb88320u);
      }
      table[value] = crc;
    }
    return table;
  }
}
