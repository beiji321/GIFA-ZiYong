'use strict';

/* 原神跟跑助手 —— 渲染进程
   负责：<webview> 生命周期、播放器控制、进度条、快捷键与设置面板 */

const $ = (id) => document.getElementById(id);

const state = {
  boot: null,
  id: '',
  p: 1,
  pages: [],
  autoPlay: true,
  attached: false,
  guestReady: false,
  pendingUrl: '',
  queue: [],
  video: { found: false, playing: false, current: 0, duration: 0, rate: 1, muted: false, volume: 1 },
  seeking: false,
  drawer: false,
  uiTimer: null,
  toastTimer: null,
  immersiveTimer: null,
  loadIssuedAt: 0
};

let wv = null;

/* -------------------------------------------------------------- 分 P 同步 */

/** B 站视频页 URL 读 ?p=（1 起）；读不到返回 0 */
function partFromUrl(u) {
  const m = /[?&](?:p|page)=(\d+)/.exec(String(u || ''));
  const n = m ? Number(m[1]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 读 /video/BVxxx/ 或 /video/av123/，用来过滤旧页面迟到的状态心跳 */
function idFromUrl(u) {
  const m = /\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i.exec(String(u || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * 播放器自己跳到下一 P（自动连播 / 在 B 站页面里点分 P）时校准浮窗。
 * fromGuest = 来自访客页状态心跳：刚 loadVideo 完的 1.5s 内忽略，
 * 否则旧页面残留的一条 state 会把刚设好的页码拽回去。
 * Electron 层的导航事件带的是确定的新 URL，不受这个门限约束。
 */
function syncPartFromGuest(v, fromGuest) {
  const n = Number(v && v.p);
  if (!Number.isFinite(n) || n < 1 || n === state.p) return;
  if (!state.pages.length || n > state.pages.length) return;
  const vid = String((v && v.vid) || '').toLowerCase();
  if (vid && state.id && vid !== String(state.id).toLowerCase()) return;
  if (fromGuest && Date.now() - state.loadIssuedAt < 1500) return;
  setCurrentPart(n, true);
}

/** 统一写入当前分 P：下拉框、快捷键基准、下次启动的记忆一起走 */
function setCurrentPart(n, auto) {
  if (!Number.isFinite(n) || n < 1) return;
  state.p = n;
  closeCalib();
  resetLayoutHint();
  renderParts();
  if (!auto) return;
  try {
    const r = window.api.save({ lastPart: n });
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch {
    /* 设置写入失败不影响播放 */
  }
  toast(`已切到 P${n}${state.pages.length ? '/' + state.pages.length : ''}`, 1600);
}

/* ------------------------------------------------------------------ 启动 */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  state.boot = await window.api.boot();
  const s = state.boot.settings;

  state.pages = [];
  applyImmersionState(!!(state.boot.floatState && state.boot.floatState.immersion));

  createWebview();
  renderLayoutSelect();
  wireUi();
  wireHotkeys();

  pumpUi();

  document.body.classList.add('ui');

  if (!state.boot.nav || !state.boot.nav.loggedIn) {
    setTimeout(() => toast('未登录：部分视频只能看预览。点 ⚙ 打开启动器，在那边登录即可', 5200), 1200);
  }

  if (state.boot.failedHotkeys && state.boot.failedHotkeys.length) {
    const names = state.boot.failedHotkeys.map((f) => prettify(f.accelerator)).join('、');
    toast(`快捷键被占用，已失效：${names}`, 4200);
  }

  if (state.boot.initialUrl) {
    loadVideo(state.boot.initialUrl, 1, true);
  } else if (s.lastText) {
    // 「上次看到」：带标题和 Pn/总数提示，避免忘了自己在看哪个视频、第几 P。
    // autoplay=true 是用户明确要的「下次启动接着播」，不再是只把页面打开。
    const p = Number(s.lastPart) || 1;
    const total = Number(s.lastPageCount) || 0;
    loadVideo(s.lastText, p, true);
    const name = s.lastTitle || s.lastVideoId || s.lastText;
    toast(`继续上次观看：${name} · P${p}${total ? '/' + total : ''}`, 4200);
  } else {
    $('urlInput').focus();
  }
}

/* --------------------------------------------------------------- webview */

function createWebview() {
  wv = document.createElement('webview');
  wv.id = 'view';
  wv.setAttribute('partition', 'persist:bili');
  wv.setAttribute('preload', state.boot.webviewPreload);
  wv.setAttribute('src', 'about:blank');
  wv.style.width = '100%';
  wv.style.height = '100%';

  wv.addEventListener('dom-ready', () => {
    state.attached = true;
    state.guestReady = true;
    flush();
    if (state.pendingUrl) {
      const u = state.pendingUrl;
      state.pendingUrl = '';
      loadUrl(u);
    }
  });

  wv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'state') {
      applyState(e.args && e.args[0]);
      return;
    }
    if (e.channel === 'want-window-fullscreen') {
      // 访客侧把 requestFullscreen 改写成了「让窗口全屏」，这里转给主进程
      window.api.action('fullscreen', !!(e.args && e.args[0]));
      return;
    }
    if (e.channel === 'bearing') {
      onGuestBearing(e.args && e.args[0]);
      return;
    }
    if (e.channel === 'bearing-autocenter') {
      onGuestAutoCenter(e.args && e.args[0]);
      return;
    }
    if (e.channel === 'bearing-dump') {
      onGuestDump(e.args && e.args[0]);
      return;
    }
    if (e.channel === 'video-rect') {
      const fn = rectWaiter;
      rectWaiter = null;
      if (fn) fn(e.args && e.args[0]);
    }
  });

  wv.addEventListener('did-stop-loading', () => {
    state.guestReady = true;
    sendPlayer({ cmd: 'clean', on: true });
    syncBearingToGuest();
    if (state.autoPlay) {
      sendPlayer({ cmd: 'play' });
      setTimeout(() => sendPlayer({ cmd: 'play' }), 700);
    }
  });

  // 分 P 自动连播：Electron 层的导航事件是访客状态心跳之外的独立通道，
  // SPA pushState 和整页跳转都能拿到确定的新 URL（不依赖 B 站页面内部实现）。
  const onNav = (e) => {
    if (e && e.isMainFrame === false) return;
    const u = (e && e.url) || '';
    const p = partFromUrl(u);
    if (p) syncPartFromGuest({ p, vid: idFromUrl(u) }, false);
  };
  wv.addEventListener('did-navigate-in-page', onNav);
  wv.addEventListener('did-navigate', onNav);

  wv.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame) return;
    hidePlaceholderIfVideo();
    toast(`加载失败（${e.errorCode}），检查网络或换「网页版」试试`, 4000);
  });

  $('stage').appendChild(wv);
}

