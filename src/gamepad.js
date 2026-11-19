'use strict';

/**
 * 手柄输入源：主进程经 PowerShell 子进程轮询 XInput。
 *
 * 为什么不是渲染进程的 Gamepad API：Chromium 要求文档收到过真实用户手势才启动
 * 手柄监视，而轮询宿主窗必须不抢焦点、鼠标穿透、从不 show —— 它永远拿不到手势，
 * 实机在游戏前台时 getGamepads() 恒空。XInput 是 OS 层轮询，与焦点和手势无关。
 *
 * 帧数据只走 stdout 逐行 JSON，子进程按签名去重，静默时不产行。
 */

const { spawn } = require('node:child_process');
const { xinputToFrame } = require('./gamepad-config');

const SLOT_COUNT = 4;
const POLL_MS = 16;
const RESTART_DELAY_MS = 1000;
const RESTART_LIMIT = 3;

const XINPUT_CSHARP = `
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct XGamepad {
  public ushort wButtons;
  public byte bLeftTrigger;
  public byte bRightTrigger;
  public short sThumbLX;
  public short sThumbLY;
  public short sThumbRX;
  public short sThumbRY;
}

[StructLayout(LayoutKind.Sequential, Pack = 4)]
public struct XState {
  public uint dwPacketNumber;
  public XGamepad Gamepad;
}

public static class Xi {
  [UnmanagedFunctionPointer(CallingConvention.Winapi)]
  delegate uint GetStateFn(uint user, out XState state);

  const uint LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x00000800;
  [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibraryEx(string name, IntPtr file, uint flags);
  [DllImport("kernel32", SetLastError = true)] static extern IntPtr GetProcAddress(IntPtr module, string name);

  static GetStateFn fn;

  public static int Probe() {
    if (fn != null) return 0;
    string[] names = { "xinput1_4.dll", "xinput1_3.dll", "xinput9_1_0.dll" };
    for (int i = 0; i < names.Length; i++) {
      IntPtr lib = LoadLibraryEx(names[i], IntPtr.Zero, LOAD_LIBRARY_SEARCH_SYSTEM32);
      if (lib == IntPtr.Zero) continue;
      IntPtr addr = GetProcAddress(lib, "XInputGetState");
      if (addr == IntPtr.Zero) continue;
      fn = (GetStateFn)Marshal.GetDelegateForFunctionPointer(addr, typeof(GetStateFn));
      return 0;
    }
    return -1;
  }

  public static uint State(uint user, out XState state) {
    return fn(user, out state);
  }
}
`;

// PowerShell 的单引号 here-string 结束标记必须顶格，所以下面有两行不能缩进。
const POLL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$code = @'
${XINPUT_CSHARP}
'@
Add-Type -Language CSharp -TypeDefinition $code
if ([Xi]::Probe() -ne 0) {
  [Console]::Out.WriteLine('{"error":"xinput-missing"}')
  [Console]::Out.Flush()
  exit 1
}
$parentInput = [Console]::OpenStandardInput()
$parentEof = $parentInput.ReadAsync((New-Object byte[] 1), 0, 1)
$state = New-Object XState
$last = ''
while (-not $parentEof.IsCompleted) {
  $line = '{"none":1}'
  for ($i = 0; $i -lt ${SLOT_COUNT}; $i++) {
    if ([Xi]::State($i, [ref]$state) -eq 0) {
      $g = $state.Gamepad
      $line = '{{"slot":{0},"b":{1},"lt":{2},"rt":{3},"lx":{4},"ly":{5},"rx":{6},"ry":{7}}}' -f $i, [int]$g.wButtons, [int]$g.bLeftTrigger, [int]$g.bRightTrigger, [int]$g.sThumbLX, [int]$g.sThumbLY, [int]$g.sThumbRX, [int]$g.sThumbRY
      break
    }
  }
  if ($line -ne $last) {
    $last = $line
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds ${POLL_MS}
}
`;

let run = null;
let poller = null;

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return root + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
}

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
  if (raw.error) {
    current.owner.unavailable = true;
    failPoller(current, '[gamepad] 本机没有可用的 XInput 运行库，手柄功能不可用');
    killPoller(current);
    return;
  }
  const frame = xinputToFrame(raw);
  if (frame.connected && Number.isInteger(raw.slot) && raw.slot >= 0 && raw.slot < SLOT_COUNT) {
    frame.slot = raw.slot;
  }
  current.owner.onFrame?.(frame);
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

  const encoded = Buffer.from(POLL_SCRIPT, 'utf16le').toString('base64');
  let child;
  try {
    child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      // stderr 不接：PowerShell 的 stderr 一被重定向成管道就先吐一段 CLIXML 框架，
      // 里面并不是错误内容，反而会把日志搞脏。真起不来由退出码和 error 事件报。
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
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
  child.once('exit', onExit);
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
