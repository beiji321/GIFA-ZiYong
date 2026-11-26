'use strict';

/**
 * 独立辅助程序用 XInput 接收 Xbox 输入，用 Windows HID 接收 PlayStation 输入。
 * 每个连接有独立槽位，助手在后台也能收到按下、松开和断连。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const { xinputToFrame } = require('./gamepad-config');
const gamepadHelperPath = require('./gamepad-helper-path');

const XINPUT_SLOT_COUNT = 4;
const SONY_MODELS = new Set(['dualshock4', 'dualsense', 'dualsense-edge']);
const RESTART_DELAY_MS = 1000;
const RESTART_LIMIT = 3;

let run = null;
let poller = null;

function failPoller(current, ...warning) {
  if (run !== current.owner || current.failed) return;
  current.failed = true;
  current.pendingLine = '';
  console.warn(...warning);
  current.owner.onFrame?.(xinputToFrame(null));
}

function killPoller(current) {
  if (poller !== current || current.killRequested) return;
  current.killRequested = true;
  try {
    current.child.kill();
  } catch (err) {
    console.warn('[gamepad] 停止轮询进程失败：', err.message);
  } finally {
    current.child.stdin.destroy();
  }
}

function handleLine(current, line) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  if (!raw || typeof raw !== 'object') return;
  if (raw.error === 'gamepad-backends-unavailable' || raw.error === 'xinput-missing') {
    current.owner.unavailable = true;
    failPoller(current, '[gamepad] Windows 手柄输入后端不可用');
    killPoller(current);
    return;
  }
  const slot = raw.slot;
  const validSlot = Number.isInteger(slot) && slot >= 0 && slot <= 0x7fffffff;
  if (raw.none === 1) {
    if (validSlot) current.owner.onFrame?.({ ...xinputToFrame(null), slot });
    else if (slot === undefined) current.owner.onFrame?.(xinputToFrame(null));
    return;
  }
  if (!validSlot || !Number.isInteger(raw.b) || raw.b < 0 || raw.b > 0xffff) return;
  const model = slot < XINPUT_SLOT_COUNT && raw.model === undefined ? 'xinput' : raw.model;
  if (slot < XINPUT_SLOT_COUNT ? model !== 'xinput' : !SONY_MODELS.has(model)) return;
  current.owner.onFrame?.({ ...xinputToFrame(raw), slot, model });
}

function consumeStdout(current, chunk) {
  const isCurrent = () => poller === current && run === current.owner && !current.failed;
  if (!isCurrent()) return;
  const lines = (current.pendingLine + chunk.toString('utf8')).split('\n');
  current.pendingLine = lines.pop();
  for (const line of lines) {
    if (!isCurrent()) return;
    const text = line.trim();
    if (text) handleLine(current, text);
  }
}

function spawnPoller(owner) {
  if (run !== owner || poller || owner.unavailable) return;

  let child;
  try {
    const packaged = process.versions.electron && require('electron').app.isPackaged;
    const binary = gamepadHelperPath(packaged ? process.resourcesPath : undefined);
    child = spawn(binary, [], {
      cwd: path.dirname(binary), windowsHide: true,
      stdio: ['pipe', 'pipe', 'inherit']
    });
  } catch (err) {
    console.warn('[gamepad] 轮询进程起不来：', err.message);
    try {
      owner.onFrame?.(xinputToFrame(null));
    } finally {
      scheduleRestart(owner);
    }
    return;
  }

  const current = { child, owner, pendingLine: '', failed: false, killRequested: false };
  poller = current;
  const finish = (...warning) => {
    if (poller !== current) return;
    poller = null;
    if (run !== owner) {
      if (run) spawnPoller(run);
      return;
    }
    try {
      failPoller(current, ...warning);
    } finally {
      scheduleRestart(owner);
    }
  };
  const onExit = (code, signal) => {
    const reason = signal ? '信号 ' + signal : '退出码 ' + code;
    finish('[gamepad] 轮询进程退出（' + reason + '）');
  };

  child.stdout.on('data', (chunk) => consumeStdout(current, chunk));
  child.on('error', (err) => {
    if (poller !== current) return;
    const warning = ['[gamepad] 轮询进程异常：', err.message];
    if (!child.pid) {
      finish(...warning);
      return;
    }
    try {
      failPoller(current, ...warning);
    } finally {
      killPoller(current);
    }
  });
  // exit 可能早于 stdout 的最后一行，尤其是辅助程序报告缺少 XInput 后立即退出时。
  child.once('close', onExit);
}

function scheduleRestart(owner) {
  if (run !== owner || owner.unavailable || owner.restartTimer) return;
  if (owner.restarts >= RESTART_LIMIT) {
    console.warn('[gamepad] 手柄轮询已用完 ' + RESTART_LIMIT + ' 次重试，本次运行不再重试');
    return;
  }
  owner.restarts += 1;
  owner.restartTimer = setTimeout(() => {
    owner.restartTimer = null;
    spawnPoller(owner);
  }, RESTART_DELAY_MS);
}

/** 起轮询。onFrame 接收手柄状态变化或轮询故障的归一化帧。 */
function start(onFrame) {
  if (run) {
    run.onFrame = typeof onFrame === 'function' ? onFrame : null;
    return;
  }
  run = {
    onFrame: typeof onFrame === 'function' ? onFrame : null,
    restartTimer: null,
    restarts: 0,
    unavailable: false
  };
  spawnPoller(run);
}

function stop() {
  if (!run) return;
  if (run.restartTimer) clearTimeout(run.restartTimer);
  run = null;
  if (poller) {
    poller.pendingLine = '';
    killPoller(poller);
  }
}

module.exports = { start, stop };
