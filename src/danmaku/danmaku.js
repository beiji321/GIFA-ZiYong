'use strict';

/**
 * 弹幕层渲染进程 —— 时间轴驱动 + 轨道碰撞检测。
 *
 * 数据来自主进程按 cid 拉取的官方弹幕表，并且**只按播放进度切片下发**
 * （当前点前 1 秒 ~ 后 6 秒），所以不存在「历史弹幕一次性刷屏」。
 * 本文件负责：
 *   1. 维护一个按开始时间排序的待播队列 + 本地时钟；
 *   2. 每帧取出「到点了」的弹幕；
 *   3. 轨道碰撞检测：所有轨道都忙就直接丢弃，绝不叠字。
 */

const layer = document.getElementById('layer');

/* --------------------------------------------------------------- 配置 */

const cfg = { area: 50, opacity: 80, scale: 100, speed: 50, weight: 700, max: 60, stroke: true };
/** 方位箭头处的圆形挖空区域（弹幕窗口局部坐标），null 表示不挖 */
let hole = null;

function areaHeight() {
  return Math.max(80, Math.round((window.innerHeight * cfg.area) / 100));
}

function laneHeight() {
  return Math.round(40 * (cfg.scale / 100));
}

function laneCount() {
  return Math.max(3, Math.floor(areaHeight() / laneHeight()));
}

/** 速度 0(慢)~100(快) → 飞行时长，50 正好 8 秒 */
function durationSeconds() {
  return Math.max(3, 12 - (cfg.speed / 100) * 8);
}

/* --------------------------------------------------------------- 时钟 */

/**
 * 本地时钟：以主进程报来的播放进度为基准，用 performance.now() 插值。
 * 暂停时不推进。这样即使 1 秒才同步一次，也能在正确的秒点弹出弹幕。
 */
const clock = { base: 0, perf: 0, playing: false };

function nowSec() {
  if (!clock.playing) return clock.base;
  return clock.base + (performance.now() - clock.perf) / 1000;
}

/* --------------------------------------------------------------- 队列 */

/** 待播队列，按 t(ms) 升序 */
let queue = [];
/** 已处理过的全局序号，重复切片不会重复播 */
const shown = new Set();

function clearAll() {
  queue = [];
  shown.clear();
  for (const el of [...layer.children]) {
    clearTimeout(el.__killTimer);
    el.remove();
  }
  tracks.length = 0;
  // 清空后没活可干，直接休眠
  stopLoop();
}

/* ----------------------------------------------------------- 轨道碰撞 */

/** tracks[i] = 该轨道上一条弹幕的「尾部完全进屏」时刻（秒） */
const tracks = [];

/**
 * 给一条弹幕挑轨道：从第一条开始找 freeAt <= now 的；
 * 全忙就返回 -1，调用方必须丢弃这条弹幕。
 */
function pickLane(now, widthPx) {
  const total = laneCount();
  while (tracks.length < total) tracks.push(0);
  tracks.length = total;

  for (let i = 0; i < total; i++) {
    if (tracks[i] <= now) return i;
  }
  return -1;
}

function occupyLane(lane, now, widthPx) {
  // 尾部完全进入屏幕所需时间占整段飞行的比例
  const ratio = Math.min(1, widthPx / (window.innerWidth + widthPx));
  tracks[lane] = now + durationSeconds() * ratio;
}

/* --------------------------------------------------------------- 渲染 */

let dropped = 0;