function loadUrl(url) {
  if (!state.attached) {
    state.pendingUrl = url;
    return;
  }
  try {
    wv.loadURL(url);
  } catch (err) {
    toast('载入失败：' + err.message, 4000);
  }
}

function sendPlayer(msg) {
  if (!wv) return;
  if (!state.guestReady) {
    state.queue.push(msg);
    return;
  }
  try {
    wv.send('player', msg);
  } catch {
    state.queue.push(msg);
  }
}

function flush() {
  const q = state.queue.splice(0);
  for (const m of q) sendPlayer(m);
}

/* ------------------------------------------------------- 小地图方位标记 */

function currentLayout() {
  const bearing = state.boot.settings.bearing;
  return bearing.layouts.find((layout) => layout.id === bearing.activeLayoutId);
}

function renderLayoutSelect() {
  const bearing = state.boot.settings.bearing;
  const select = $('layoutSelect');
  select.replaceChildren(...bearing.layouts.map((layout) => {
    const option = document.createElement('option');
    option.value = layout.id;
    option.textContent = layout.name;
    return option;
  }));
  select.value = bearing.activeLayoutId;
  select.title = `视频小地图布局：${currentLayout().name}`;
  select.classList.toggle('hidden', !bearing.enabled || bearing.layouts.length < 2);
}

