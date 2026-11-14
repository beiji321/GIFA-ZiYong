'use strict';

/**
 * 字幕层渲染进程：只负责「显示一句话 / 3 秒后淡出」+ 按配置改外观。
 * 文本与外观都由主进程下发（subtitle:text / subtitle:config）。
 */

const el = document.getElementById('sub');
const root = document.documentElement;
let hideTimer = null;
let lastConfig = null;
/** 一句话停留多久（秒），由配置下发 */
let holdSeconds = 3;

/** 描边预设：和 B 站播放器一致的三种 */
const STROKE = {
  none: 'none',
  outline: '1px 0 1px #000, 0 1px 1px #000, 0 -1px 1px #000, -1px 0 1px #000',
  shadow: '0 2px 6px rgba(0, 0, 0, 0.95)'
};

function applyConfig(cfg) {
  if (!cfg) return;

  const scale = Number(cfg.scale) || 100;
  const keepRatio = cfg.keepRatio !== false;
  // 等比缩放：以 1080p 为基准，4K / 2K 屏上按高度放大，视觉大小一致
  const ratio = keepRatio ? Math.max(0.6, window.innerHeight / 1080) : 1;
  const fontPx = Math.round(30 * (scale / 100) * ratio);

  root.style.setProperty('--sub-font', `${fontPx}px`);
  root.style.setProperty('--sub-bottom', `${Number(cfg.offset) || 80}px`);

  // 位置：居中靠 translateX(-50%)；靠左/靠右直接贴边，留 40px 边距
  const pos = cfg.pos === 'left' || cfg.pos === 'right' ? cfg.pos : 'center';
  if (pos === 'center') {
    root.style.setProperty('--sub-left', '50%');
    root.style.setProperty('--sub-right', 'auto');
    root.style.setProperty('--sub-tx', '-50%');
  } else if (pos === 'left') {
    root.style.setProperty('--sub-left', '40px');
    root.style.setProperty('--sub-right', 'auto');
    root.style.setProperty('--sub-tx', '0');
  } else {
    root.style.setProperty('--sub-left', 'auto');
    root.style.setProperty('--sub-right', '40px');
    root.style.setProperty('--sub-tx', '0');
  }

  // 颜色
  el.style.color = cfg.color || '#ffffff';

  // 描边
  const stroke = STROKE[cfg.stroke] || STROKE.outline;
  el.style.textShadow = stroke;

  // 背景不透明度（0% 就是完全透明）
  const bg = Math.min(100, Math.max(0, Number(cfg.bgOpacity)));
  el.style.background = `rgba(0, 0, 0, ${(bg / 100).toFixed(3)})`;

  // 淡入淡出：关掉就把 transition 时长设为 0
  const fade = cfg.fade === false ? 0 : 0.2;
  root.style.setProperty('--sub-fade', `${fade}s`);

  // 停留时长 / 最大宽度 / 字重 / 圆角
  const hold = Number(cfg.hold);
  holdSeconds = Number.isFinite(hold) && hold > 0 ? Math.min(10, Math.max(1, hold)) : 3;

  const maxW = Number(cfg.maxWidth);
  root.style.setProperty('--sub-max-width', `${Number.isFinite(maxW) ? Math.min(100, Math.max(30, maxW)) : 88}vw`);

  const weight = Number(cfg.weight);
  root.style.setProperty('--sub-weight', String(Number.isFinite(weight) ? Math.min(900, Math.max(500, weight)) : 800));

  const radius = Number(cfg.radius);
  root.style.setProperty('--sub-radius', `${Number.isFinite(radius) ? Math.min(24, Math.max(0, radius)) : 8}px`);

  lastConfig = cfg;
}

function showText(text) {
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => el.classList.remove('show'), holdSeconds * 1000);
}

function hideText() {
  clearTimeout(hideTimer);
  hideTimer = null;
  el.textContent = '';
  el.classList.remove('show');
  maybeIdle();
}

window.subtitleLayer.onText((payload) => {
  const p = payload || {};
  if (p.off || !p.text) {
    hideText();
    return;
  }
  showText(String(p.text));
});

