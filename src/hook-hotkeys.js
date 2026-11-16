'use strict';

/**
 * 系统级热键钩子（鼠标侧键 + 单键 + 倍速动作）。
 *
 * 为什么不用 Electron 的 globalShortcut 处理这两类：
 *
 * 1. **鼠标侧键**：globalShortcut 只接受键盘加速器，官方不支持鼠标按键。
 * 2. **单键**（不带修饰键，如 J / Space / F9）：globalShortcut 能注册，但它在
 *    Windows 上是靠低级键盘钩子实现的，注册后会把按键**吞掉** —— 绑了 J 之后
 *    你在任何程序里都打不出 J。用户想绑单键，但不可能接受这个副作用。
 *
 * 所以这两类都走 libuiohook（WH_MOUSE_LL / WH_KEYBOARD_LL）：它是被动监听，
 * 事件照常继续传递给前台程序，游戏里的同名按键、浏览器里的侧键前进/后退都不受影响。
 * 代价是「不拦截」，因此单键仍然会在游戏里生效 —— 界面里已经写清楚了。
 *
 * 倍速动作也走钩子：长按动作需要配对释放，循环动作需要按物理按键去重。
 * 其余带修饰键的组合（Alt+Space 等）继续交给 globalShortcut。
 */

const MOUSE_ACC = /^Mouse([45])$/i;
const HOOK_ACTIONS = new Set(['holdSpeed', 'cycleSpeed']);
const MODIFIER_OF = {
  ctrl: 1, control: 1, commandorcontrol: 1, cmdorctrl: 1,
  alt: 2, option: 2, shift: 4,
  super: 8, meta: 8, command: 8, cmd: 8, win: 8, windows: 8
};
const MODIFIER_KEYS = {
  1: ['Ctrl', 'CtrlRight'],
  2: ['Alt', 'AltRight'],
  4: ['Shift', 'ShiftRight'],
  8: ['Meta', 'MetaRight']
};

/** uiohook 的 button 编码：1=左 2=右 3=中 4=侧键后退 5=侧键前进 */
const BUTTON_OF = { Mouse4: 4, Mouse5: 5 };

/** Electron 加速器名 → uiohook 键名（其余同名直接用） */
const KEY_ALIAS = {
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Esc: 'Escape',
  Return: 'Enter',
  Scrolllock: 'ScrollLock',
  Capslock: 'CapsLock',
  Numlock: 'NumLock',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ';': 'Semicolon',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '`': 'Backquote',
  '\\': 'Backslash',
  "'": 'Quote'
};

let uiohook = null;
let UiohookKey = null;
let loaded = false;
let available = false;
let running = false;
let onTrigger = null;
let shouldIgnore = null;

const bindings = new Map();
const pressed = new Set();
const blocked = new Set();
let activeHold = null;

function load() {
  if (loaded) return available;
  loaded = true;
  try {
    const mod = require('uiohook-napi');
    uiohook = mod.uIOhook || null;
    UiohookKey = mod.UiohookKey || null;
    available = !!uiohook && !!UiohookKey &&
      ['on', 'off', 'start', 'stop'].every((method) => typeof uiohook[method] === 'function');
  } catch (err) {
    console.warn('[hook] 全局钩子不可用：', err.message);
    available = false;
    uiohook = null;
    UiohookKey = null;
  }
  return available;
}

/** 该加速器是否归钩子管：倍速动作、鼠标侧键或不带修饰键的单键 */
function isHookAccelerator(acc, action) {
  const accelerator = String(acc || '').trim();
  if (!accelerator) return false;
  return HOOK_ACTIONS.has(action) || MOUSE_ACC.test(accelerator) || !accelerator.includes('+');
}