function matchesCurrentLayout(payload) {
  const layout = currentLayout();
  return layout && payload && payload.layoutId === layout.id && payload.revision === layout.revision;
}

function syncBearingToGuest() {
  const bearing = state.boot.settings.bearing;
  const layout = currentLayout();
  sendPlayer({
    cmd: 'bearing',
    on: !!bearing.enabled,
    roi: layout?.roi || null,
    layoutId: layout?.id,
    revision: layout?.revision,
    autoCenter: !!layout && !layout.centered
  });
}

let layoutHintTimer = null;
let layoutHinted = false;

function resetLayoutHint() {
  clearTimeout(layoutHintTimer);
  layoutHintTimer = null;
  layoutHinted = false;
}

function onGuestBearing(payload) {
  if (!state.guestReady || !state.boot.settings.bearing.enabled || !matchesCurrentLayout(payload)) return;
  const hasAngle = typeof payload.angle === 'number';
  const hasView = typeof payload.view === 'number';
  if (payload.clear || hasAngle || hasView || payload.mapMissing === false) {
    resetLayoutHint();
  } else if (payload.mapMissing && !layoutHinted && !layoutHintTimer) {
    layoutHintTimer = setTimeout(() => {
      layoutHintTimer = null;
      if (!state.video.playing || !matchesCurrentLayout(payload)) return;
      layoutHinted = true;
      toast('当前布局找不到小地图，可到「方位标定」切换或新增布局', 6500);
    }, 7000);
  }
  window.api.bearing({
    layoutId: payload.layoutId,
    revision: payload.revision,
    angle: hasAngle ? payload.angle : null,
    confidence: payload.confidence || 0,
    view: hasView ? payload.view : null,
    viewConfidence: payload.viewConfidence || 0,
    viewSource: payload.viewSource || '',
    viewWidth: payload.viewWidth || 0,
    hold: !!payload.hold,
    clear: !!payload.clear,
    clearAngle: !!payload.clearAngle
  });
}

async function onGuestAutoCenter(payload) {
  if (!state.guestReady || payload?.phase !== 'done' || !matchesCurrentLayout(payload)) return;
  const result = await window.api.autoCenterResult(payload).catch(() => null);
  if (!result?.ok && payload.applied && matchesCurrentLayout(payload)) {
    sendPlayer({ cmd: 'autocenter-discard', layoutId: payload.layoutId, revision: payload.revision });
  }
  if (!result && payload.manual) toast('圆心结果未保存，请重试');
}

async function onGuestDump(p) {
  if (!p) return;
  if (!p.dataUrl) {
    toast(`抓帧失败：${p.error || '未知原因'}`, 5000);
    console.warn('[bearing-dump]', p);
    return;
  }
  const res = await window.api.saveDump(p);
  console.log('[bearing-dump]', { ...p, dataUrl: '(略)', file: res.file });
  // 说清楚落在哪个文件，别让人去 AppData 里瞎翻
  toast(`已存 bearing-frame.png（${res.dir}），${p.size}px / 不透明 ${p.opaque}/${p.total}`, 8000);
}

/* --------------------------------------------- 识别区域框选（标定） */

const calib = { open: false, target: null, box: null, cx: 0, cy: 0, r: 60 };
let rectWaiter = null;

/** 向视频端要一次 <video> 的位置信息 */
function requestVideoRect() {
  return new Promise((resolve) => {
    if (!wv || !state.guestReady) {
      resolve(null);
      return;
    }
    rectWaiter = resolve;
    try {
      wv.send('player', { cmd: 'video-rect' });
    } catch {
      rectWaiter = null;
      resolve(null);
      return;
    }
    setTimeout(() => {
      if (rectWaiter === resolve) {
        rectWaiter = null;
        resolve(null);
      }
    }, 1500);
  });
}

