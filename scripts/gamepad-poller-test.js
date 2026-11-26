'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { SOURCE, compileGamepadHelper, ensureDevGamepadHelper } = require('./build-gamepad-helper');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stdin = { destroyed: false, destroy: () => { this.stdin.destroyed = true; } };
    this.pid = FakeChild.nextPid++;
    this.killCalls = 0;
  }

  kill() {
    this.killCalls += 1;
    this.emit('exit', null, 'SIGTERM');
    this.emit('close', null, 'SIGTERM');
    return true;
  }
}
FakeChild.nextPid = 100;

const children = [];
const pendingTimers = [];
const originalLoad = Module._load;
const originalSetTimeout = global.setTimeout;
const originalClearTimeout = global.clearTimeout;
let launch;
Module._load = function (request, parent, isMain) {
  if (request === 'node:child_process') return { spawn(file, args, options) {
    launch = { file, args, options };
    const child = new FakeChild();
    children.push(child);
    return child;
  } };
  return originalLoad.call(this, request, parent, isMain);
};
global.setTimeout = (callback) => {
  const timer = { callback, cleared: false };
  pendingTimers.push(timer);
  return timer;
};
global.clearTimeout = (timer) => { if (timer) timer.cleared = true; };

let gamepad;
try {
  gamepad = require(path.join(__dirname, '..', 'src', 'gamepad.js'));
} finally {
  Module._load = originalLoad;
}

