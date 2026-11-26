'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { crc32 } = require('node:zlib');
const { SOURCE, compileGamepadHelper } = require('./build-gamepad-helper');

const NEUTRAL = [0, 0, 0, 0, 0, 0, 0];
const DS4 = 'dualshock4';
const DS5 = 'dualsense';
const EDGE = 'dualsense-edge';

function fromHex(hex) {
  return Buffer.from(hex.replace(/\s/g, ''), 'hex');
}

function packet(size, hex, fill = 0) {
  const report = Buffer.alloc(size, fill);
  const prefix = fromHex(hex);
  assert.ok(prefix.length <= size);
  prefix.copy(report);
  return report;
}

function signBluetooth(report, hidp = 0xa1) {
  const checksumOffset = report.length - 4;
  const input = Buffer.concat([Buffer.from([hidp]), report.subarray(0, checksumOffset)]);
  report.writeUInt32LE(crc32(input), checksumOffset);
  return report;
}

function casesForReplay() {
  const cases = [];
  function identify(label, vendor, product, model) {
    cases.push({ label, input: `model ${vendor} ${product}`, expected: model ? `1 ${model}` : '0 -' });
  }
  // 每条期望按 wButtons、L2、R2、LX、LY、RX、RY 的顺序记录。
  function decode(label, model, bytes, expected, { offset = 0, length = bytes?.length ?? 0 } = {}) {
    const input = `decode ${model ?? '-'} ${offset} ${length} ${bytes?.toString('base64') ?? '-'}`;
    cases.push({ label, input, expected: (expected ? [1, ...expected] : [0, ...NEUTRAL]).join(' ') });
  }

  identify('Sony DualShock 4 v1', 0x054c, 0x05c4, DS4);
  identify('Sony DualShock 4 v2', 0x054c, 0x09cc, DS4);
  identify('Sony DualSense', 0x054c, 0x0ce6, DS5);
  identify('Sony DualSense Edge', 0x054c, 0x0df2, EDGE);
  identify('Sony DS4 wireless adaptor is outside the model whitelist', 0x054c, 0x0ba0, null);
  identify('Sony DualShock 3', 0x054c, 0x0268, null);
  identify('Sony product adjacent to DS4 v1', 0x054c, 0x05c5, null);
  identify('Non-Sony vendor with the same product number', 0x045e, 0x0ce6, null);
  identify('Vendor high bits', 0x1000054c, 0x05c4, null);
  identify('Product high bits', 0x054c, 0x100005c4, null);
  identify('Unknown Sony product', 0x054c, 0xffffffff, null);

  const ds4Usb = packet(64, '01 ff 00 00 ff 15 d3 fc 11 e2');
  decode('DS4 USB full report', DS4, ds4Usb, [0x43e6, 17, 226, 32767, 32767, -32768, -32768]);
  const ds4BasicHex = '01 00 ff ff 00 21 68 fe 00 ff';
  for (const size of [10, 78, 128, 547]) {
    decode(`DS4 basic Bluetooth (${size} bytes)`, DS4, packet(size, ds4BasicHex, 0xa5),
      [0x1059, 0, 255, -32768, -32768, 32767, 32767]);
  }

  const ds4Full = signBluetooth(packet(78, '11 c0 7f 7f 7f 81 81 46 8c ff 01 fe'));
  for (const size of [78, 128, 547]) {
    const report = Buffer.concat([ds4Full, Buffer.alloc(size - ds4Full.length, 0xa5)]);
    decode(`DS4 enhanced Bluetooth (${size} bytes)`, DS4, report, [0x2084, 1, 254, -256, 255, 258, -258]);
  }

  // 公开的 DS4 HCI 抓包含原始 CRC。用它独立核对 0x11 布局及非零 offset。
  // https://www.psdevwiki.com/ps4/index.php?title=Talk:DualShock_4&diff=next&oldid=266107
  const hciCapture = fromHex(`
    02 15 20 53 00 4f 00 42 00 a1 11 c0 00 83 81 7e
    7e 08 00 3c 00 00 83 a2 07 f1 ff f9 ff 04 00 21
    03 17 1f 29 f9 00 00 00 00 00 08 00 00 00 00 80
    00 00 00 80 00 00 00 00 80 00 00 00 80 00 00 00
    00 80 00 00 00 80 00 00 00 00 80 00 00 00 80 00
    00 00 00 00 7d 0a 5d 0b`);
  decode('Published DS4 Bluetooth capture sliced at the report ID', DS4, hciCapture,
    [0, 0, 0, 774, -258, -512, 511], { offset: 10, length: 78 });
  decode('USB/BT parser rejects an HCI wrapper', DS4, hciCapture, null);
  decode('USB/BT parser rejects a HIDP wrapper', DS4, hciCapture, null, { offset: 9, length: 79 });

  // 两种 0x01 报告的前 10 字节相同，偏移不同的按钮和扳机应解出不同值。
  const ds5SharedHex = '01 80 80 e0 20 12 c0 ff 29 40';
  const ds5Usb = packet(64, `${ds5SharedHex} f7 a5`, 0xff);
  const ds5UsbExpected = [0x1040, 18, 192, 0, 0, 24768, 24575];
  decode('DS5 USB full 0x01', DS5, ds5Usb, ds5UsbExpected);
  decode('DualSense Edge USB full 0x01', EDGE, ds5Usb, ds5UsbExpected);
  for (const size of [10, 78]) {
    const report = packet(size, ds5SharedHex, 0xa5);
    const expected = [0x40c8, 41, 64, 0, 0, 24768, 24575];
    decode(`DS5 basic Bluetooth 0x01 (${size} bytes)`, DS5, report, expected);
    decode(`DualSense Edge basic Bluetooth 0x01 (${size} bytes)`, EDGE, report, expected);
  }
  const interrupt = Buffer.concat([fromHex('31 ff 00'), ds5Usb, ds4Usb]);
  decode('DS5 USB in a larger batched input buffer', DS5, interrupt, ds5UsbExpected, { offset: 3, length: 64 });

  const ds5FullHex = '31 f1 80 80 00 ff 00 80 fd 87 b2 ff 9a';
  const ds5Full = signBluetooth(packet(78, ds5FullHex));
  const ds5FullExpected = [0x82b5, 0, 128, 0, 0, -32768, -32768];
  decode('DS5 enhanced Bluetooth 0x31', DS5, ds5Full, ds5FullExpected);
  decode('DualSense Edge enhanced Bluetooth with extra buttons set', EDGE, ds5Full, ds5FullExpected);
  decode('No report after a previously active pad', DS5, null, null, { length: 10 });
  decode('DS5 still decodes after a missing report', DS5, ds5Full, ds5FullExpected);
  decode('DS5 centered sticks and released buttons/triggers after active report', DS5,
    packet(64, '01 80 80 80 80 00 00 f0 08 00 ef'), NEUTRAL);

  const hats = [1, 9, 8, 10, 2, 6, 4, 5, 0, 0, 0, 0, 0, 0, 0, 0];
  const resting = packet(10, '01 80 80 80 80 08 00 00 00 00');
  for (const [hat, buttonMask] of hats.entries()) {
    const report = Buffer.from(resting);
    report[5] = hat;
    decode(`Hat ${hat}`, DS4, report, [buttonMask, ...NEUTRAL.slice(1)]);
  }
  for (const [label, index, bit, expected] of [
    ['Square', 5, 0x10, 0x4000], ['Cross', 5, 0x20, 0x1000],
    ['Circle', 5, 0x40, 0x2000], ['Triangle', 5, 0x80, 0x8000],
    ['L1', 6, 0x01, 0x0100], ['R1', 6, 0x02, 0x0200],
    ['L2 digital flag', 6, 0x04, 0], ['R2 digital flag', 6, 0x08, 0],
    ['Create', 6, 0x10, 0x0020], ['Options', 6, 0x20, 0x0010],
    ['L3', 6, 0x40, 0x0040], ['R3', 6, 0x80, 0x0080],
    ['PS/touchpad/mic/counter flags', 7, 0xff, 0]
  ]) {
    const report = Buffer.from(resting);
    report[index] |= bit;
    decode(`Basic report button ${label}`, DS5, report, [expected, ...NEUTRAL.slice(1)]);
  }

  decode('No report bytes', DS4, Buffer.alloc(0), null);
  decode('Unknown model', 'xinput', ds4Usb, null);
  decode('Null model', null, ds5Usb, null);
  decode('Unexpected report ID', DS5, packet(64, '02'), null);
  decode('Unexpected leading report ID byte', DS5, packet(64, '00 01 80 80 80 80'), null);
  decode('DualShock 4 rejects DualSense extended ID', DS4, ds5Full, null);
  decode('DualSense rejects DualShock 4 extended ID', DS5, ds4Full, null);
  decode('Unlisted DS4 Bluetooth report ID', DS4, signBluetooth(packet(78, '12 c0')), null);
  decode('DS4 Bluetooth header without HID input flag', DS4, signBluetooth(packet(78, '11 40')), null);
  const ds4BadCrc = Buffer.from(ds4Full);
  ds4BadCrc[5] ^= 1;
  decode('DS4 corrupted payload after checksum', DS4, ds4BadCrc, null);
  const ds5BadCrc = Buffer.from(ds5Full);
  ds5BadCrc[77] ^= 1;
  decode('DS5 corrupted checksum', DS5, ds5BadCrc, null);
  decode('DS5 CRC with output HIDP seed', DS5, signBluetooth(packet(78, ds5FullHex), 0xa2), null);
  decode('DS4 extended report truncated at CRC', DS4, ds4Full, null, { length: 77 });
  decode('DS5 extended report truncated at CRC', DS5, ds5Full, null, { length: 77 });
  decode('DS4 extended report above its declared maximum size', DS4,
    Buffer.concat([ds4Full, Buffer.alloc(470)]), null);
  decode('DS5 extended report above its declared size', DS5,
    Buffer.concat([ds5Full, Buffer.alloc(1)]), null);

  for (const size of [1, 9, 11, 63, 65, 77, 79]) {
    decode(`DS5 0x01 rejects unlisted length ${size}`, DS5, packet(size, '01'), null);
  }
  for (const size of [9, 11, 63, 548]) {
    decode(`DS4 0x01 rejects unlisted length ${size}`, DS4, packet(size, '01'), null);
  }
  for (const [offset, length] of [[-1, 10], [0, -1], [0, 0], [64, 1], [3, 64],
    [-2147483648, 10], [2147483647, 10], [3, 2147483647]]) {
    decode(`Report bounds ${offset}/${length}`, DS5, ds5Usb, null, { offset, length });
  }
  return cases;
}

