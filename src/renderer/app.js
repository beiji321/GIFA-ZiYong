'use strict';

/* 原神跟跑助手 —— 渲染进程
   负责：<webview> 生命周期、播放器控制、进度条、快捷键与设置面板 */

const $ = (id) => document.getElementById(id);

const emptyVideo = { found: false, playing: false, current: 0, duration: 0, rate: 1, muted: false, volume: 1 };
const state = {
  boot: null,
  id: '',
  p: 1,
  pages: [],
  guestReady: false,
  queue: [],
  video: { ...emptyVideo },
  seeking: false,
  drawer: false,
  uiTimer: null,
  toastTimer: null,
  immersiveTimer: null,
  loadIssuedAt: 0,
  load: null,
  pendingLoad: null,
  loadTimer: null,
  compatible: false
};

let wv = null;

/* -------------------------------------------------------------- 分 P 同步 */

/** B 站视频页 URL 读 ?p=（1 起）；读不到返回 0 */
function partFromUrl(u) {
  const s = String(u || '');
  const m = /[?&](?:p|page)=(\d+)/.exec(s);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  // 第一 P 的地址通常就是 /video/BVxxx/ 不带 p 参数。
  // 以前这里返回 0，从 P2 自动回到 P1 时下拉框和弹幕都不会跟着退。
  return /\/video\/(?:BV[0-9A-Za-z]{10}|av\d+)/i.test(s) ? 1 : 0;
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
  // 分 P 列表读不到（开机时接口偶发失败）不能把自动连播一起挡死：
  // 页码照收，cid 由主进程按 p 自己去查。
  if (state.pages.length && n > state.pages.length) return;
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
  // 自动连播时弹幕/字幕在主进程里按 cid 缓存，必须让它按新的 P 换 cid。
  // 少了这一步，全屏弹幕会一直放上一 P 的（手动切 P 走 bili:load，不经过这里）。
  try {
    const r = window.api.part({ id: state.id, p: n });
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch {
    /* 换 P 失败不影响继续播 */
  }
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

  // 魔改扩展：按设置初始化 16:9 锁定按钮的状态
  $('btnRatio').classList.toggle('locked', s.ratioLocked === true);
  document.body.classList.toggle('ratio-locked', s.ratioLocked === true);

  /* 上游 v0.2.8 把 webview 创建改到 startPlayback 里按需做（配合「浮窗一直载入中」
   * 的修复），这里不再预先创建。wireChromeHeight 仍然要在启动时挂上，
   * 比例锁定要用它上报的 chrome 高度。 */
  wireChromeHeight();
  renderLayoutSelect();
  wireUi();
  wireHotkeys();

  document.body.classList.add('ui');

  if (state.boot.nav?.ok && !state.boot.nav.loggedIn) {
    setTimeout(() => toast('未登录：部分视频只能看预览。点 ⚙ 打开启动器，在那边登录即可', 5200), 1200);
  }

  if (state.boot.failedHotkeys && state.boot.failedHotkeys.length) {
    const names = state.boot.failedHotkeys.map((f) => prettify(f.accelerator)).join('、');
    toast(`快捷键被占用，已失效：${names}`, 4200);
  }

  if (state.boot.initialUrl) {
    loadVideo(state.boot.initialUrl, undefined, true);
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

function wireChromeHeight() {
  const stage = $('stage');
  if (!stage || typeof ResizeObserver !== 'function') return;
  let last = -1;
  let timer = null;
  let firstAt = 0;
  const flush = () => {
    timer = null;
    firstAt = 0;
    const h = Math.round(window.innerHeight - stage.clientHeight);
    if (!Number.isFinite(h) || h < 0 || h >= 400 || h === last) return;
    last = h;
    try {
      window.api.action('chrome-height', { h });
    } catch {
      /* 报不上去就还是用主进程自己量的兜底值 */
    }
  };
  const report = () => {
    const now = Date.now();
    if (!firstAt) firstAt = now;
    clearTimeout(timer);
    /* 布局稳定 300ms 之后再报。
     * 刚打开窗口那一刻量到的是半成品（地址栏还没收起来，量出 105，
     * 真实是 66），报上去会把已知正确的高度改坏，窗口还会当场弹一下。
     * 最多等 1.5 秒，避免一直不稳定时一次都报不上去。 */
    timer = setTimeout(flush, now - firstAt > 1500 ? 0 : 300);
  };
  new ResizeObserver(report).observe(stage);
  window.addEventListener('resize', report);
  report();
  // 再补一段定时采样：地址栏收起、控制条重排这类变化有时不触发
  // ResizeObserver（父容器尺寸没动），只靠它可能一次都报不上来。
  // 启动这八秒管够了，之后布局不再变。
  const until = Date.now() + 8000;
  const poll = setInterval(() => {
    if (Date.now() > until) {
      clearInterval(poll);
      return;
    }
    report();
  }, 400);
}

function discardWebview() {
  const previous = wv;
  wv = null;
  previous?.remove();
  state.guestReady = false;
  state.queue = [];
  state.video = { ...emptyVideo };
  state.seeking = false;
  $('progress').classList.remove('dragging');
  paintVideoControls();
  const finishRect = rectWaiter;
  rectWaiter = null;
  finishRect?.(null);
}

function createWebview(load) {
  const view = document.createElement('webview');
  const active = () => wv === view && state.load === load;
  wv = view;
  view.id = 'view';
  view.setAttribute('partition', 'persist:bili');
  if (state.compatible) view.setAttribute('webpreferences', 'sandbox=no');
  view.setAttribute('src', load.url);

  view.addEventListener('dom-ready', () => {
    if (!active()) return;
    load.documentReady = true;
    state.guestReady = true;
    sendPlayer({ cmd: 'ping' });
    sendPlayer({ cmd: 'clean', on: true });
    syncBearingToGuest();
    if (load.autoplay) sendPlayer({ cmd: 'play' });
    flush();
  });

  view.addEventListener('did-finish-load', () => {
    if (active() && load.autoplay && !state.video.ready && !state.video.playing) sendPlayer({ cmd: 'play' });
  });

  view.addEventListener('ipc-message', (event) => {
    if (!active() || !state.guestReady) return;
    const payload = event.args?.[0];
    switch (event.channel) {
      case 'state': applyState(payload); break;
      case 'want-window-fullscreen': window.api.action('fullscreen', !!payload); break;
      case 'bearing': onGuestBearing(payload); break;
      case 'bearing-autocenter': onGuestAutoCenter(payload); break;
      case 'bearing-dump': onGuestDump(payload); break;
      case 'video-rect': {
        const finishRect = rectWaiter;
        rectWaiter = null;
        finishRect?.(payload);
        break;
      }
      /* ---- 魔改扩展：访客页调试日志 ---- */
      case 'guest-log': {
        const text = String(payload || '');
        console.log('[guest]', text);
        if (/^\[bearing\]/.test(text)) {
          try {
            window.api.diag('guestBearing', { line: text.slice(0, 200) });
          } catch {
            /* 日志失败不影响功能 */
          }
        }
        break;
      }
      /* ---- 魔改扩展：字幕精灵 ---- */
      case 'subtitle-time':
        window.api.subtitleTime(payload);
        break;
      case 'subtitle': {
        window.api.subtitle(payload || {});
        if (payload && !payload.off && payload.text) {
          detectTurn(payload.text);
          detectCompassDir(payload.text);
          if (/地图|锚点|传送/.test(payload.text)) window.api.avoidHide();
        }
        break;
      }
      default: break;
    }
  });

  const onNav = (event) => {
    if (!active() || !event.isMainFrame) return;
    const part = partFromUrl(event.url);
    const id = idFromUrl(event.url);
    if (part && id) syncPartFromGuest({ p: part, vid: id }, false);
  };
  view.addEventListener('did-navigate-in-page', onNav);
  /* 整页跳转（B 站某些入口是 document 级导航，不触发 in-page）。
   * 上游 v0.2.8 用 did-frame-navigate 覆盖了这种情况，但它的 event 是
   * (event, url, httpResponseCode, httpStatusText) 签名；
   * 这里额外挂 did-navigate 作为显式通道，保证自动连播不漏。 */
  view.addEventListener('did-navigate', onNav);
  view.addEventListener('did-frame-navigate', (event) => {
    if (!active() || !event.isMainFrame) return;
    // 未提交的导航可能被拦截，原文档此时仍可播放。
    if (load.committed || load.documentReady) {
      state.guestReady = false;
      load.documentReady = false;
      load.failed = false;
      state.video = { ...emptyVideo };
      paintVideoControls();
      showPlaceholder('正在打开 B 站播放页…');
      armPlaybackTimeout(load);
    }
    load.committed = true;
    onNav(event);
    if (event.httpResponseCode >= 400) {
      showLoadFailure(load, `B 站页面返回 HTTP ${event.httpResponseCode}`);
    }
  });
  view.addEventListener('did-fail-load', (event) => {
    if (!active() || !event.isMainFrame || event.errorCode === -3) return;
    showLoadFailure(load, `B 站页面打开失败（${event.errorCode}）`);
  });
  view.addEventListener('render-process-gone', (event) => {
    if (!active() || event.details.reason === 'clean-exit') return;
    state.guestReady = false;
    state.video = { ...emptyVideo };
    paintVideoControls();
    const { reason, exitCode } = event.details;
    const hexCode = `0x${(exitCode >>> 0).toString(16).toUpperCase()}`;
    const offerCompatibility = state.boot.playbackCompatibility && !state.compatible && !load.committed &&
      (reason === 'crashed' || reason === 'abnormal-exit') && hexCode === '0x80000003';
    showLoadFailure(load, `播放页进程退出（${hexCode}）`, offerCompatibility);
  });

  $('stage').appendChild(view);
}


function sendPlayer(msg) {
  if (!wv) return;
  if (!state.guestReady) {
    state.queue.push(msg);
    return;
  }
  wv.send('player', msg).catch(() => {});
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

function syncSubtitleToGuest() {
  const st = state.boot && state.boot.settings;
  if (!st) return;
  const sprite = !!st.enableSubtitleSprite;
  sendPlayer({
    cmd: 'subtitle',
    on: sprite || !!st.enableTurnReminder,
    // 停留时长：由访客页按视频进度判断过期（暂停不推进、倍速正确）
    hold: Number(st.subtitleHold) || 3,
    // 字幕精灵 + 「隐藏原生字幕」都开着时才把播放器那条变透明
    hideNative: sprite && st.subtitleHideNative !== false,
    // 是否允许自动点开播放器字幕按钮
    autoOpen: st.subtitleAutoOpen !== false
  });
}
/** 主进程拉到官方字幕轨后通知，转发给访客页切换模式 */
/**
 * 隐藏播放器原生弹幕。
 *
 * 投影层开着 + 开关开着才藏；否则播放器那条照常显示，
 * 不然用户会以为「弹幕没了」。
 */
function syncDanmakuHideToGuest() {
  const st = state.boot && state.boot.settings;
  if (!st) return;
  sendPlayer({
    cmd: 'danmaku-hide',
    on: !!st.enableDanmakuProjection && st.danmakuHideNative !== false
  });
}
function syncSubtitleApiToGuest(st) {
  sendPlayer({ cmd: 'subtitle-api', on: !!(st && st.on) });
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

function syncBearingToGuest(extra) {
  const bearing = state.boot.settings.bearing;
  const layout = currentLayout();
  const cfg = {
    cmd: 'bearing',
    on: !!bearing.enabled,
    roi: layout?.roi || null,
    layoutId: layout?.id,
    revision: layout?.revision,
    autoCenter: !!layout && !layout.centered,
    // 视觉绿弧：之前没传，访客页一直是默认的 false，所以绿弧永远不画
    greenArc: state.boot.settings.enableVisionGreenArc === true,
    ...(extra || {})
  };
  /* 发出去的是「能不能启动识别」的全部依据：
   * on / roi / layoutId / greenArc。箭头不出来时先看这一行，
   * 就能分清是没下发、还是下发错了、还是访客页收到后没启动。 */
  try {
    window.api.diag('bearingSent', {
      on: cfg.on,
      hasRoi: !!cfg.roi,
      layoutId: cfg.layoutId,
      revision: cfg.revision,
      greenArc: cfg.greenArc,
      guestReady: !!state.guestReady
    });
  } catch {
    /* 日志失败不影响功能 */
  }
  sendPlayer(cfg);
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
    clearAngle: !!payload.clearAngle,
    // 魔改扩展：识别健康度随每帧一起上报，主进程拿它算成功率。
    // 不带上这个字段，控制台的「识别/最近/原因」永远是空的。
    stats: payload.stats || null
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

  const load = { text: t, part, autoplay };
  state.pendingLoad = load;
  if (!wv) showPlaceholder('正在读取视频信息…');

  let res;
  try {
    res = await window.api.load({ text: t, p: part });
  } catch {
    res = { ok: false, message: '未能读取视频信息' };
  }
  if (state.pendingLoad !== load) return;
  state.pendingLoad = null;
  if (!res?.ok) {
    const message = res?.message || '未能读取视频信息';
    if (wv) {
      toast(message, 4000);
    } else {
      state.load = load;
      showLoadFailure(load, message);
    }
    return;
  }

  closeCalib();
  resetLayoutHint();
  window.api.bearing({ clear: true });
  load.url = res.url;
  state.id = res.id;
  state.p = res.p;
  state.pages = res.pages || [];
  $('urlInput').value = t;
  $('videoTitle').textContent = res.title || res.id;
  $('videoTitle').title = res.owner ? `${res.title} · UP：${res.owner}` : res.title || '';
  $('partSelect').value = String(res.p);

  renderParts();
  toggleUrlbar(false);
  startPlayback(load);
  if (res.message) toast(res.message, 3500);
}

function playbackUrl(load) {
  const url = new URL(load.url);
  url.searchParams.set('p', String(state.p));
  return url.href;
}

function startPlayback(load) {
  state.load = load;
  discardWebview();
  closeCalib();
  resetLayoutHint();
  window.api.bearing({ clear: true });
  state.loadIssuedAt = Date.now();
  showPlaceholder('正在打开 B 站播放页…');
  armPlaybackTimeout(load);
  createWebview(load);
}

function retryPlayback() {
  const load = state.load;
  if (!load?.failed || state.pendingLoad) return;
  if (!load.url) {
    loadVideo(load.text, load.part, load.autoplay);
    return;
  }
  if (load.offerCompatibility) state.compatible = true;
  startPlayback({ text: load.text, url: playbackUrl(load), autoplay: load.autoplay });
}

function armPlaybackTimeout(load) {
  clearTimeout(state.loadTimer);
  state.loadTimer = setTimeout(() => {
    const message = load.documentReady ? 'B 站播放页已打开，视频读取超时' : 'B 站播放页打开超时';
    showLoadFailure(load, message);
  }, 22000);
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
  const load = state.load;
  if (!load) return;
  if (v.verification) {
    showLoadFailure(load, 'B 站要求安全验证');
    return;
  }
  state.video = { ...emptyVideo, ...v };
  syncPartFromGuest(v, true);

  if (v.mediaError) {
    showLoadFailure(load, `视频读取失败（媒体错误 ${v.mediaError}）`);
  } else if (v.ready) {
    clearTimeout(state.loadTimer);
    load.failed = false;
    $('placeholder').classList.add('hidden');
  }
  paintVideoControls();
  if (v.title && v.title !== '哔哩哔哩') $('videoTitle').textContent = v.title;
}

function paintVideoControls() {
  const v = state.video;
  $('btnPlay').classList.toggle('playing', !!v.playing);
  $('btnMute').classList.toggle('muted', !!(v.muted || v.volume === 0));
  $('btnSpeed').textContent = `${(v.rate || 1).toFixed(2).replace(/0$/, '')}×`;
  if (!state.seeking) paintProgress(v.current, v.duration);
  $('timeText').textContent = `${fmt(v.current)} / ${fmt(v.duration)}`;

  if (v.title && v.title !== '哔哩哔哩') $('videoTitle').textContent = v.title;

  // 魔改扩展：把播放进度转给主进程 —— 字幕按它查表，弹幕按它切片。
  // 复用上游已有的心跳（timeupdate 触发），不再单独开定时器。
  if (v.found) {
    window.api.subtitleTime({ t: v.current, paused: !v.playing });
    reportDanmakuTime(v);
  }
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
  const loadInput = () => loadVideo($('urlInput').value, undefined, true);
  $('btnLoad').addEventListener('click', loadInput);
  $('urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadInput();
    e.stopPropagation();
  });
  $('btnRetry').addEventListener('click', retryPlayback);
  $('btnBrowser').addEventListener('click', async () => {
    if (!state.load?.url) return;
    const opened = await window.api.action('open-video-browser', playbackUrl(state.load)).catch(() => false);
    if (!opened) toast('无法打开默认浏览器');
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
  // 魔改扩展：16:9 比例锁定
  $('btnRatio').addEventListener('click', async () => {
    const locked = await window.api.action('ratio-lock');
    $('btnRatio').classList.toggle('locked', !!locked);
    document.body.classList.toggle('ratio-locked', !!locked);
  });
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
  /* 接口字幕模式的方位判定入口。
   *
   * 这条通道走的是 preload 的 ipcRenderer.on，属于**浮窗主渲染进程**；
   * 而 webview 的 ipc-message 是另一条独立通道，两者不能混用。
   * 之前把它写在 webview 分支里，主进程发的文本根本没人收 ——
   * 表现就是「接口字幕模式下罗盘永远不亮」，切 P 后尤其明显。 */
  window.api.onCompassText((p) => {
    if (!p || !p.text) return;
    detectTurn(p.text);
    detectCompassDir(p.text);
    if (/地图|锚点|传送/.test(p.text)) window.api.avoidHide();
  });

  window.api.onSettingsChanged((next) => {
    if (!next) return;
    const previous = state.boot.settings.bearing;
    state.boot.settings = next;
    if (previous.activeLayoutId !== next.bearing.activeLayoutId || !next.bearing.enabled) resetLayoutHint();
    if (calib.target?.op === 'calibrate' && calib.target.id !== next.bearing.activeLayoutId) closeCalib();
    if (previous.activeLayoutId !== next.bearing.activeLayoutId || previous.enabled !== next.bearing.enabled ||
        JSON.stringify(previous.layouts) !== JSON.stringify(next.bearing.layouts)) renderLayoutSelect();
    syncBearingToGuest();
    syncSubtitleToGuest();
    syncDanmakuHideToGuest();
    // 关掉开关时立刻清屏，不等停留时长走完
    if (!next.enableSubtitleSprite) hideSubtitleSprite();
    if (!next.enableTurnReminder) hideTurnHint();
  });

  // 魔改扩展：缩放冻结 —— 拖窗口边缘时把 webview 按旧尺寸 transform 拉伸，
  // 避免它每帧重新布局导致边缘闪黑边
  window.api.onResizePhase((payload) => {
    if (payload && payload.active) beginResizeFreeze();
    else endResizeFreeze();
  });

  // 魔改扩展：贴边吸附提示线
  window.api.onSnapEdges((payload) => {
    const edges = (payload && payload.edges) || [];
    const map = { left: 'snapL', right: 'snapR', top: 'snapT', bottom: 'snapB' };
    for (const [edge, id] of Object.entries(map)) {
      const el = $(id);
      if (el) el.classList.toggle('show', edges.includes(edge));
    }
  });

  // 主进程拉到官方字幕轨后通知：转发给访客页切换成「按时间查表」模式
  window.api.onSubtitleApi((st) => syncSubtitleApiToGuest(st));

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
  // 魔改扩展：chrome 高度从 64 变成 0（或反过来），让主进程重新量一次并对齐比例，
  // 否则沉浸模式下 16:9 视频会上下留黑边
  window.api.action('ratio-refit');
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

function showPlaceholder(text, hint = '', failed = false) {
  const ph = $('placeholder');
  ph.classList.remove('hidden');
  ph.classList.toggle('failed', failed);
  ph.querySelector('p').textContent = text;
  $('placeholderHint').textContent = hint;
  $('placeholderHint').hidden = !hint;
  $('loadActions').hidden = !failed;
}

function showLoadFailure(load, message, offerCompatibility = false) {
  if (state.load !== load || (load.failed && !offerCompatibility)) return;
  clearTimeout(state.loadTimer);
  load.failed = true;
  load.offerCompatibility = offerCompatibility;
  $('btnRetry').textContent = offerCompatibility ? '兼容重试' : '重试';
  $('btnBrowser').hidden = !load.url;
  const hint = offerCompatibility ? '兼容重试会关闭本浮窗的播放页沙箱' : '';
  showPlaceholder(message, hint, true);
}

/* ------------------------------------------------------------------ toast */

function toast(text, ms = 2400) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/* ================================================================ 魔改扩展
 * 转向提醒：字幕里出现「左转 / 往东」这类词时，在画面边缘弹一个大箭头。
 * 整段独立，不引用上游的私有状态。
 */

const TURN_RULES = [
  { dir: 'left', group: 'lr', label: '左', re: /(左转|向左|往左|左前|左侧|左边|左拐|左方|靠左)/ },
  { dir: 'right', group: 'lr', label: '右', re: /(右转|向右|往右|右前|右侧|右边|右拐|右方|靠右)/ },
  // 抬头 / 低头 也算「上」「下」：都是让你把视线或人往上下挪，不必分两套提示
  {
    dir: 'up',
    group: 'ud',
    label: '上',
    re: /(抬头|抬一下头|往上看|向上看|看上面|看上方|上面看|向前|往前|直行|直走|一直走|前行|上楼|往上|向上)/
  },
  {
    dir: 'down',
    group: 'ud',
    label: '下',
    re: /(低头|低一下头|往下看|向下看|看下面|看下方|下面看|向后|往后|后退|倒退|掉头|回头|下楼|往下|向下)/
  }
];

let lastTurnAt = 0;
let lastTurnDir = '';

/** 命中「左」或「右」就发给字幕层；同一方向 1.2 秒内不重复弹 */
function detectTurn(text) {
  if (!state.boot || !state.boot.settings.enableTurnReminder) return;

  // 分开启用：只匹配开启的那一组（左右 / 上下）
  const lr = state.boot.settings.turnEnableLR !== false;
  const ud = state.boot.settings.turnEnableUD !== false;
  if (!lr && !ud) return;

  const hit = TURN_RULES.find((r) => {
    if (r.group === 'lr' && !lr) return false;
    if (r.group === 'ud' && !ud) return false;
    return r.re.test(text);
  });
  if (!hit) return;

  const now = Date.now();
  if (hit.dir === lastTurnDir && now - lastTurnAt < 1200) return;
  lastTurnDir = hit.dir;
  lastTurnAt = now;
  console.log('[turn] 命中', hit.dir, '←', text);
  // 只发单字，UI 里不再拼「转」之类的后缀
  window.api.turn({ dir: hit.dir, label: hit.label, text });
}

function hideSubtitleSprite() {
  window.api.subtitle({ off: true });
}

/** 收起转向提示（换片 / 关开关时用） */
function hideTurnHint() {
  lastTurnDir = '';
  lastTurnAt = 0;
  window.api.turn({ off: true });
}

/* ------------------------------------------------ 魔改扩展：缩放冻结
 *
 * 拖窗口边缘时，webview 每帧都要重新布局，边缘会闪黑边。
 * 做法：冻结时记下 webview 的旧尺寸，用 transform 把它拉伸铺满新的 stage，
 * 松手后再恢复真实尺寸让 Chromium 重排一次。
 */

let freezeRect = null;
let freezeTimer = null;

function beginResizeFreeze() {
  if (!wv) return;
  if (!freezeRect) {
    freezeRect = { width: wv.offsetWidth || 1, height: wv.offsetHeight || 1 };
    wv.classList.add('resize-freeze');
    const stage = $('stage');
    if (stage) stage.classList.add('resizing');
  }
  paintResizeFreeze();
  clearTimeout(freezeTimer);
  freezeTimer = setTimeout(endResizeFreeze, 180);
}

function endResizeFreeze() {
  clearTimeout(freezeTimer);
  freezeTimer = null;
  freezeRect = null;
  if (!wv) return;
  wv.classList.remove('resize-freeze');
  wv.style.width = '';
  wv.style.height = '';
  wv.style.transform = '';
  const stage = $('stage');
  if (stage) stage.classList.remove('resizing');
}

function paintResizeFreeze() {
  const stage = $('stage');
  if (!wv || !freezeRect || !stage) return;
  const w = stage.clientWidth || 1;
  const h = stage.clientHeight || 1;
  wv.style.width = `${freezeRect.width}px`;
  wv.style.height = `${freezeRect.height}px`;
  wv.style.transform = `scale(${w / freezeRect.width}, ${h / freezeRect.height})`;
}

/* ================================================================ 魔改扩展
 * 字幕方位解析：从字幕里认出「往东 / 东北 / 地图左下角」这类指令，
 * 转成绝对方位角发给叠加层（雷达模式下点亮对应扇形）。
 * 上游叠加层没有雷达，收到 cue 也不会响应，所以这套解析可以常开。
 */

const DIR_NAMES = [
  { deg: 0, label: '北' },
  { deg: 45, label: '东北' },
  { deg: 90, label: '东' },
  { deg: 135, label: '东南' },
  { deg: 180, label: '南' },
  { deg: 225, label: '西南' },
  { deg: 270, label: '西' },
  { deg: 315, label: '西北' }
];

function nearestDirName(deg) {
  let best = DIR_NAMES[0];
  let bestD = 999;
  for (const d of DIR_NAMES) {
    const diff = Math.abs(((deg - d.deg + 540) % 360) - 180);
    if (diff < bestD) {
      bestD = diff;
      best = d;
    }
  }
  return best.label;
}

/**
 * 抽方位原子。返回 Set，元素是 '东'/'西'/'南'/'北' 的子集。
 * 七步清洗，顺序不能换（尤其「切分」必须在「归一化」之前）。
 */
/**
 * 把一句话拆成「带句内位置的方位片段」。
 *
 *   「先往东然后往北」        → [{f:0.00, 东}, {f:0.50, 北}]
 *   「然后来西南方向地图左下角」→ [{f:0.00, 西南}]
 *   「我们走吧然后往东」       → [{f:0.60, 东}]
 *
 * fraction 是这一小段在整句里的字符位置占比，用来决定它该在什么时候点亮。
 *
 * 注意「再」用前瞻切分：只吃掉「再」，保留后面的「往/向/朝」。
 * 否则「再往东北一点」会被切成「东北一点」，「往」这个上下文就丢了，
 * 后面的上下文校验会把它当裸字直接跳过。
 */
function directionSegments(text) {
  const raw = String(text || '').replace(/\s+/g, '').slice(0, 500);
  if (!raw) return [];

  const parts = raw.split(/然后|接着|随后|再(?=往|向|朝|走|去)/);
  const out = [];
  let cursor = 0;
  for (const part of parts) {
    if (!part) continue;
    const at = raw.indexOf(part, cursor);
    const start = at < 0 ? cursor : at;
    cursor = start + part.length;
    const atoms = atomsInPhrase(part);
    if (!atoms.size) continue;
    out.push({
      // 夹到 0.95：最后一段也不该排到句子结束之后
      fraction: Math.min(0.95, start / Math.max(1, raw.length)),
      atoms
    });
  }
  return out;
}


/** 在**单个**片段里抽方位原子（七步清洗的后六步） */
function atomsInPhrase(text) {
  let s = String(text || '');
  if (!s) return new Set();

  // 2) 剔除含方位字但根本不是方向的词（「这东西不错」「东北虎」）
  s = s.replace(/东西南北|东西(?:方)?|北京|南京|东京|西瓜|东北虎|东风|南瓜/g, '');

  // 3) 口语说法归一化：北偏东 / 东偏北 → 东北
  s = s.replace(/北偏东|东偏北/g, '东北');
  s = s.replace(/南偏东|东偏南/g, '东南');
  s = s.replace(/北偏西|西偏北/g, '西北');
  s = s.replace(/南偏西|西偏南/g, '西南');

  // 4) 否定句不触发：「不要往东」「别往南走」。
  //    原来那套硬正则会把「不要往东」点亮成东，直接指反方向。
  s = s.replace(
    /(?:不要|别|不能|不是|不往|不向|不朝)[^，。；！？,;!?]{0,6}?[东西南北](?:[东西南北])?(?:方向|边|方)?/g,
    ''
  );

  // 5) 匹配 1~2 个方位字，但**要求上下文**，避免「上面有个宝箱」这类裸字误触发
  const found = new Set();
  const re = /[东西南北]{1,2}/g;
  let m;
  while ((m = re.exec(s))) {
    const word = m[0];
    const before = s.slice(Math.max(0, m.index - 4), m.index);
    const after = s.slice(m.index + word.length, m.index + word.length + 4);
    const ok =
      s === word ||
      s === '正' + word ||
      /往|向|朝|面|转|偏/.test(before) ||
      /^(方向|边|方|侧|面|角|走|前进|这边)/.test(after);
    if (!ok) continue;
    for (const ch of word) found.add(ch);
  }
  return found;
}


/**
 * 原子集合 → 罗盘角（0=北、顺时针）。
 * 冲突（东西同时出现 / 南北同时出现）或空集返回 null。
 */
function atomsToCompass(active) {
  if (!active || !active.size) return null;
  if (active.has('东') && active.has('西')) return null;
  if (active.has('南') && active.has('北')) return null;
  const x = (active.has('东') ? 1 : 0) - (active.has('西') ? 1 : 0);
  const y = (active.has('南') ? 1 : 0) - (active.has('北') ? 1 : 0);
  if (!x && !y) return null;
  // atan2(x, -y)：正北 = 0°，正东 = 90°，正南 = 180°，正西 = 270°
  let deg = (Math.atan2(x, -y) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

/** 每来一句新字幕就 +1；延时任务发现 token 变了就放弃，避免旧句子的方向串到新句子 */
let compassToken = 0;
/** 上一次点亮的方位与时间，用于同方位去抖（800ms 内不重复点亮） */
let lastCompassCue = { deg: -1, at: 0 };
/** 上一次处理过的字幕原文：同一句被反复推送时不再重复点亮 */
let lastCompassText = '';
/**
 * 最近一次解析出的方位角。
 *
 * 用来判断「延时点亮的那个方向是不是已经过时了」：AI 字幕是逐字上屏的，
 * 每 100~200ms 就送来一条新文本，句子里那个方位却一直没变。
 * 原来只看 token 变没变，于是每次都在 240ms 的等待期里被下一条顶掉，
 * 定时器永远到不了点亮那一步 —— 表现就是「字幕说了方向，雷达不亮」。
 */
let lastCompassDegs = [];

/** 上一次续期的时间：同一句字幕反复推送时，按节奏续期而不是每次都发 */
let lastCompassRefresh = 0;

/**
 * 续期：光晕还在、字幕也没走，就把它再往后延一延。
 *
 * 不能走 fireCompassCue —— 那里有「同方位 3 秒内不重复」的去抖，
 * 正是为了防逐字上屏时反复闪。续期要的恰好是相反的语义：
 * 不重新播开头的脉冲，只把 cueAt 往后推（叠加层那边 same 分支就是这么做的）。
 */
function refreshCompassCue(deg) {
  if (!Number.isFinite(deg)) return;
  window.api.compassCue({ deg: Math.round(deg), label: nearestDirName(deg), text: lastCompassText.slice(0, 50) });
}

/** 真正点亮一个方位（带同方位去抖） */
function fireCompassCue(deg) {
  const now = Date.now();
  // 同一方位在停留时间内不重复点亮。
  // 按文字去重不够：AI 字幕会逐字上屏，同一句话每次都是不同的字符串，
  // 每次都算「新字幕」就每次都点亮一次，看着就是不停闪。按角度去重才可靠。
  if (Math.abs(deg - lastCompassCue.deg) < 1 && now - lastCompassCue.at < 3000) {
    // 同方位 3 秒内不重复点亮。记一条，免得和「根本没识别出来」混为一谈。
    if (window.api.compassNone) {
      window.api.compassNone({ text: lastCompassText.slice(0, 50), reason: 'dedupe', deg: Math.round(deg) });
    }
    return;
  }
  lastCompassCue = { deg, at: now };
  // 留一行日志：F12 打开浮窗控制台就能看到每次点亮，
  // 判断「闪两下」到底是同方位重复触发还是两个不同方位交替。
  console.log('[compass] 点亮', Math.round(deg), nearestDirName(deg), '←', lastCompassText.slice(0, 40));
  window.api.compassCue({ deg: Math.round(deg), label: nearestDirName(deg), text: lastCompassText.slice(0, 50) });
}

/**
 * 一句字幕里可能有多条方向指令，按句内位置依次点亮。
 *
 *   「先往东然后往北」→ 立刻亮东，约半句之后亮北
 *
 * 时长怎么估：我们没有字幕的精确 from/to（那是官方字幕接口才有的），
 * 只能按字数估口播时长 —— 中文攻略口播约 5 字/秒，取 0.18 秒/字，
 * 夹在 1.2~8 秒之间。误差肯定有，但「同一句里第二个方向要不要亮」
 * 这件事本身比精确时刻更重要。
 */
/**
 * 去掉括号里的补充说明。
 *
 * 「东方向 地图右边（西方向 地图左边）」括号里是对同一位置的复述，
 * 但它带着「西」字，和前面的「东」一起送进 atomsToCompass 会被判成
 * 自相矛盾，整句直接不亮 —— 明明字幕说得很清楚，雷达却没反应。
 */
function stripParens(text) {
  return String(text || '').replace(/[（(][^）)]*[）)]/g, '');
}

/** 地图方位 → 角度。小地图固定北朝上，所以右边就是东。 */
const MAP_POS_DEG = {
  上: 0, 右上: 45, 右: 90, 右下: 135,
  下: 180, 左下: 225, 左: 270, 左上: 315
};

/**
 * 认「地图右边 / 地图左下角 / 小地图上方」这类位置说法。
 * 顺序有意义：右上要排在右前面，否则「右上」会被当成「右」。
 */
function mapPositionSegments(text) {
  const raw = String(text || '').replace(/\s+/g, '').slice(0, 500);
  if (!raw) return [];

  const re = /(?:小?地图)(?:的)?(右上|右下|左上|左下|上|下|左|右)(?:边|侧|角|方向|方位|位置)?/g;
  const out = [];
  let m;
  while ((m = re.exec(raw))) {
    const deg = MAP_POS_DEG[m[1]];
    if (typeof deg !== 'number') continue;
    out.push({ fraction: Math.min(0.95, m.index / Math.max(1, raw.length)), deg });
  }
  return out;
}

function detectCompassDir(text) {
  // 播放器会把同一句字幕反复推送（面板每次刷新都算一次），
  // 每次推送都点亮的话，开头那段双闪动画就会反复播，看起来像「闪两下」。
  // 同一句只认第一次。
  const key = String(text || '').replace(/\s+/g, '');
  if (!key) return;
  if (key === lastCompassText) {
    /* 同一句还在屏幕上。叠加层的光晕只亮 3.2 秒就淡出，
     * 而字幕往往要挂十几秒 —— 用户看到字、再抬头看小地图，光早就没了，
     * 于是每次都以为「没亮」。这里按节奏续期，字还在光就在。 */
    if (lastCompassDegs.length && Date.now() - lastCompassRefresh > 900) {
      lastCompassRefresh = Date.now();
      for (const d of lastCompassDegs) refreshCompassCue(d);
    }
    return;
  }
  lastCompassText = key;

  // 优先认地图位置：字幕里出现「地图右边」时它就是权威描述，
  // 同一句里的「东方向」通常只是复述，两边一起点亮会互相打架。
  const mapSegs = mapPositionSegments(stripParens(text));
  const segs = mapSegs.length
    ? mapSegs
    : directionSegments(text)
        .map((seg) => ({ fraction: seg.fraction, deg: atomsToCompass(seg.atoms) }))
        .filter((seg) => seg.deg !== null); // 自相矛盾的方向直接跳过

  if (!segs.length) {
    lastCompassDegs = [];
    // 句子里明明有方位字或「地图」，却没解析出方向 —— 这才是真该查的
    if (window.api.compassNone && /[东西南北]|地图/.test(key)) {
      window.api.compassNone({ text: key.slice(0, 50), reason: 'unparsed' });
    }
    return;
  }
  lastCompassDegs = segs.map((seg) => seg.deg);
  lastCompassRefresh = 0;

  const token = ++compassToken;
  const len = String(text || '').replace(/\s+/g, '').length;
  /* 按方位在句子里的位置做一点推迟，让点亮大致跟上语音。
   * 但上限必须压住：原来最长 8 秒，字幕早就翻到下一句了圈还没亮，
   * 用户感知就是「雷达慢半拍」。现在最多 2 秒，短句基本是立刻。 */
  const est = Math.min(2, Math.max(0.6, len * 0.12));

  for (const seg of segs) {
    const delay = Math.round(seg.fraction * est * 1000);
    if (delay <= 0) {
      fireCompassCue(seg.deg);
      continue;
    }
    setTimeout(() => {
      /* 这中间来了新字幕。只有当新字幕里**不再有这个方向**时才算过时 ——
       * AI 字幕逐字上屏时，同一句话会连推十几次，方位一直都在，
       * 那种情况必须照常点亮，否则一次都亮不起来。 */
      if (token !== compassToken && !lastCompassDegs.includes(seg.deg)) return;
      fireCompassCue(seg.deg);
    }, delay);
  }
}

/* ------------------------------------------ 魔改扩展：弹幕时间上报
 *
 * 不能直接把心跳里的 current 转发出去 —— 那样拖动进度条时不会带 seek 标记，
 * 弹幕层还按旧队列继续飘，看起来就是「拖完弹幕全乱」。
 *
 * 三条规则：
 *   · 播放/暂停立刻上报（不能被节流吞掉，否则暂停后还要再飘一秒）
 *   · 进度跳变 > 2 秒判定为拖动，带 seek 标记让弹幕层清队重排
 *   · 其余情况 1 秒节流，避免每帧都发 IPC
 */

let lastDmTime = -1;
let lastDmReport = 0;
let lastDmPlaying = null;

function reportDanmakuTime(v) {
  if (!state.boot || !state.boot.settings.enableDanmakuProjection) return;
  if (!v || !v.found || !Number.isFinite(v.current)) return;

  const now = Date.now();

  if (lastDmPlaying !== v.playing) {
    lastDmPlaying = v.playing;
    lastDmTime = v.current;
    lastDmReport = now;
    window.api.danmakuTime({ t: v.current, playing: !!v.playing });
    return;
  }

  const jumped = lastDmTime >= 0 && Math.abs(v.current - lastDmTime) > 2;
  if (jumped) {
    lastDmTime = v.current;
    lastDmReport = now;
    window.api.danmakuTime({ t: v.current, seek: true, playing: !!v.playing });
    return;
  }

  lastDmTime = v.current;
  if (now - lastDmReport < 1000) return;
  lastDmReport = now;
  window.api.danmakuTime({ t: v.current, playing: !!v.playing });
}
