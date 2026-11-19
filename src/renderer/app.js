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

  // 魔改扩展：按设置初始化 16:9 锁定按钮的状态
  $('btnRatio').classList.toggle('locked', s.ratioLocked === true);
  document.body.classList.toggle('ratio-locked', s.ratioLocked === true);

  createWebview();
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
    /* ---- 魔改扩展：字幕精灵相关通道 ---- */
    if (e.channel === 'guest-log') {
      // 访客页的调试日志转进浮窗控制台（F12 直接看）
      console.log('[guest]', (e.args && e.args[0]) || '');
      return;
    }
    if (e.channel === 'subtitle-time') {
      // 官方字幕模式下访客页每 200ms 报一次播放进度（比心跳更细）
      window.api.subtitleTime(e.args && e.args[0]);
      return;
    }
    if (e.channel === 'subtitle') {
      const p = e.args && e.args[0];
      window.api.subtitle(p || {});
      // 同一条字幕顺带判一次转向和绝对方位：
      //   detectTurn   → 相对指令（左转/右转），画面边缘弹大箭头
      //   detectCompassDir → 绝对方位（往东/东北），雷达模式点亮对应扇形
      if (p && !p.off && p.text) {
        detectTurn(p.text);
        detectCompassDir(p.text);
        // 智能防遮挡：这句在讲地图 / 锚点 / 传送，说明要看画面，别淡掉
        if (/地图|锚点|传送/.test(p.text)) window.api.avoidHide();
      }
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
    syncSubtitleToGuest();
    syncDanmakuHideToGuest();
    // 魔改扩展：比例锁定状态可能从控制台改的，按钮要跟上
    if (next.ratioLocked !== undefined) {
      $('btnRatio').classList.toggle('locked', !!next.ratioLocked);
      document.body.classList.toggle('ratio-locked', !!next.ratioLocked);
    }
    maybeAutoDump();
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

/**
 * 把识别参数下发到 webview。
 * extra.dump = true 时让访客把抓到的识别区域导出来，方便肉眼比对 ROI 有没有对准。
 */
/** 当前视频专属的标定区域列表，没有就用全局的 */
function roisFor(id) {
  const b = state.boot.settings.bearing || {};
  const own = id && b.roiBy ? b.roiBy[id] : null;
  if (Array.isArray(own) && own.length) return own;
  return Array.isArray(b.rois) ? b.rois : [];
}

/**
 * 把字幕相关设置下发给访客页。
 *
 * 只有「字幕精灵」或「转向提醒」开着才需要访客页干活；两个都关就整体关掉，
 * 顺带让访客页把注入的原生字幕透明样式撤掉。
 */
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

function syncBearingToGuest(extra) {
  const b = state.boot.settings.bearing || {};
  sendPlayer({
    cmd: 'bearing',
    on: !!b.enabled,
    rois: roisFor(state.id),
    // 视觉绿弧开关：关掉时访客页跳过扇形识别，每帧省一次大窗口扫描
    greenArc: state.boot.settings.enableVisionGreenArc === true,
    ...(extra || {})
  });
}

let bearingLostAt = 0;
let bearingHinted = false;

function onGuestBearing(p) {
  if (!p) return;

  // 「这一帧有没有箭头角度」由 angle 是否存在决定，不再看 ok。
  // 因为箭头认不出来时视角可能还有效（ok=false 但 view 有值），
  // 那种情况绿弧要照常更新，只是箭头原地不动。
  const hasAngle = typeof p.angle === 'number';

  if (hasAngle) {
    bearingLostAt = 0;
    bearingHinted = false;
  } else if (p.reason === '画面里没有小地图') {
    // 长时间认不出来多半是画面布局换了，提示一次，避免用户以为坏了
    if (!bearingLostAt) bearingLostAt = Date.now();
    else if (!bearingHinted && Date.now() - bearingLostAt > 8000) {
      bearingHinted = true;
      toast('连续找不到小地图：画面布局可能变了，点 ⚙ → ① 按当前画面重新框一次', 6500);
    }
  }

  window.api.bearing({
    angle: hasAngle ? p.angle : null,
    confidence: p.confidence || 0,
    // 视角（扇形）走独立字段，和行进方向不合并 ——
    // 站着转视角时两者本来就该不一样，合成一个反而都不准
    view: typeof p.view === 'number' ? p.view : null,
    viewConfidence: p.viewConfidence || 0,
    viewSource: p.viewSource || '',
    viewWidth: p.viewWidth || 0,
    hold: !!p.hold,
    // 魔改扩展：识别健康度随每帧一起上报，主进程拿它算成功率。
    // 不带上这个字段，控制台的「识别/最近/原因」永远是空的。
    stats: p.stats || null
  });
}

let autoDumped = false;

/**
 * 手动「自动定心」的结果。访客只负责算，修正值交给主进程写进该视频的标定，
 * 这样下次打开还是对准的（浮窗自己不留状态）。
 */
const AUTO_CENTER_FAIL = {
  paused: '视频没在播放，先播放再点自动定心',
  timeout: '没学会圆心：画面里可能没有小地图，或角色一直没转向，再点一次并让角色转个身',
  disabled: '先打开「显示方位箭头」',
  'no-roi': '还没框选视频里的小地图',
  'no-video': '还没找到视频',
  reset: '自动定心已取消',
  'save-failed': '已对准，但写入标定失败；本次会话内仍然有效'
};

function onGuestAutoCenter(p) {
  if (!p) return;
  if (p.phase === 'start') {
    toast('自动定心中：保持视频播放，角色走动 / 转身更容易成功（5~20 秒）', 6000);
    return;
  }
  if (p.phase === 'progress') return;
  if (p.phase !== 'done') return;

  if (!p.ok) {
    toast(AUTO_CENTER_FAIL[p.reason] || '自动定心没成功，再试一次', 6000);
    return;
  }
  if (!p.applied) {
    toast('圆心本来就对准了（偏差 ≤2 像素），不用调整', 5000);
    return;
  }
  toast(`圆心已自动对准：修正 (${p.dx}, ${p.dy})px`, 5000);
  // 交给主进程持久化：成功后浮窗会收到修正过的标定，临时修正随之归零
  try {
    const r = window.api.autoCenterResult({ ...p, videoId: state.id });
    if (r && typeof r.then === 'function') {
      r.then((out) => {
        if (!out || !out.ok) toast('已对准，但写入标定失败；本次会话内仍然有效', 6000);
      }).catch(() => {});
    }
  } catch {
    /* 主进程不在或通道关闭都不影响本次会话内的修正 */
  }
}

/** 未标定时自动导出一张识别区域图，方便排查；标定过就不打扰 */
function maybeAutoDump() {
  const b = state.boot.settings.bearing;
  if (!b || !b.enabled || b.calibrated || autoDumped) return;
  autoDumped = true;
  setTimeout(() => sendPlayer({ cmd: 'bearing', dump: true }), 12000);
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

const calib = { open: false, box: null, cx: 0, cy: 0, r: 60 };
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

  // 实时读数：半径占画面宽度的比例。原神小地图的圆盘半径普遍是这个宽度的
  // 13%~18%（博主放大录制时会更大），低于 12% 基本套不住整块小地图。
  const box = calib.box;
  if (box && box.w) {
    const pct = (calib.r / box.w) * 100;
    const sizeEl = $('calibSize');
    if (sizeEl) {
      sizeEl.textContent = `直径 ${Math.round(calib.r * 2)}px · 画面宽 ${pct.toFixed(1)}%${pct < 12 ? '（偏小）' : ''}`;
      sizeEl.style.color = pct < 12 ? 'var(--warn, #e0a33a)' : '';
    }
  }
}

function closeCalib() {
  calib.open = false;
  $('calib').classList.add('hidden');
}

async function openCalib() {
  if (!state.id) {
    toast('先载入一个视频，再框选小地图', 3200);
    return;
  }

  const info = await requestVideoRect();
  if (!info || !info.ok) {
    toast(
      info && info.error === 'no-frame' ? '视频画面还没解码出来，等几秒再试' : '没找到视频画面，稍后再试',
      4000
    );
    return;
  }

  calib.box = contentBox(info);

  // 初始位置：沿用已标的值；没标过就用出厂初值（实测对准的那块布局），
  // 免得一打开就落在画面外边、用户点「完成」直接存下一个错的区域。
  const base = roisFor(state.id)[0] || state.boot.seedRoi || { cx: 0.1434, cy: 0.2481, r: 0.1542 };
  calib.cx = calib.box.x + base.cx * calib.box.w;
  calib.cy = calib.box.y + base.cy * calib.box.h;
  // 半径低于画面宽 5% 的一定套不住整块小地图（常见是 9%~14%），放大到可用值
  calib.r = Math.max(16, Math.max(base.r, 0.09) * calib.box.w);

  calib.open = true;
  $('calib').classList.remove('hidden');
  $('calibHint').textContent = '拖动对准小地图圆心（大致即可，偏了可回启动器点「③ 自动定心」）· 滚轮缩放，让圆环刚好包住小地图圆盘';
  paintCalib();
}

async function saveCalib() {
  const box = calib.box;
  if (!box || !box.w) {
    closeCalib();
    return;
  }

  const roi = {
    cx: (calib.cx - box.x) / box.w,
    cy: (calib.cy - box.y) / box.h,
    r: calib.r / box.w
  };

  // 首次标定直接覆盖列表，不追加。
  // 以前无论标没标过都是「位置接近就替换、否则追加」，而出厂又预置了猜测值，
  // 于是框一次就变成「已标定 2 处」。现在：没确认过标定 = 这一块就是全部；
  // 确认过之后再框，才当作「另一种画面布局」追加。
  const calibrated = !!state.boot.settings.bearing.calibrated;
  const list = calibrated ? roisFor(state.id).slice() : [];

  // 跟已有区域位置重合就替换，否则当作「另一种画面布局」追加
  let hit = -1;
  for (let i = 0; i < list.length; i++) {
    if (Math.hypot(list[i].cx - roi.cx, (list[i].cy - roi.cy) * 0.75) < 0.08) {
      hit = i;
      break;
    }
  }
  if (hit >= 0) list[hit] = roi;
  else list.push(roi);

  const rois = list.slice(0, 4);

  await window.api.save({ bearing: { rois, calibrated: true, videoId: state.id || '' } });
  state.boot.settings.bearing.rois = rois;
  state.boot.settings.bearing.calibrated = true;
  if (state.id && state.boot.settings.bearing.roiBy) {
    state.boot.settings.bearing.roiBy[state.id] = rois;
  }
  syncBearingToGuest();
  closeCalib();

  toast(`已记住 ${rois.length} 处识别区域，正在抓一帧核对`, 3200);
  setTimeout(() => sendPlayer({ cmd: 'bearing', dump: true }), 900);
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
    if (!drag) return;
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
    if (c.cmd === 'calib') openCalib();
    else if (c.cmd === 'autocenter') sendPlayer({ cmd: 'autocenter' });
    else if (c.cmd === 'dump') sendPlayer({ cmd: 'bearing', dump: true });
    else if (c.cmd === 'load' && c.text) loadVideo(c.text, Number(c.p) || 1, true);
  });

  // 启动器改了设置（方位开关、标记大小、音量等），浮窗这边跟着更新
  window.api.onSettingsChanged((next) => {
    if (!next) return;
    state.boot.settings = next;
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

/** 真正点亮一个方位（带同方位去抖） */
function fireCompassCue(deg) {
  const now = Date.now();
  // 同一方位在停留时间内不重复点亮。
  // 按文字去重不够：AI 字幕会逐字上屏，同一句话每次都是不同的字符串，
  // 每次都算「新字幕」就每次都点亮一次，看着就是不停闪。按角度去重才可靠。
  if (Math.abs(deg - lastCompassCue.deg) < 1 && now - lastCompassCue.at < 3000) return;
  lastCompassCue = { deg, at: now };
  // 留一行日志：F12 打开浮窗控制台就能看到每次点亮，
  // 判断「闪两下」到底是同方位重复触发还是两个不同方位交替。
  console.log('[compass] 点亮', Math.round(deg), nearestDirName(deg), '←', lastCompassText.slice(0, 40));
  window.api.compassCue({ deg: Math.round(deg), label: nearestDirName(deg) });
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
  if (!key || key === lastCompassText) return;
  lastCompassText = key;

  // 优先认地图位置：字幕里出现「地图右边」时它就是权威描述，
  // 同一句里的「东方向」通常只是复述，两边一起点亮会互相打架。
  const mapSegs = mapPositionSegments(stripParens(text));
  const segs = mapSegs.length
    ? mapSegs
    : directionSegments(text)
        .map((seg) => ({ fraction: seg.fraction, deg: atomsToCompass(seg.atoms) }))
        .filter((seg) => seg.deg !== null); // 自相矛盾的方向直接跳过

  if (!segs.length) return;

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
      // 这中间来了新字幕，说明这句已经过时，别再点亮旧方向
      if (token !== compassToken) return;
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