/**
 * <video> 元素框 → 浮窗里画面真正显示的区域（相对 #stage 左上角）。
 *
 * 注意坐标空间：videoRect 里的 x/y/w/h 是**访客页面**的 CSS 像素，而标定圆环画在
 * **浮窗**的 CSS 像素里。两者不一定相等（页面缩放、滚动条、webview 视口差异），
 * 直接混用会让框选位置整体偏掉。所以先用访客视口归一，再乘回浮窗尺寸。
 */
function contentBox(info) {
  const stage = $('stage').getBoundingClientRect();
  const W = stage.width || 1;
  const H = stage.height || 1;
  const vpW = info.vpW || W;
  const vpH = info.vpH || H;

  // 元素在浮窗坐标系里的位置与尺寸
  const ex = (info.x / vpW) * W;
  const ey = (info.y / vpH) * H;
  const ew = (info.w / vpW) * W;
  const eh = (info.h / vpH) * H;

  if (info.fit === 'fill') return { x: ex, y: ey, w: ew, h: eh };

  const scale =
    info.fit === 'cover' ? Math.max(ew / info.vw, eh / info.vh) : Math.min(ew / info.vw, eh / info.vh);

  const w = info.vw * scale;
  const h = info.vh * scale;
  return { x: ex + (ew - w) / 2, y: ey + (eh - h) / 2, w, h };
}

function paintCalib() {
  const el = $('calibBox');
  el.style.left = `${calib.cx - calib.r}px`;
  el.style.top = `${calib.cy - calib.r}px`;
  el.style.width = `${calib.r * 2}px`;
  el.style.height = `${calib.r * 2}px`;

  $('calibSize').textContent = `直径 ${Math.round(calib.r * 2)}px`;
}

function closeCalib() {
  calib.open = false;
  calib.target = null;
  $('calib').classList.add('hidden');
}

async function openCalib(command) {
  if (!state.id) return toast('请先载入一个视频，再框选小地图', 3200);
  if (rectWaiter || $('calibOk').disabled) return;
  const videoId = state.id;
  const part = state.p;
  const info = await requestVideoRect();
  if (videoId !== state.id || part !== state.p) return;
  if (!info?.ok) return toast('视频画面还没准备好，请稍后再试', 4000);

  const layout = currentLayout();
  if (!layout || (command.op === 'calibrate' && command.id !== layout.id)) return;
  calib.box = contentBox(info);
  calib.target = command.op === 'create' ? { op: 'create', name: command.name } : { op: 'calibrate', id: layout.id };
  const base = layout.roi;
  calib.cx = calib.box.x + base.cx * calib.box.w;
  calib.cy = calib.box.y + base.cy * calib.box.h;
  calib.r = base.r * calib.box.w;
  calib.open = true;
  $('calib').classList.remove('hidden');
  $('calibHint').textContent = `「${command.name || layout.name}」 · 拖动圆环、滚轮调大小，套住视频小地图即可`;
  paintCalib();
}

async function saveCalib() {
  const { box, target } = calib;
  const button = $('calibOk');
  if (!calib.open || !target || !box?.w || button.disabled) return;
  const roi = {
    cx: (calib.cx - box.x) / box.w,
    cy: (calib.cy - box.y) / box.h,
    r: calib.r / box.w
  };
  button.disabled = true;
  try {
    const result = await window.api.updateBearingLayout({ ...target, roi });
    if (!result.ok) {
      const messages = {
        duplicate: '已有同名布局，请返回「方位标定」换个名字',
        roi: '请把圆心放在视频画面内，并让圆环套住小地图'
      };
      toast(messages[result.reason] || '布局未保存，请重新框选');
      return;
    }
    if (calib.target === target) closeCalib();
    toast(state.boot.settings.bearing.enabled ? '布局已保存，播放时自动对准圆心' : '布局已保存，开启方位箭头后生效');
  } catch {
    toast('布局未保存，请重试');
  } finally {
    button.disabled = false;
  }
}

