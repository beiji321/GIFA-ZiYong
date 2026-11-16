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
/* 旧的四向阴影描边，只在浏览器不支持 -webkit-text-stroke 时兜底 */
const STROKE_FALLBACK = '1px 0 1px #000, 0 1px 1px #000, 0 -1px 1px #000, -1px 0 1px #000';

const HAS_TEXT_STROKE = (() => {
  try {
    return 'webkitTextStroke' in document.documentElement.style;
  } catch {
    return false;
  }
})();

/**
 * 应用描边。
 *
 * outline 改用 -webkit-text-stroke + paint-order: stroke fill（做法参考
 * BiliMaku 的 DanmakuOverlayWindow）：
 *
 *   四向 text-shadow 是「往四个方向各偏移一份黑色」叠出来的，它有两个毛病：
 *   · 细笔画会被两侧的阴影压瘦，字看起来比设定字重更细
 *   · 小字号下四份偏移糊在一起，笔画黏成一块
 *   text-stroke 是沿字形轮廓向外均匀扩一圈，paint-order 让**填充盖在描边上面**，
 *   所以笔画宽度保持原样，边缘也干净。
 *
 * 注意 -webkit-text-stroke 的宽度是**总宽度**，填充会覆盖内侧一半，
 * 所以可见的外描边约为传入值的一半。取字号的 10%：30px 字 → 3px 描边 → 约 1.5px 可见。
 */
function applyStroke(kind, fontPx) {
  const k = kind === 'shadow' || kind === 'none' ? kind : 'outline';

  if (k === 'none') {
    el.style.webkitTextStroke = '';
    el.style.paintOrder = '';
    el.style.textShadow = 'none';
    return;
  }
  if (k === 'shadow') {
    el.style.webkitTextStroke = '';
    el.style.paintOrder = '';
    el.style.textShadow = '0 2px 6px rgba(0, 0, 0, 0.95)';
    return;
  }
  // outline
  if (HAS_TEXT_STROKE) {
    const w = Math.max(2, Math.round(fontPx * 0.1));
    el.style.webkitTextStroke = `${w}px #000`;
    el.style.paintOrder = 'stroke fill';
    el.style.textShadow = 'none';
  } else {
    el.style.webkitTextStroke = '';
    el.style.paintOrder = '';
    el.style.textShadow = STROKE_FALLBACK;
  }
}

function applyConfig(cfg) {
  if (!cfg) return;

  const scale = Number(cfg.scale) || 100;
  const keepRatio = cfg.keepRatio !== false;
  // 等比缩放：以 1080p 为基准，4K / 2K 屏上按高度放大，视觉大小一致
  const ratio = keepRatio ? Math.max(0.6, window.innerHeight / 1080) : 1;
  const fontPx = Math.round(30 * (scale / 100) * ratio);

  root.style.setProperty('--sub-font', `${fontPx}px`);
  root.style.setProperty('--sub-bottom', `${Number(cfg.offset) || 230}px`);

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

  // 描边（用 -webkit-text-stroke + paintOrder，笔画不会被压瘦）
  applyStroke(cfg.stroke, fontPx);

  // 背景不透明度（0% 就是完全透明）
  const bg = Math.min(100, Math.max(0, Number(cfg.bgOpacity)));
  el.style.background = `rgba(0, 0, 0, ${(bg / 100).toFixed(3)})`;

  // 淡入淡出：关掉就把 transition 时长设为 0
  const fade = cfg.fade === false ? 0 : 0.2;
  root.style.setProperty('--sub-fade', `${fade}s`);

  // 停留时长 / 最大宽度 / 字重 / 圆角
  const hold = Number(cfg.hold);
  /* hold <= 0 = 交给访客页按**视频时间**驱动隐藏。
   * 为什么改成外部驱动：原来的固定 3 秒是按墙上时间算的 ——
   * 视频暂停时计时器照跑，一句还没说完的字幕会被吃掉；
   * 而一句说了 6 秒的字幕又会在第 3 秒提前消失。 */
  holdSeconds = Number.isFinite(hold) && hold > 0 ? Math.min(10, Math.max(1, hold)) : 0;

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
  if (holdSeconds <= 0) {
    /* 外部驱动模式：不按墙上时间倒计时，等访客页发 off。
     * 留一条 30 秒的兜底，万一 off 丢了（视频结束、页面崩）也不会永远挂着。 */
    hideTimer = setTimeout(() => el.classList.remove('show'), 30000);
    return;
  }
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