window.subtitleLayer.onConfig((cfg) => applyConfig(cfg));

// 换了显示器 / 改分辨率：用同一份配置重算一次等比字号
window.addEventListener('resize', () => {
  if (lastConfig) applyConfig(lastConfig);
});

/* ------------------------------------------------------------ 转向提示 */

const turnEl = document.getElementById('turn');
const turnArrow = document.getElementById('turnArrow');
const turnLabel = document.getElementById('turnLabel');

/** 四个方向：左右贴左右边缘，上下贴上下边缘 */
const TURN_STYLE = {
  left: { arrow: '←', color: '#49b2fc' },
  right: { arrow: '→', color: '#49b2fc' },
  up: { arrow: '↑', color: '#7ee081' },
  down: { arrow: '↓', color: '#ff9f6b' }
};

let turnTimer = null;
/** 转向提示外观配置（主进程下发） */
const turnCfg = {
  offset: 400,
  scale: 100,
  duration: 2,
  opacity: 85,
  color: '#49b2fc',
  posY: 50,
  posX: 50
};

function applyTurnConfig(cfg) {
  if (!cfg) return;
  if (Number.isFinite(Number(cfg.offset))) turnCfg.offset = Number(cfg.offset);
  if (Number.isFinite(Number(cfg.scale))) turnCfg.scale = Number(cfg.scale);
  if (Number.isFinite(Number(cfg.duration))) turnCfg.duration = Number(cfg.duration);
  if (Number.isFinite(Number(cfg.opacity))) turnCfg.opacity = Number(cfg.opacity);
  if (typeof cfg.color === 'string' && /^#[0-9a-f]{6}$/i.test(cfg.color)) turnCfg.color = cfg.color;
  if (Number.isFinite(Number(cfg.posY))) turnCfg.posY = Number(cfg.posY);
  if (Number.isFinite(Number(cfg.posX))) turnCfg.posX = Number(cfg.posX);

  const st = document.documentElement.style;
  st.setProperty('--turn-offset', `${turnCfg.offset}px`);
  st.setProperty('--turn-scale', String(turnCfg.scale / 100));
  st.setProperty('--turn-opacity', String(turnCfg.opacity / 100));
  // 左右提示的垂直位置、上下提示的水平位置
  st.setProperty('--turn-pos-y', `${turnCfg.posY}%`);
  st.setProperty('--turn-pos-x', `${turnCfg.posX}%`);
}

function hideTurn() {
  clearTimeout(turnTimer);
  turnTimer = null;
  turnEl.classList.remove('show');
  maybeIdle();
}

/**
 * 字幕和转向提示都没在显示时，通知主进程把窗口藏起来。
 * 全屏透明窗口即使内容全透明，也要参与桌面合成；挂机玩原神时把它收掉
 * 能省掉一层全屏合成。下次有内容时主进程会 showInactive 再发文本。
 */
let idleTimer = null;
function maybeIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (el.classList.contains('show') || turnEl.classList.contains('show')) return;
    try {
      window.subtitleLayer.idle();
    } catch {
      /* ignore */
    }
  }, 1200);
}

/** 显示一次转向提示；重复触发时重置 2 秒计时 */
function showTurn(hint) {
  if (!hint || hint.off) {
    hideTurn();
    return;
  }
  const st = TURN_STYLE[hint.dir];
  if (!st) return;

  turnArrow.textContent = st.arrow;
  turnLabel.textContent = hint.label || '';
  turnEl.dataset.side = hint.dir; // 左/右贴左右边，上/下贴上下边
  turnEl.style.setProperty('--turn-accent', turnCfg.color || st.color);

  // 已显示时先摘再挂，让淡入动画重播一遍
  turnEl.classList.remove('show');
  void turnEl.offsetWidth;
  turnEl.classList.add('show');

  clearTimeout(turnTimer);
  turnTimer = setTimeout(() => {
    turnEl.classList.remove('show');
    maybeIdle();
  }, turnCfg.duration * 1000);
}

window.subtitleLayer.onTurn(showTurn);
window.subtitleLayer.onTurnConfig(applyTurnConfig);
