'use strict';

/**
 * 手柄设置的纯模块：不碰 Electron、不碰 fs，能被 scripts/ 离线回归。
 *
 * 与后端解耦 —— 不论帧数据来自渲染进程的 Gamepad API 还是 XInput 子进程，
 * 主进程侧只依赖同一份设置与同一个 quantizeDirection。
 */

/** 八方位名，下标即 45° 扇区号（0 从正东起、顺时针，屏幕 y 轴向下） */
const DIRECTION_NAMES = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'];

/** 出厂映射：四个正方向沿用方向键语义（上下=分 P、左右=快进后退），斜向放四个开关 */
const DEFAULT_GAMEPAD_MAP = {
  n: 'prevPart',
  ne: 'cycleSpeed',
  e: 'seekFwd',
  se: 'toggleOpacity',
  s: 'nextPart',
  sw: 'togglePass',
  w: 'seekBack',
  nw: 'togglePlay'
};

const GAMEPAD_ACTION_ALLOWLIST = [
  'togglePlay', 'seekBack', 'seekFwd', 'prevPart', 'nextPart',
  'toggleVisible', 'togglePass', 'toggleOpacity', 'toggleImmersion', 'cycleSpeed',
  'holdSpeed'
];

/**
 * 白名单里的「按住类」动作（对应 main.js HOTKEY_META 的 hold: true）。
 * 径向菜单没有「按住」这个物理动作，所以这一步用摇杆位置代偿：过锁存线算按下，
 * 回中 / 滑走 / 抬 L3 算松开。
 */
const GAMEPAD_HOLD_ACTIONS = ['holdSpeed'];

function isHoldAction(key) {
  return GAMEPAD_HOLD_ACTIONS.includes(key);
}

const DEFAULT_GAMEPAD = {
  enabled: true,
  /** 圆盘浮窗：半径（屏幕像素）与圆心屏幕坐标；null 表示尚未定位，由主进程居中 */
  disc: { radius: 132, x: null, y: null },
  stick: {
    /** 静息漂移噪声地板：右杆幅值低于此值一律算回中，摇杆不归零时也不会误触发 */
    deadzone: 0.22
  },
  map: { ...DEFAULT_GAMEPAD_MAP }
};

const DISC_RADIUS_LIMITS = { min: 60, max: 320 };
const DEADZONE_LIMITS = { min: 0, max: 0.9 };

/**
 * Gamepad API 标准映射的下标，和 XInput 的 wButtons 位是完全两套编号：
 * buttons[10] 是左摇杆按下（L3），XInput 那边对应 0x0040 LEFT_THUMB。
 */
const L3_BUTTON_INDEX = 10;
const BUTTON_COUNT = 16;
const AXIS_COUNT = 4;

/**
 * 锁存/回中阈值。三段幅值各司其职：
 *   < deadzone(0.22)  静息漂移，算回中
 *   ≥ LATCH_AMPLITUDE 推到位，锁定扇区，此后角度不再重估
 *   < COMMIT_AMPLITUDE 回中，触发锁定的动作
 * 锁存本身免疫扇区边界抖动，所以不需要角度滞回。
 */
const LATCH_AMPLITUDE = 0.55;
const COMMIT_AMPLITUDE = 0.35;

/**
 * 宿主窗送来的帧要过一遍再进状态机：它是跨 IPC 来的对象，字段可能是
 * 缺的、长的、非数字的。归一化后 buttons 恒为 16 个 0/1、axes 恒为 4 个 [-1,1]，
 * 下游就再也不用防越界。
 */
function normalizeFrame(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rawButtons = Array.isArray(value.buttons) ? value.buttons : [];
  const rawAxes = Array.isArray(value.axes) ? value.axes : [];
  const buttons = new Array(BUTTON_COUNT).fill(0);
  const axes = new Array(AXIS_COUNT).fill(0);
  for (let i = 0; i < BUTTON_COUNT; i += 1) buttons[i] = rawButtons[i] ? 1 : 0;
  for (let i = 0; i < AXIS_COUNT; i += 1) {
    const axis = Number(rawAxes[i]);
    axes[i] = Number.isFinite(axis) ? Math.min(1, Math.max(-1, axis)) : 0;
  }
  const timestamp = Number(value.timestamp);
  return {
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    connected: !!value.connected,
    buttons,
    axes
  };
}

function numberOr(value, fallback, limits) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (!limits) return value;
  return Math.min(limits.max, Math.max(limits.min, value));
}

function nullableNumberOr(value, fallback) {
  if (value === null) return null;
  return numberOr(value, fallback);
}