function wireCalib() {
  const box = $('calibBox');
  let drag = null;

  const stageOrigin = () => $('stage').getBoundingClientRect();

  box.addEventListener('pointerdown', (e) => {
    if (!calib.open) return;
    e.preventDefault();
    const o = stageOrigin();
    drag = { ox: calib.cx - (e.clientX - o.left), oy: calib.cy - (e.clientY - o.top) };
    box.setPointerCapture(e.pointerId);
  });

  box.addEventListener('pointermove', (e) => {
    if (!calib.open || !drag) return;
    const o = stageOrigin();
    calib.cx = e.clientX - o.left + drag.ox;
    calib.cy = e.clientY - o.top + drag.oy;
    paintCalib();
  });

  const stop = () => {
    drag = null;
  };
  box.addEventListener('pointerup', stop);
  box.addEventListener('pointercancel', stop);

  box.addEventListener(
    'wheel',
    (e) => {
      if (!calib.open) return;
      e.preventDefault();
      const max = calib.box ? calib.box.w * 0.45 : 400;
      calib.r = Math.min(max, Math.max(10, calib.r * (e.deltaY < 0 ? 1.08 : 0.926)));
      paintCalib();
    },
    { passive: false }
  );

  // 点空白处把圆心挪过去，省得小圈不好抓
  $('calib').addEventListener('pointerdown', (e) => {
    if (!calib.open || e.target !== $('calib')) return;
    const o = stageOrigin();
    calib.cx = e.clientX - o.left;
    calib.cy = e.clientY - o.top;
    paintCalib();
  });

  $('calibOk').addEventListener('click', saveCalib);
  $('calibCancel').addEventListener('click', closeCalib);
}

function savePlaybackPreference(patch) {
  Object.assign(state.boot.settings, patch);
  try {
    const result = window.api.save(patch);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    /* 设置写入失败不影响其它播放器控制 */
  }
}

/* ------------------------------------------------------------------ 载入 */

async function loadVideo(text, part, autoplay) {
  const t = String(text || '').trim();
  if (!t) {
    toast('先粘贴一个视频链接');
    return;
  }

  showPlaceholder('载入中…');
  const res = await window.api.load({ text: t, p: part || 1 });

  if (!res.ok) {
    toast(res.message || '载入失败', 4000);
    if (!state.video.found) showPlaceholder('粘贴一个 B 站攻略视频链接');
    return;
  }

  closeCalib();
  resetLayoutHint();
  window.api.bearing({ clear: true });
  state.id = res.id;
  state.p = res.p;
  state.pages = res.pages || [];
  state.autoPlay = !!autoplay;
  state.guestReady = false;
  state.queue = [];
  state.loadIssuedAt = Date.now();

  $('urlInput').value = t;
  $('videoTitle').textContent = res.title || res.id;
  $('videoTitle').title = res.owner ? `${res.title} · UP：${res.owner}` : res.title || '';
  $('partSelect').value = String(res.p);

  renderParts();
  toggleUrlbar(false);

  loadUrl(res.url);
  if (res.message) toast(res.message, 3500);
}

function renderParts() {
  const sel = $('partSelect');
  sel.textContent = '';

  if (!state.pages.length) {
    sel.classList.add('hidden');
    return;
  }

  const total = state.pages.length;
  let curLabel = '';
  for (const pg of state.pages) {
    const opt = document.createElement('option');
    opt.value = String(pg.page);
    // 「P3/20」把当前位置和总数都写进文本，长 part 名被 130px 截断时也还能看见；
    // 当前项再加 ▶ 文字标记，不依赖原生下拉的系统高亮色（会随系统主题变）。
    const label = `P${pg.page}/${total} ${pg.part || ''}`.trim();
    const cur = pg.page === state.p;
    opt.textContent = cur ? `▶ ${label}` : label;
    opt.title = label;
    sel.appendChild(opt);
    if (cur) curLabel = label;
  }
  sel.value = String(state.p);
  sel.title = curLabel ? `当前 ${curLabel}` : '分 P';
  sel.classList.toggle('hidden', total < 2);
}