/** 单键 → uiohook keycode；认不出来返回 0 */
function keycodeOf(acc) {
  const raw = String(acc || '').trim();
  if (!raw || !UiohookKey) return 0;
  const modifier = MODIFIER_OF[raw.toLowerCase()];
  const name = (Object.hasOwn(KEY_ALIAS, raw) && KEY_ALIAS[raw]) ||
    (Number.isInteger(modifier) && MODIFIER_KEYS[modifier][0]) || raw;
  const norm = name.length === 1 ? name.toUpperCase() : name;
  const code = UiohookKey[norm];
  return Number.isFinite(code) ? code : 0;
}

function modifierOfCode(code) {
  for (const [modifier, names] of Object.entries(MODIFIER_KEYS)) {
    if (names.some((name) => UiohookKey[name] === code)) return Number(modifier);
  }
  return 0;
}

function modifiersOf(event) {
  return (event.ctrlKey ? 1 : 0) | (event.altKey ? 2 : 0) |
    (event.shiftKey ? 4 : 0) | (event.metaKey ? 8 : 0);
}

function bindingOf(accelerator, action) {
  const parts = accelerator.split('+').map((part) => part.trim());
  const key = parts.pop();
  let modifiers = 0;
  for (const part of parts) {
    const modifier = MODIFIER_OF[part.toLowerCase()];
    if (!Number.isInteger(modifier) || (modifiers & modifier)) return null;
    modifiers |= modifier;
  }
  const mouse = key.match(MOUSE_ACC);
  if (mouse) {
    return {
      action,
      token: `mouse:${BUTTON_OF[`Mouse${mouse[1]}`]}`,
      modifiers: HOOK_ACTIONS.has(action) ? modifiers : 'any'
    };
  }
  const code = keycodeOf(key);
  if (!code) return null;
  if (HOOK_ACTIONS.has(action)) modifiers |= modifierOfCode(code);
  return { action, token: `key:${code}`, modifiers };
}

function fire(action, token, phase) {
  if (!action || typeof onTrigger !== 'function') return;
  console.log(`[hook] ${token} → ${action}${phase ? ` (${phase})` : ''}`);
  try {
    if (phase) onTrigger(action, phase);
    else onTrigger(action);
  } catch (err) {
    console.warn('[hook] 触发失败', err);
  }
}

function cancelHeld() {
  if (!activeHold) return false;
  const held = activeHold;
  activeHold = null;
  fire(held.action, held.token, 'up');
  return true;
}

function onDown(token, event) {
  if (blocked.has(token) || pressed.has(token)) return;
  pressed.add(token);
  const binding = bindings.get(`${token}:${modifiersOf(event)}`) || bindings.get(`${token}:any`);
  if (!binding || (shouldIgnore && shouldIgnore())) return;
  if (binding.action === 'holdSpeed') {
    if (activeHold) return;
    activeHold = binding;
    fire(binding.action, token, 'down');
  } else {
    fire(binding.action, token);
  }
}

function onMouseDown(event) {
  onDown(`mouse:${event.button}`, event);
}

function onKeyDown(event) {
  onDown(`key:${event.keycode}`, event);
}

function onMouseUp(event) {
  const token = `mouse:${event.button}`;
  pressed.delete(token);
  blocked.delete(token);
  if (activeHold && activeHold.token === token) cancelHeld();
}

function onKeyUp(event) {
  const token = `key:${event.keycode}`;
  pressed.delete(token);
  blocked.delete(token);
  if (!activeHold) return;
  if (activeHold.token === token) {
    cancelHeld();
    return;
  }
  const modifier = modifierOfCode(event.keycode);
  if (!(activeHold.modifiers & modifier)) return;
  const stillPressed = MODIFIER_KEYS[modifier].some((name) => {
    const modifierToken = `key:${UiohookKey[name]}`;
    return pressed.has(modifierToken) || blocked.has(modifierToken);
  });
  if (!stillPressed && !(modifiersOf(event) & modifier)) cancelHeld();
}

const HOOK_LISTENERS = {
  mousedown: onMouseDown,
  mouseup: onMouseUp,
  keydown: onKeyDown,
  keyup: onKeyUp
};