function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function mergeGamepadSettings(defaults, saved) {
  const base = defaults || DEFAULT_GAMEPAD;
  const source = saved && typeof saved === 'object' ? saved : {};
  const baseDisc = base.disc || {};
  const savedDisc = source.disc && typeof source.disc === 'object' ? source.disc : {};
  const baseStick = base.stick || {};
  const savedStick = source.stick && typeof source.stick === 'object' ? source.stick : {};

  return {
    enabled: booleanOr(source.enabled, booleanOr(base.enabled, true)),
    disc: {
      radius: numberOr(savedDisc.radius, numberOr(baseDisc.radius, DEFAULT_GAMEPAD.disc.radius, DISC_RADIUS_LIMITS), DISC_RADIUS_LIMITS),
      x: nullableNumberOr(savedDisc.x, numberOr(baseDisc.x, null)),
      y: nullableNumberOr(savedDisc.y, numberOr(baseDisc.y, null))
    },
    stick: {
      deadzone: numberOr(savedStick.deadzone, numberOr(baseStick.deadzone, DEFAULT_GAMEPAD.stick.deadzone, DEADZONE_LIMITS), DEADZONE_LIMITS)
    },
    map: mergeGamepadMap(base.map || DEFAULT_GAMEPAD_MAP, source.map)
  };
}

/** 回中阈值必须严格低于锁存阈值，否则死区调到 0.6 以上会让扇区永远无法触发 */
function effectiveDeadzone(cfg) {
  const stick = (cfg && cfg.stick) || DEFAULT_GAMEPAD.stick;
  const deadzone = numberOr(stick.deadzone, DEFAULT_GAMEPAD.stick.deadzone, DEADZONE_LIMITS);
  return Math.min(deadzone, COMMIT_AMPLITUDE - 0.05);
}

/**
 * 映射表合并：只认八个方位名，动作必须在白名单内。
 * 语义照 hotkey-config.js 的 mergeHotkeys —— 已存档的未知动作丢弃回默认，
 * 幂等（拿输出再当存档合并一次结果不变），且不写穿入参。
 *
 * 和键盘热键不同，这里**不查重**：每个扇区是独立的触发路径，把同一个动作绑到
 * 两个方向不会一次触发两回。显式空串是「本方向不绑」，只有非法动作才退回上一档。
 */
function mergeGamepadMap(defaults, saved) {
  const base = defaults || DEFAULT_GAMEPAD_MAP;
  const source = saved && typeof saved === 'object' ? saved : {};
  const merged = {};
  for (const direction of DIRECTION_NAMES) {
    const fallback = base[direction];
    const picked = Object.hasOwn(source, direction) ? source[direction] : fallback;
    merged[direction] = picked === '' || GAMEPAD_ACTION_ALLOWLIST.includes(picked) ? picked
      : GAMEPAD_ACTION_ALLOWLIST.includes(fallback) ? fallback : '';
  }
  return merged;
}

/** 摇杆幅值：Gamepad API 与 XInput 归一化后都是 [-1,1] 的两轴，直接取模长 */
function amplitudeOf(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
  return Math.sqrt(x * x + y * y);
}

/**
 * 右摇杆 → 八方位名；幅值不过死区返回 ''（回中）。
 * axes[2]/axes[3] 是右杆 x/y，axes[0]/axes[1] 是左杆，这里不用左杆（L3 走按键位）。
 */
function quantizeDirection(axes, cfg) {
  const stick = (cfg && cfg.stick) || DEFAULT_GAMEPAD.stick;
  if (!axes || !Number.isFinite(axes[2]) || !Number.isFinite(axes[3])) return '';
  if (amplitudeOf(axes[2], axes[3]) < stick.deadzone) return '';
  const degrees = Math.atan2(axes[3], axes[2]) * 180 / Math.PI;
  const sector = Math.round(((degrees + 360) % 360) / 45) % 8;
  return DIRECTION_NAMES[sector];
}

/**
 * 圆盘会话状态机（纯函数，不碰 Electron）。一次「按住 L3」是一场会话：
 *
 *   L3 按下        → 开会话，清空候选
 *   幅值 ≥ 锁存线  → 该扇区成为候选；此后继续滑摇杆，候选跟着实时换
 *   幅值 < 回中线  → 触发当前候选，然后清空（允许一次会话内链式多选）
 *   L3 抬起        → 若仍有未触发的候选则取消，不触发
 *
 * 开会话时若右杆本来就推着（先推杆后按 L3），要求先回中再推一次才算选择，
 * 否则「按下 L3 的那一瞬间」会把遗留位置直接当成选项。
 *
 * 绑了按住类动作（见 GAMEPAD_HOLD_ACTIONS）的扇区是另外两条边：过锁存线 = 按下
 * （press），回中 / 滑走 / 抬 L3 = 松开（release），所以它不进 fired。同一个动作绑到
 * 两个方向时 key 没变，从一边滑到另一边不算松开 —— 按住多久只看摇杆离开没有。
 *
 * @param {{l3:boolean, latched:string, awaitingRelease:boolean, holding:string}} state
 * @param {{buttons:number[], axes:number[]}} frame 已过 normalizeFrame 的帧
 * @returns {{state:object, active:boolean, highlighted:string, fired:string, press:string, release:string}}
 */