function spawn(item) {
  const now = nowSec();
  // 同屏上限：超了就直接跳过，宁可少几条也别糊满屏
  if (layer.childElementCount >= cfg.max) {
    dropped++;
    return;
  }

  const el = document.createElement('div');
  el.className = 'dm';
  el.textContent = item.text;
  const raw = String(item.color || '').trim();
  const isWhiteish = !raw || /^(#fff(fff)?|white|rgba?\(\s*255\s*,\s*255\s*,\s*255)/i.test(raw);
  el.style.color = isWhiteish ? '#ffffff' : raw;
  el.style.top = '0px';
  layer.appendChild(el);

  const width = el.offsetWidth || 100;
  const lane = pickLane(now, width);
  if (lane < 0) {
    // 全轨道占满：直接丢弃，绝不强行塞入造成重叠
    el.remove();
    dropped++;
    return;
  }

  occupyLane(lane, now, width);
  el.style.top = `${lane * laneHeight() + Math.random() * 4}px`;

  const duration = durationSeconds() * (0.92 + Math.random() * 0.16);
  el.style.animationDuration = `${duration}s`;
  const dispose = () => {
    clearTimeout(el.__killTimer);
    el.remove();
  };
  el.addEventListener('animationend', dispose, { once: true });
  // 兜底：窗口被隐藏 / 动画事件丢失时也能销毁节点，避免 DOM 越积越多
  el.__killTimer = setTimeout(dispose, (duration + 2) * 1000);
}

/* --------------------------------------------------------------- 循环 */

let rafId = 0;
let running = false;

/**
 * 待播队列空着的时候没必要每帧跑一次 —— 弹幕在播时才有活干。
 * 空闲时直接 stopLoop() 睡过去（CPU 归零），等 onSlice 灌了新数据再唤醒。
 * 注意：这只是停调度，不销毁已经在飞的 DOM，CSS 动画照常跑完。
 */
function tick() {
  if (!running) return;

  if (!queue.length) {
    // 没活干了：直接停调度。透明层本身没有内容变化时不会重绘，
    // 所以这里不需要（也不该）把窗口 hide —— 隐藏会让 rAF 被整体挂起，
    // 下一片弹幕到点就来不及调度。
    stopLoop();
    return;
  }

  const now = nowSec();

  // 队列里按时间排序，只从头部取「已到点」的
  while (queue.length && queue[0].t / 1000 <= now + 0.15) {
    const item = queue.shift();
    if (!shown.has(item.idx)) {
      shown.add(item.idx);
      // 长视频里 shown 会一路涨：到量就重置，避免挂机几小时后无限占内存。
      // 代价只是极少数还在队列里的旧条目可能重播一次，用户感知不到。
      if (shown.size > 20000) shown.clear();
      spawn(item);
    }
  }

  // 丢掉明显过期的（暂停很久后恢复、或切片重叠留下的）
  if (queue.length) {
    const cut = now - 3;
    while (queue.length && queue[0].t / 1000 < cut) queue.shift();
  }

  if (!queue.length) {
    stopLoop();
    return;
  }

  rafId = requestAnimationFrame(tick);
}

/** 有活才转：队列空 or 暂停中都不启动 */
function startLoop() {
  if (running || !queue.length || !clock.playing) return;
  running = true;
  rafId = requestAnimationFrame(tick);
}

function stopLoop() {
  running = false;
  cancelAnimationFrame(rafId);
  rafId = 0;
}

/**
 * 播放 / 暂停切换。
 * 暂停时三件事一起做：冻结本地时钟、停掉 rAF、把屏幕上正在飞的弹幕
 * 用 animation-play-state: paused 定在半空；恢复时原样解开。
 */
function setPlaying(on) {
  const next = !!on;
  if (next === clock.playing) return;

  if (next) {
    // 解冻：把冻结时刻作为新的基准，时间继续从那里走
    clock.perf = performance.now();
    clock.playing = true;
    layer.classList.remove('paused');
    startLoop(); // 队列空的话内部会直接返回，保持休眠
  } else {
    // 先记录冻结时刻，再标记暂停（nowSec 依赖 clock.playing）
    clock.base = nowSec();
    clock.playing = false;
    layer.classList.add('paused');
    stopLoop();
  }
}

/* --------------------------------------------------------------- 输入 */

/**
 * 在弹幕层上挖一个透明圆：圆心/半径来自主进程（已换算成本窗口坐标）。
 * 用 radial-gradient 的 mask —— 圆心透明（=不渲染），圆外保持不透明。
 */
function applyHole(h) {
  hole = h && Number.isFinite(h.cx) && Number.isFinite(h.cy) && Number.isFinite(h.r) && h.r > 0 ? h : null;
  const layer = document.getElementById('layer');
  if (!layer) return;

  if (!hole) {
    layer.style.maskImage = '';
    layer.style.webkitMaskImage = '';
    return;
  }

  // 边缘留 12px 羽化，避免硬切出锯齿
  const grad = `radial-gradient(circle at ${hole.cx}px ${hole.cy}px, transparent ${Math.max(
    0,
    hole.r - 2
  )}px, #000 ${hole.r + 12}px)`;
  layer.style.maskImage = grad;
  layer.style.webkitMaskImage = grad;
}

function applyConfig(next) {
  if (!next) return;
  if (Number.isFinite(Number(next.area))) cfg.area = Number(next.area);
  if (Number.isFinite(Number(next.opacity))) cfg.opacity = Number(next.opacity);
  if (Number.isFinite(Number(next.scale))) cfg.scale = Number(next.scale);
  if (Number.isFinite(Number(next.speed))) cfg.speed = Number(next.speed);
  if (Number.isFinite(Number(next.weight))) cfg.weight = Number(next.weight);
  if (Number.isFinite(Number(next.max))) cfg.max = Number(next.max);
  if (next.stroke !== undefined) cfg.stroke = !!next.stroke;

  const root = document.documentElement.style;
  root.setProperty('--dm-area', `${cfg.area}vh`);
  root.setProperty('--dm-opacity', String(Math.min(1, Math.max(0.1, cfg.opacity / 100))));
  root.setProperty('--dm-scale', String(cfg.scale / 100));
  root.setProperty('--dm-duration', `${durationSeconds()}s`);
  root.setProperty('--dm-weight', String(Math.min(900, Math.max(400, cfg.weight))));
  // 关掉描边：把 text-shadow 置空即可
  root.setProperty(
    '--dm-shadow',
    cfg.stroke
      ? '1px 0 1px #000, 0 1px 1px #000, 0 -1px 1px #000, -1px 0 1px #000'
      : 'none'
  );

  // 方位箭头区域的圆形挖空：用 mask 让弹幕在那圈里「画不出来」。
  // 对比跟视频浮窗抢 z-order，这个方案不依赖 Windows 的置顶层级，
  // 无论窗口怎么排，箭头那块始终是干净的。
  applyHole(next.hole);

  tracks.length = 0;
}

/** 主进程切好的片段：{ t, seek, items: [{idx, t(ms), text, color}] } */
function onSlice(payload) {
  if (!payload) return;
  const t = Number(payload.t);
  if (!Number.isFinite(t)) return;

  clock.base = t;
  clock.perf = performance.now();

  if (payload.seek) clearAll();
  // 播放态交给 setPlaying 统一处理：不能先改 clock.playing，
  // 否则 setPlaying 会因为「状态没变化」直接 return，暂停动画就漏掉了
  setPlaying(payload.playing !== false);

  const items = Array.isArray(payload.items) ? payload.items : [];
  const known = new Set(queue.map((q) => q.idx));
  for (const it of items) {
    if (!it || !Number.isFinite(Number(it.t))) continue;
    if (shown.has(it.idx) || known.has(it.idx)) continue;
    queue.push({
      idx: it.idx,
      t: Number(it.t),
      text: String(it.text || ''),
      color: it.color
    });
  }
  queue.sort((a, b) => a.t - b.t);
  // 有新弹幕排队了，把休眠中的调度器叫醒
  if (queue.length) startLoop();
}

function onTime(payload) {
  if (!payload) return;
  const t = Number(payload.t);
  if (!Number.isFinite(t)) return;
  clock.base = t;
  clock.perf = performance.now();
  if (payload.playing !== undefined) setPlaying(!!payload.playing);
}

window.danmakuLayer.onConfig(applyConfig);
window.danmakuLayer.onSlice(onSlice);
window.danmakuLayer.onTime(onTime);
window.danmakuLayer.onReset(() => clearAll());

// 默认按「播放中」启动；真实状态随第一条 slice/time 消息校准。
// 这里没有队列，startLoop 会直接返回 —— 等第一片弹幕到了再转。
clock.playing = true;
startLoop();

// 调试：控制台可看队列/丢弃数
window.__danmakuStats = () => ({
  queued: queue.length,
  shown: shown.size,
  dropped,
  now: Number(nowSec().toFixed(2)),
  tracks: tracks.length
});
