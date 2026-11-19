'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');
const path = require('node:path');

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
Module._load = function (request, parent, isMain) {
  if (request === 'node:child_process') return { spawn() {
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

run('unavailable report emits disconnected frame without restart', () => {
  const calls = [];
  gamepad.start((value) => calls.push(value));
  const child = children.at(-1);
  line(child, '{"error":"xinput-missing"}\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].connected, false);
  assert.equal(child.killCalls, 1);
  assert.equal(pendingTimers.filter((timer) => !timer.cleared).length, 0);
  gamepad.stop();
});

console.log('gamepad poller regression complete');
global.setTimeout = originalSetTimeout;
global.clearTimeout = originalClearTimeout;