function stepChord(state, frame, cfg) {
  const previous = state || createChordState();
  const map = (cfg && cfg.map) || DEFAULT_GAMEPAD_MAP;
  const deadzone = effectiveDeadzone(cfg);
  const pressed = !!(frame && frame.buttons && frame.buttons[L3_BUTTON_INDEX]);
  const axes = (frame && frame.axes) || [];
  const amplitude = amplitudeOf(Number(axes[2]), Number(axes[3]));
  const preview = amplitude >= deadzone ? quantizeDirection(axes, { stick: { deadzone } }) : '';

  const idle = { active: false, highlighted: '', fired: '', press: '', release: '' };

  if (!previous.l3 && !pressed) return { state: previous, ...idle };
  // L3 抬起：还没回中的候选直接作废，防误触。但按住中的动作必须补一发松开，
  // 否则「未回中就抬杆」这条取消路径会把播放留在临时倍率上。
  if (!pressed) {
    return { state: createChordState(), ...idle, release: previous.holding };
  }

  if (!previous.l3) {
    return {
      state: { l3: true, latched: '', awaitingRelease: amplitude >= COMMIT_AMPLITUDE, holding: '' },
      active: true,
      highlighted: '',
      fired: '',
      press: '',
      release: ''
    };
  }

  if (previous.awaitingRelease) {
    if (amplitude >= COMMIT_AMPLITUDE) return { state: previous, active: true, highlighted: '', fired: '', press: '', release: '' };
    return { state: { ...previous, awaitingRelease: false }, active: true, highlighted: '', fired: '', press: '', release: '' };
  }
  // 满推（过锁存线）才高亮并立候选，而且每帧重估 —— 按住 L3 把杆从东滑向南，高亮和
  // 最终触发都跟着走。轻推连高亮都不给，免得看着像选中了却什么都不触发。
  const latched = amplitude >= LATCH_AMPLITUDE && preview ? preview : previous.latched;
  if (amplitude < COMMIT_AMPLITUDE) {
    const action = latched ? map[latched] || '' : '';
    return {
      state: { l3: true, latched: '', awaitingRelease: false, holding: '' },
      active: true,
      highlighted: '',
      // 按住类动作在过锁存线那一刻就已经生效，回中只负责收尾，不能再 fired 一遍
      fired: isHoldAction(action) ? '' : action,
      press: '',
      release: previous.holding
    };
  }
  const holding = isHoldAction(map[latched]) ? map[latched] : '';
  return {
    state: { ...previous, latched, awaitingRelease: false, holding },
    active: true,
    highlighted: latched,
    fired: '',
    press: holding && holding !== previous.holding ? holding : '',
    release: previous.holding && previous.holding !== holding ? previous.holding : ''
  };
}

function createChordState() {
  return { l3: false, latched: '', awaitingRelease: false, holding: '' };
}

/**
 * XInput 的 wButtons 位 → Gamepad API 标准下标，两套编号毫不相干。
 * GUIDE（0x0400）在标准 16 键里没有位置，故意不映射。
 */
const XINPUT_BIT_TO_GAMEPAD_BUTTON = [
  [0x1000, 0], [0x2000, 1], [0x4000, 2], [0x8000, 3],
  [0x0100, 4], [0x0200, 5], [0x0020, 8], [0x0010, 9],
  [0x0040, L3_BUTTON_INDEX], [0x0080, 11],
  [0x0001, 12], [0x0002, 13], [0x0004, 14], [0x0008, 15]
];

function axisToUnit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(-1, number / 32767));
}

/**
 * XInput 的原始摇杆值在这里换算量程，触发阈值由圆盘状态机应用。
 * Y 轴要取反：XInput 推上去是正值，而 Gamepad API 与圆盘判定都是屏幕坐标（向下为正）。
 */
function xinputToFrame(raw) {
  const buttons = new Array(BUTTON_COUNT).fill(0);
  const axes = new Array(AXIS_COUNT).fill(0);
  const connected = !!raw && Number.isFinite(raw.b);
  if (connected) {
    for (const [bit, index] of XINPUT_BIT_TO_GAMEPAD_BUTTON) {
      if (raw.b & bit) buttons[index] = 1;
    }
    buttons[6] = Number(raw.lt) > 0 ? 1 : 0;
    buttons[7] = Number(raw.rt) > 0 ? 1 : 0;
    axes[0] = axisToUnit(raw.lx);
    axes[1] = -axisToUnit(raw.ly);
    axes[2] = axisToUnit(raw.rx);
    axes[3] = -axisToUnit(raw.ry);
  }
  return normalizeFrame({ timestamp: Date.now(), connected, buttons, axes });
}

module.exports = {
  DEFAULT_GAMEPAD,
  DEFAULT_GAMEPAD_MAP,
  GAMEPAD_ACTION_ALLOWLIST,
  DIRECTION_NAMES,
  L3_BUTTON_INDEX,
  BUTTON_COUNT,
  AXIS_COUNT,
  mergeGamepadSettings,
  mergeGamepadMap,
  normalizeFrame,
  xinputToFrame,
  amplitudeOf,
  quantizeDirection,
  createChordState,
  stepChord,
  isHoldAction
};