function detachListeners() {
  for (const [event, listener] of Object.entries(HOOK_LISTENERS)) {
    try {
      uiohook.off(event, listener);
    } catch (err) {
      console.warn('[hook] 移除监听失败', err);
    }
  }
}

function start() {
  if (running) return true;
  if (!available) return false;
  try {
    for (const [event, listener] of Object.entries(HOOK_LISTENERS)) uiohook.on(event, listener);
    if (uiohook.start() === false) throw new Error('原生钩子未启动');
    running = true;
    console.log(
      '[hook] 全局钩子已启动，已绑定：',
      [...bindings.values()].map((binding) => `${binding.token}→${binding.action}`).join(' ') || '（无）'
    );
    return true;
  } catch (err) {
    console.warn('[hook] 启动钩子失败', err.message);
    detachListeners();
    try {
      uiohook.stop();
    } catch (stopError) {
      console.warn('[hook] 停止钩子出错', stopError);
    }
    cancelHeld();
    pressed.clear();
    running = false;
    return false;
  }
}

function stop() {
  cancelHeld();
  pressed.clear();
  blocked.clear();
  if (!running) return;
  running = false;
  detachListeners();
  try {
    uiohook.stop();
  } catch (err) {
    console.warn('[hook] 停止钩子出错', err);
  }
}

/**
 * 重新挂载钩子（保留已有映射）。
 *
 * Windows 在进程被降级成「后台/效率模式」时可能把低级钩子悄悄摘掉，
 * 这时 `running` 仍是 true，界面也显示「监听已启动」，但按键再也进不来。
 * 窗口恢复/浮窗重新显示时补挂一次，成本只有几十毫秒，比让用户重启程序划算。
 */
function rearm() {
  const shouldRestart = running && available;
  const blockedTokens = new Set([...blocked, ...pressed]);
  if (activeHold) blockedTokens.add(activeHold.token);
  stop();
  for (const token of blockedTokens) blocked.add(token);
  if (!shouldRestart) return false;
  const restarted = start();
  if (restarted) console.log('[hook] 全局钩子已重新挂载');
  return restarted;
}

/**
 * 按最新热键配置重建映射。
 * @param {object} hotkeys 动作 → 加速器
 * @param {(action:string, phase?:string)=>void} trigger 触发回调
 * @param {()=>boolean} ignore 返回 true 时忽略新的按下事件
 * @returns {{ needed: boolean, ok: boolean, keys: string[] }}
 *          needed=是否有钩子类绑定；ok=钩子启动是否成功；keys=认不出的键位
 */
function apply(hotkeys, trigger, ignore) {
  cancelHeld();
  pressed.clear();
  if (trigger) onTrigger = trigger;
  if (ignore) shouldIgnore = ignore;
  bindings.clear();

  const nativeAvailable = load();
  const unknown = [];
  let needHook = false;

  for (const [action, acc] of Object.entries(hotkeys || {})) {
    const accelerator = String(acc || '').trim();
    if (!isHookAccelerator(accelerator, action)) continue;
    needHook = true;
    if (!nativeAvailable) continue;
    const binding = bindingOf(accelerator, action);
    if (!binding) {
      unknown.push(accelerator);
      continue;
    }
    bindings.set(`${binding.token}:${binding.modifiers}`, binding);
  }

  if (!needHook) {
    stop();
    return { needed: false, ok: true, keys: unknown };
  }
  if (!nativeAvailable) {
    stop();
    return { needed: true, ok: false, keys: unknown };
  }
  if (!bindings.size) {
    stop();
    return { needed: true, ok: true, keys: unknown };
  }

  return { needed: true, ok: start(), keys: unknown };
}

/** 给界面用的可读名称 */
function describe(acc) {
  if (/^Mouse4$/i.test(acc)) return '鼠标侧键（后退）';
  if (/^Mouse5$/i.test(acc)) return '鼠标侧键（前进）';
  return acc;
}

function isRunning() {
  return running;
}

module.exports = { apply, isHookAccelerator, describe, isRunning, rearm, cancelHeld };