function frame(slot, button = 1) {
  return JSON.stringify({ slot, b: button, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
}
function line(child, value) {
  child.stdout.emit('data', Buffer.from(value));
}
function run(label, callback) {
  try {
    callback();
    console.log('PASS  ' + label);
  } catch (error) {
    console.error('FAIL  ' + label + '\n' + error.stack);
    process.exitCode = 1;
  }
}

run('start is idempotent and accepts a replacement callback', () => {
  const first = [];
  const second = [];
  gamepad.start((value) => first.push(value));
  gamepad.start((value) => second.push(value));
  assert.equal(children.length, 1);
  line(children[0], frame(2) + '\n');
  assert.equal(first.length, 0);
  assert.equal(second.length, 1);
  assert.equal(second[0].slot, 2);
  assert.equal(second[0].connected, true);
});

run('fragmented stdout is buffered per process', () => {
  const child = children[0];
  line(child, frame(1).slice(0, 12));
  line(child, frame(1).slice(12) + '\n');
  assert.equal(children.length, 1);
});

run('exit emits one disconnected frame and schedules a restart', () => {
  const child = children[0];
  const calls = [];
  gamepad.start((value) => calls.push(value));
  child.emit('exit', 3, null);
  child.emit('close', 3, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].connected, false);
  assert.equal(pendingTimers.filter((timer) => !timer.cleared).length, 1);
});

run('stop then start ignores old process output', () => {
  const oldChild = children[0];
  gamepad.stop();
  const calls = [];
  gamepad.start((value) => calls.push(value));
  assert.equal(children.length, 2);
  line(oldChild, frame(0) + '\n');
  assert.equal(calls.length, 0);
  line(children[1], frame(3) + '\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].slot, 3);
});

run('error emits disconnected frame and kills the process', () => {
  const child = children[1];
  const calls = [];
  gamepad.start((value) => calls.push(value));
  child.emit('error', new Error('mock failure'));
  assert.equal(calls.at(-1).connected, false);
  assert.equal(child.killCalls, 1);
  gamepad.stop();
});

run('accepts Sony slots and preserves the slot of a disconnected device', () => {
  const calls = [];
  gamepad.start((value) => calls.push(value));
  const child = children.at(-1);
  line(child, JSON.stringify({ slot: 4, model: 'dualshock4', b: 0x40, rx: 32767 }) + '\n');
  line(child, JSON.stringify({ slot: 5, model: 'dualsense', b: 0, ry: 32767 }) + '\n');
  line(child, '{"slot":4,"none":1}\n');
  line(child, '{"slot":6,"model":"unknown","b":64}\n');
  line(child, '{"slot":0,"model":"dualsense","b":64}\n');
  assert.deepEqual(calls.map(({ slot, model, connected }) => [slot, model, connected]), [
    [4, 'dualshock4', true], [5, 'dualsense', true], [4, undefined, false]
  ]);
  assert.equal(calls[0].buttons[10], 1);
  assert.equal(calls[0].axes[2], 1);
  assert.equal(calls[1].axes[3], -1);
  gamepad.stop();
});

run('unavailable report emits disconnected frame without restart', () => {
  const calls = [];
  gamepad.start((value) => calls.push(value));
  const child = children.at(-1);
  child.emit('exit', 1, null);
  assert.equal(calls.length, 0);
  line(child, '{"error":"gamepad-backends-unavailable"}\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].connected, false);
  assert.equal(child.killCalls, 1);
  assert.equal(pendingTimers.filter((timer) => !timer.cleared).length, 0);
  gamepad.stop();
});

global.setTimeout = originalSetTimeout;
global.clearTimeout = originalClearTimeout;

async function replayWindowsHelper() {
  const samples = [];
  const expected = [];
  const pad = { b: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 };
  function sample(slotMask, packet, changes, reportedSlots = [], removedSlots = []) {
    Object.assign(pad, changes);
    samples.push([slotMask, packet, ...Object.values(pad)]);
    for (const slot of reportedSlots) expected.push(JSON.stringify({ slot, model: 'xinput', ...pad }));
    for (const slot of removedSlots) expected.push(JSON.stringify({ slot, none: 1 }));
  }
  expected.push('{"none":1}');
  sample(0, 0, {});
  sample(0, 0, {});
  sample(8, 1, {}, [3]);
  sample(8, 2, {});
  sample(10, 2, {}, [1]);
  sample(10, 2, { b: 64 }, [1, 3]);
  sample(10, 2, { b: 0 }, [1, 3]);
  for (const [field, value] of [['lt', 1], ['rt', 255], ['lx', -32768], ['ly', 32767], ['rx', -1], ['rx', 0], ['ry', 1]]) {
    sample(10, 2, { [field]: value }, [1, 3]);
  }
  sample(8, 2, {}, [], [1]);
  sample(0, 2, {}, [], [3]);
  sample(0, 2, {});
  sample(4, 2, {}, [2]);
  sample(15, 2, { b: 65535 }, [0, 1, 2, 3]);

  const nativeBinding = 'static GetStateFn fn;';
  const fixtureBinding = `static GetStateFn fn = ReadFixture;
    static readonly int[,] samples = { ${samples.map(row => '{' + row.join(',') + '}').join(',')} };
    static int tick = -1;
    static uint nextSlot;
    static uint ReadFixture(uint slot, out XState state) {
      if (slot != nextSlot) throw new InvalidOperationException("unexpected slot order");
      if (slot == 0) tick = Math.Min(tick + 1, samples.GetLength(0) - 1);
      state = new XState();
      nextSlot = (slot + 1) % 4;
      if ((samples[tick, 0] & (1 << (int)slot)) == 0) return 1167;
      state.dwPacketNumber = (uint)samples[tick, 1];
      state.Gamepad.wButtons = (ushort)samples[tick, 2];
      state.Gamepad.bLeftTrigger = (byte)samples[tick, 3];
      state.Gamepad.bRightTrigger = (byte)samples[tick, 4];
      state.Gamepad.sThumbLX = (short)samples[tick, 5];
      state.Gamepad.sThumbLY = (short)samples[tick, 6];
      state.Gamepad.sThumbRX = (short)samples[tick, 7];
      state.Gamepad.sThumbRY = (short)samples[tick, 8];
      return 0;
    }`;
  const binary = ensureDevGamepadHelper();
  assert.equal(launch.file, binary);
  assert.deepEqual(launch.args, []);
  const first = await collectFrames(binary, () => true);
  const frame = JSON.parse(first.lines[0]);
  if (frame.error) {
    assert.equal(frame.error, 'gamepad-backends-unavailable');
    assert.equal(first.code, 1);
  } else {
    assert.ok(frame.none === 1 || (Number.isInteger(frame.slot) && Number.isInteger(frame.b)));
    assert.equal(first.code, 0);
  }

  // 把系统输入源换成固定的 Xbox 序列，以免运行测试时真实手柄干扰结果。
  const source = fs.readFileSync(SOURCE, 'utf8');
  const rawInputBinding = 'RawGamepadInput raw = OpenRawInput(reports);';
  assert.ok(source.includes(nativeBinding) && source.includes(rawInputBinding));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gifa-gamepad-test-'));
  try {
    const fixture = path.join(directory, 'GamepadPoller.cs');
    fs.writeFileSync(fixture, source.replace(nativeBinding, fixtureBinding).replace(rawInputBinding, 'RawGamepadInput raw = null;'));
    const replay = compileGamepadHelper(path.join(directory, path.basename(binary)), fixture);
    const result = await collectFrames(replay, (line) => line === expected.at(-1));
    assert.equal(result.code, 0);
    assert.deepEqual(result.lines, expected);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function collectFrames(binary, done) {
  const child = spawn(binary, launch.args, { ...launch.options, cwd: path.dirname(binary) });
  const lines = [];
  const reader = createInterface({ input: child.stdout });
  reader.on('line', (line) => {
    lines.push(line);
    if (done(line) && !child.stdin.writableEnded) child.stdin.end();
  });
  const timeout = setTimeout(() => child.kill(), 15000);
  try {
    const [code, signal] = await EventEmitter.once(child, 'close');
    assert.equal(signal, null, `helper was killed after ${lines.length} lines`);
    return { code, lines };
  } finally {
    clearTimeout(timeout);
    reader.close();
    child.stdin.destroy();
  }
}

if (process.platform === 'win32') {
  replayWindowsHelper().then(() => console.log('PASS  Windows XInput helper, replay and stdin EOF'), (error) => {
    console.error('FAIL  Windows XInput helper, replay and stdin EOF\n' + error.stack);
    process.exitCode = 1;
  });
} else {
  console.log('SKIP  XInput helper replay requires Windows');
}