function changePart(delta) {
  if (state.pages.length < 2) {
    toast('这个视频只有一个分 P');
    return;
  }
  const next = Math.min(state.pages.length, Math.max(1, state.p + delta));
  if (next === state.p) {
    toast(delta > 0 ? '已经是最后一个分 P' : '已经是第一个分 P');
    return;
  }
  loadVideo(state.id, next, true);
}

/* ---------------------------------------------------------------- 状态应用 */

function applyState(v) {
  if (!v) return;
  state.video = v;
  // 访客页心跳里带了 ?p=，自动连播下一 P 时在这里把下拉框校准过来
  syncPartFromGuest(v, true);

  if (v.found) hidePlaceholderIfVideo();

  // 图标是内联 SVG，这里只切状态 class，显示哪一枚由 style.css 决定
  $('btnPlay').classList.toggle('playing', !!v.playing);
  $('btnMute').classList.toggle('muted', !!(v.muted || v.volume === 0));
  $('btnSpeed').textContent = `${(v.rate || 1).toFixed(2).replace(/0$/, '')}×`;

  if (!state.seeking) paintProgress(v.current, v.duration);
  $('timeText').textContent = `${fmt(v.current)} / ${fmt(v.duration)}`;

  if (v.title && v.title !== '哔哩哔哩') $('videoTitle').textContent = v.title;
}

function paintProgress(cur, total) {
  const pct = total > 0 ? Math.min(100, (cur / total) * 100) : 0;
  $('bar').style.width = pct + '%';
  $('knob').style.left = pct + '%';
}

function fmt(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

/* -------------------------------------------------------------------- UI */

function wireUi() {
  $('btnLoad').addEventListener('click', () => loadVideo($('urlInput').value, 1, true));
  $('urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadVideo($('urlInput').value, 1, true);
    e.stopPropagation();
  });

  $('btnLink').addEventListener('click', () => {
    const bar = $('urlbar');
    const willHide = !bar.classList.contains('hidden');
    toggleUrlbar(!willHide);
    if (!willHide) $('urlInput').focus();
  });

  $('btnPlay').addEventListener('click', () => sendPlayer({ cmd: 'toggle' }));
  $('btnMute').addEventListener('click', () => {
    savePlaybackPreference({ muted: !state.boot.settings.muted });
  });
  $('btnSpeed').addEventListener('click', () => window.api.action('cycle-speed'));
  window.api.onNotice((text) => {
    if (text) toast(text);
  });
  window.api.onPlaybackState((next) => {
    if (!next) return;
    $('btnSpeed').classList.toggle('temporary', !!next.holdActive);
    $('btnSpeed').title = next.holdActive
      ? `临时 ${next.temporaryPlaybackRate}× · 松开恢复 ${next.playbackRate}×`
      : '循环倍速：1 → 1.25 → 1.5 → 2';
  });

  $('layoutSelect').addEventListener('change', async (event) => {
    const result = await window.api.updateBearingLayout({ op: 'select', id: event.target.value }).catch(() => null);
    if (result?.ok) return;
    renderLayoutSelect();
    toast('无法切换布局，请重试');
  });
  $('partSelect').addEventListener('change', (e) => {
    loadVideo(state.id, Number(e.target.value), true);
  });

  $('btnMin').addEventListener('click', () => window.api.action('minimize'));
  $('btnClose').addEventListener('click', () => window.api.action('close'));

  // 浮窗不带设置，⚙ 只负责把启动器叫到前台
  $('btnSettings').addEventListener('click', () => window.api.action('open-console'));

  // 主进程检测到登录成功 → 带 Cookie 重载，画质立刻可上 1080P/4K
  window.api.onLogin(async (nav) => {
    if (!nav) return null;
    toast(`已登录：${nav.uname}，正在按高清重载`, 3600);
    if (state.id) loadVideo(state.id, state.p, true);
    return null;
  });

  // 启动器发来的命令：开框选 / 抓一帧 / 换视频
  window.api.onFloatCmd((c) => {
    if (!c) return;
    if (c.cmd === 'calib' && c.command) openCalib(c.command);
    else if (c.cmd === 'autocenter') sendPlayer({ cmd: 'autocenter' });
    else if (c.cmd === 'dump') sendPlayer({ cmd: 'bearing', dump: true });
    else if (c.cmd === 'load' && c.text) loadVideo(c.text, Number(c.p) || 1, true);
  });

  // 启动器改了设置（方位开关、标记大小、音量等），浮窗这边跟着更新
  window.api.onSettingsChanged((next) => {
    if (!next) return;
    const previous = state.boot.settings.bearing;
    state.boot.settings = next;
    if (previous.activeLayoutId !== next.bearing.activeLayoutId || !next.bearing.enabled) resetLayoutHint();
    if (calib.target?.op === 'calibrate' && calib.target.id !== next.bearing.activeLayoutId) closeCalib();
    if (previous.activeLayoutId !== next.bearing.activeLayoutId || previous.enabled !== next.bearing.enabled ||
        JSON.stringify(previous.layouts) !== JSON.stringify(next.bearing.layouts)) renderLayoutSelect();
    syncBearingToGuest();
  });

  // 全屏时标题栏/控制条浮层化（设置入口在启动器里，这里只是为了不挡画面）
  window.api.onWinState((s) => {
    if (!s) return;
    if (s.fullscreen !== undefined) setImmersive(s.fullscreen);
    if (s.immersion !== undefined) applyImmersionState(s.immersion);
  });
  window.api.onFloatState((next) => {
    if (next && next.immersion !== undefined) applyImmersionState(next.immersion);
  });

  wireProgress();
  wireGrip();
  wireCalib();
  wireAutoHide();
}