const REPLAY = `
internal static class SonyGamepadTest {
  static int Main() {
    try {
      var culture = System.Globalization.CultureInfo.InvariantCulture;
      string line;
      XGamepad pad = default(XGamepad);
      while ((line = Console.ReadLine()) != null) {
        string[] fields = line.Split(' ');
        if (fields[0] == "model") {
          string model;
          bool identified = SonyGamepad.TryGetModel(uint.Parse(fields[1], culture), uint.Parse(fields[2], culture), out model);
          Console.WriteLine("{0} {1}", identified ? 1 : 0, model ?? "-");
        } else {
          string model = fields[1] == "-" ? null : fields[1];
          byte[] report = fields[4] == "-" ? null : Convert.FromBase64String(fields[4]);
          bool decoded = SonyGamepad.TryDecode(model, report, int.Parse(fields[2], culture), int.Parse(fields[3], culture), out pad);
          Console.WriteLine(string.Format(culture, "{0} {1} {2} {3} {4} {5} {6} {7}", decoded ? 1 : 0,
            pad.wButtons, pad.bLeftTrigger, pad.bRightTrigger, pad.sThumbLX, pad.sThumbLY, pad.sThumbRX, pad.sThumbRY));
        }
      }
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine(error);
      return 1;
    }
  }
}
`;

if (process.platform !== 'win32') {
  console.log('SKIP  Sony gamepad report replay requires Windows');
} else {
  const cases = casesForReplay();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gifa-sony-test-'));
  try {
    const fixture = path.join(directory, 'GamepadPoller.cs');
    fs.writeFileSync(fixture, fs.readFileSync(SOURCE, 'utf8') + '\n' + REPLAY);
    const replay = compileGamepadHelper(path.join(directory, 'SonyGamepadTest.exe'), fixture, { entryPoint: 'SonyGamepadTest' });
    const actual = execFileSync(replay, [], {
      cwd: directory,
      encoding: 'utf8',
      input: cases.map(({ input }) => input).join('\n') + '\n',
      timeout: 15000,
      windowsHide: true
    }).trimEnd().split(/\r?\n/);
    assert.equal(actual.length, cases.length, 'Sony report replay output count');
    for (const [index, { label, expected }] of cases.entries()) {
      assert.equal(actual[index], expected, label);
    }
    console.log(`PASS  Windows Sony gamepad report replay (${cases.length} cases)`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