function toggleUrlbar(show) {
  $('urlbar').classList.toggle('hidden', !show);
}


/* ---------------------------------------------------------------- 进度条 */

function wireProgress() {
  const el = $('progress');

  const ratio = (e) => {
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  const seekTo = (e) => {
    const d = state.video.duration;
    if (!d) return;
    const t = ratio(e) * d;
    paintProgress(t, d);
    $('timeText').textContent = `${fmt(t)} / ${fmt(d)}`;
    sendPlayer({ cmd: 'seek', value: t });
  };

  el.addEventListener('pointerdown', (e) => {
    if (!state.video.duration) {
      toast('视频还没准备好');
      return;
    }
    state.seeking = true;
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    seekTo(e);
  });

  el.addEventListener('pointermove', (e) => {
    if (!state.seeking) return;
    const d = state.video.duration;
    if (!d) return;
    const t = ratio(e) * d;
    paintProgress(t, d);
    $('timeText').textContent = `${fmt(t)} / ${fmt(d)}`;
  });

  el.addEventListener('pointerup', (e) => {
    if (!state.seeking) return;
    state.seeking = false;
    el.classList.remove('dragging');
    seekTo(e);
  });

  el.addEventListener('pointercancel', () => {
    state.seeking = false;
    el.classList.remove('dragging');
  });
}

/* ------------------------------------------------------------ 缩放手柄 */

function wireGrip() {
  const grip = $('grip');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startW = window.innerWidth;
    const startH = window.innerHeight;
    const sx = e.screenX;
    const sy = e.screenY;
    grip.setPointerCapture(e.pointerId);

    const move = (ev) => {
      window.api.action('resize', {
        w: Math.max(240, startW + (ev.screenX - sx)),
        h: Math.max(150, startH + (ev.screenY - sy))
      });
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
}

/* ------------------------------------------------------------ 自动隐藏 UI */

function wireAutoHide() {
  document.addEventListener('mousemove', wakeUi);
  document.addEventListener('mouseenter', wakeUi);
  wakeUi();
}

function wakeUi() {
  document.body.classList.add('ui');
  clearTimeout(state.uiTimer);
  state.uiTimer = setTimeout(() => {
    if (!state.video.playing || state.seeking || state.drawer) return;
    if ($('urlbar').matches(':hover') || $('titlebar').matches(':hover')) return;
    document.body.classList.remove('ui');
  }, 2600);
}

/**
 * 窗口全屏（= 视频全屏）时，标题栏和底部控制条改成浮层：默认淡出，
 * 鼠标移上去就出现。这样设置按钮不会被视频盖住，也不会挡画面。
 */
function setImmersive(on) {
  const app = $('app');
  app.classList.toggle('immersive', !!on);
  if (!on) return;
  // 刚进全屏先亮 3 秒，告诉用户「入口还在上面」，之后自己淡出
  const bar = $('titlebar');
  bar.classList.add('show');
  clearTimeout(state.immersiveTimer);
  state.immersiveTimer = setTimeout(() => bar.classList.remove('show'), 3000);
}

function applyImmersionState(on) {
  $('app').classList.toggle('video-only', !!on);
  if (on) {
    closeCalib();
    state.seeking = false;
  }
}

/* -------------------------------------------------------------- 快捷键 */

function wireHotkeys() {
  // 在地址栏里打字时，单键热键必须让路，否则敲个 j 就暂停了
  const isField = (el) => !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'checkbox' && el.type !== 'range';
  document.addEventListener('focusin', (e) => window.api.typing(isField(e.target)));
  document.addEventListener('focusout', () => window.api.typing(false));

  window.api.onHotkey((action) => {
    switch (action) {
      case 'togglePlay':
        sendPlayer({ cmd: 'toggle' });
        break;
      case 'seekBack':
        sendPlayer({ cmd: 'seekBy', value: -5 });
        break;
      case 'seekFwd':
        sendPlayer({ cmd: 'seekBy', value: 5 });
        break;
      case 'prevPart':
        changePart(-1);
        break;
      case 'nextPart':
        changePart(1);
        break;
      default:
        break;
    }
  });

  // 窗口聚焦时也支持键盘操作
  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.target && e.target.tagName === 'SELECT') return;
    if (e.key === 'Escape') {
      // 全屏优先退出全屏
      if ($('app').classList.contains('immersive')) window.api.action('fullscreen', false);
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      sendPlayer({ cmd: 'toggle' });
    } else if (e.code === 'ArrowLeft') {
      sendPlayer({ cmd: 'seekBy', value: -5 });
    } else if (e.code === 'ArrowRight') {
      sendPlayer({ cmd: 'seekBy', value: 5 });
    }
  });
}

function prettify(acc) {
  if (!acc) return '未设置';
  // 鼠标侧键单独映射，别让后续的 Left/Right 替换把它搅乱
  if (/^Mouse4$/i.test(acc)) return '鼠标侧键 ◀';
  if (/^Mouse5$/i.test(acc)) return '鼠标侧键 ▶';
  return String(acc)
    .replace(/\bSuper\b/g, 'Win')
    .replace(/\bLeft\b/g, '←')
    .replace(/\bRight\b/g, '→')
    .replace(/\bUp\b/g, '↑')
    .replace(/\bDown\b/g, '↓')
    .replace(/\bSpace\b/g, '空格');
}

/* ---------------------------------------------------------------- 占位层 */

function showPlaceholder(text) {
  const ph = $('placeholder');
  ph.classList.remove('hidden');
  ph.querySelector('p').textContent = text;
}

function hidePlaceholderIfVideo() {
  $('placeholder').classList.add('hidden');
}

function pumpUi() {
  // 占位文案随状态变化
  setInterval(() => {
    if (state.video.found) hidePlaceholderIfVideo();
  }, 800);
}

/* ------------------------------------------------------------------ toast */

function toast(text, ms = 2400) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
