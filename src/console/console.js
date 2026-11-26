'use strict';

/**
 * 启动器 —— 所有设置都在这里改。
 * 浮窗只负责播放和方位箭头，本身不带任何设置界面。
 */

const $ = (id) => document.getElementById(id);
const HOLD_RATES = [1.25, 1.5, 2, 2.5, 3];
const GAMEPAD_NAMES = new Map([
  ['xinput', 'Xbox / XInput'],
  ['dualshock4', 'PS4 DualShock 4'],
  ['dualsense', 'PS5 DualSense'],
  ['dualsense-edge', 'PS5 DualSense Edge']
]);

const state = {
  boot: null,
  video: null, // 当前载入的 { text, id, pages, p, title }
  floatRunning: false,
  immersion: false,
  hoverFaded: false,
  placing: false, // 方位红圈是否处于「可拖动」状态，只由主进程返回值驱动
  toastTimer: null
};

/** 自动定心失败的原因 → 给用户看的话 */
const AUTO_CENTER_FAIL = {
  paused: '请先播放一段有小地图的画面',
  timeout: '没能对准：请播放一段小地图清楚、角色有转向的画面再试',
  disabled: '先打开「显示方位箭头」',
  'no-roi': '没有可用的视频小地图布局',
  'no-video': '浮窗里还没载入视频，先启动跟跑',
  'save-failed': '布局已切换或修改，本次结果未保存'
};

const LAYOUT_FAIL = {
  name: '请填写布局名称',
  duplicate: '已有同名布局，请换个名字',
  invalid: '布局已变更，请重新选择'
};

/* ------------------------------------------------------------------ 启动 */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  let initialGamepadModels;
  window.api.onGamepadDevices((models) => {
    if (!state.boot) initialGamepadModels = models;
    else {
      state.boot.gamepadModels = models;
      renderGamepadDevices(state.boot.settings);
    }
  });
  state.boot = await window.api.boot();
  if (initialGamepadModels) state.boot.gamepadModels = initialGamepadModels;
  const s = state.boot.settings;

  // 魔改扩展：字幕来源状态每秒刷新
  pollSubtitleStatus();
  setInterval(pollSubtitleStatus, 1000);
  // 识别健康度和字幕状态一起刷
  pollHealth();
  setInterval(pollHealth, 1000);

  $('ver').textContent = 'v' + (state.boot.version || '');

  // 滑块拖动时同步左侧的填充；程序改值（fillSettings）那条路在 fillSettings 里单独调
  document.addEventListener('input', (e) => {
    if (e.target && e.target.type === 'range') paintRange(e.target);
  });

  setFloatState(state.boot.floatState);
  fillSettings(s);
  renderHotkeys();
  renderGamepad();
  const hotkeysTab = $('tab-hotkeys');
  if (hotkeysTab.checked) paintGamepadDisc();
  else hotkeysTab.addEventListener('change', paintGamepadDisc, { once: true });
  applyNav(state.boot.nav);

  renderLastPart(s);
  renderLastWatched(s);
  updateVideoMeta();

  wireVideo();
  wireSettings();
  wireBearing();
  wireHotkeys();

  // 启动器窗口可能被关掉再打开，此刻主进程的放置状态未必是初始值，
  // 按钮文案必须对齐主进程，否则「显示 ② 拖到…」却一点就变成锁定。
  syncPlaceButton();

  // 只有在输入框里真的打字时才让单键热键让路。以前是「本程序窗口在前台就全忽略」，
  // 结果用户在启动器里按 J 想试试热键，一律被吞掉，看起来就像热键没接上。
  const isField = (el) =>
    !!el && /^(INPUT|TEXTAREA)$/.test(el.tagName) && !['checkbox', 'radio', 'range'].includes(el.type);
  document.addEventListener('focusin', (e) => window.api.typing(isField(e.target)));
  document.addEventListener('focusout', () => window.api.typing(false));

  window.api.onFloatState(setFloatState);
  window.api.onNotice((text) => toast(text));
  window.api.onLogin((nav) => applyNav(nav));
  window.api.onAutoCenterResult((result) => {
    if (!result) return;
    if (result.ok) toast('圆心已对准，布局已更新');
    else toast(AUTO_CENTER_FAIL[result.reason] || '没能对准圆心，请稍后再试', true);
  });
  // 浮窗改了设置（比如按热键切了穿透）就同步回界面
  window.api.onSettingsChanged((next) => {
    state.boot.settings = next;
    fillSettings(next);
    // 浮窗换片 / 自动连播下一 P 时，「上次看到」要立刻跟上
    renderLastWatched(next);
    if (state.video && next.lastVideoId && state.video.id &&
      String(next.lastVideoId).toLowerCase() !== String(state.video.id).toLowerCase()) {
      state.video = null;
    }
    if (!state.video) renderLastPart(next);
    else if (next.lastPart && next.lastPart !== state.video.p) {
      state.video.p = next.lastPart;
      renderParts();
    }
    updateVideoMeta();
  });
}

/* ------------------------------------------------------------ 视频与浮窗 */

function wireVideo() {
  for (const button of document.querySelectorAll('[data-open-pane]')) {
    button.addEventListener('click', () => {
      const tab = $(button.dataset.openPane);
      tab.click();
      tab.focus({ preventScroll: true });
    });
  }
  $('launchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const text = $('url').value.trim();
    launch(text, partForLaunch(text, state.boot.settings, $('part').value));
  });
  $('btnResume').addEventListener('click', resumeLast);
  const cover = $('resumeCover');
  cover.addEventListener('load', () => { cover.hidden = false; });
  cover.addEventListener('error', () => { cover.hidden = true; });

  $('part').addEventListener('change', async () => {
    const p = Number($('part').value) || 1;
    if (!state.video) return;
    state.video.p = p;
    renderParts();
    updateVideoMeta();
    await window.api.save({ lastPart: p });
    await window.api.load({ text: state.video.text, p });
    await window.api.action('float-load', { text: state.video.text, p });
    updateVideoMeta();
  });

  $('btnStop').addEventListener('click', () => window.api.action('stop-float'));
}

function partForLaunch(text, settings, selValue) {
  const link = String(text || '').trim();
  if (!link || link !== String(settings?.lastText || '').trim()) return undefined;
  const selected = Number(selValue);
  if (Number.isFinite(selected) && selected > 0) return Math.floor(selected);
  return Math.max(1, Math.floor(Number(settings?.lastPart) || 1));
}

function resumeLast() {
  const { lastText, lastPart } = state.boot.settings;
  if (!lastText) {
    toast('还没有观看记录', true);
    return;
  }
  return launch(lastText, Math.max(1, Number(lastPart) || 1));
}

function renderLaunchLabel() {
  const label = $('launchLabel');
  if ($('btnLaunch').disabled) label.textContent = '载入中…';
  else label.textContent = state.floatRunning ? '播放此链接' : '打开浮窗';
}

async function launch(text, part) {
  const launchButton = $('btnLaunch');
  if (launchButton.disabled) return;
  if (!text) {
    toast('先粘一个 B 站链接', true);
    $('url').focus();
    return;
  }

  launchButton.disabled = true;
  $('btnResume').disabled = true;
  renderLaunchLabel();

  try {
    /* 我方修复：本地原文点击时要保留用户当前选中的分 P。
     * 上游这里直接传 `part`，而 `part` 在「同一视频再次载入」时可能还是旧值，
     * 导致点了 P3 却回到 P1。partForLaunch 专门处理这个场景。 */
    const p = partForLaunch(text, state.boot.settings, $('part').value);
    const result = await window.api.load({ text, p });
    if (!result.ok) {
      toast(result.message || '载入失败', true);
      return;
    }
    state.video = { text, id: result.id, title: result.title || '', pages: result.pages || [], p: result.p };
    const previous = state.boot.settings;
    const sameVideo = previous.lastVideoId === result.id;
    Object.assign(previous, {
      lastText: text,
      lastPart: result.p,
      lastTitle: result.title || (sameVideo ? previous.lastTitle : ''),
      lastCover: result.cover || '',
      lastVideoId: result.id,
      lastPageCount: state.video.pages.length || (sameVideo ? previous.lastPageCount : 0),
      lastWatchedAt: Date.now()
    });
    renderParts();
    renderLastWatched(previous);
    updateVideoMeta();

    const wasRunning = state.floatRunning;
    await window.api.action('start-float');
    if (wasRunning) await window.api.action('float-load', { text, p: result.p });
    const hideKey = state.boot.settings.hotkeys?.toggleVisible;
    const message = wasRunning ? '视频已载入' : '浮窗已打开';
    toast(hideKey ? `${message}，${prettify(hideKey)} 可隐藏` : message);
  } catch {
    toast('没能启动播放，请重试', true);
  } finally {
    launchButton.disabled = false;
    $('btnResume').disabled = false;
    renderLaunchLabel();
  }
}

function renderLastPart(s) {
  if (state.video) return;
  const sel = $('part');
  const p = Math.max(1, Number(s.lastPart) || 1);
  const total = Number(s.lastPageCount) || 0;
  sel.textContent = '';
  const opt = document.createElement('option');
  opt.value = String(p);
  opt.textContent = `▶ P${p}${total ? '/' + total : ''}`;
  opt.title = opt.textContent;
  sel.appendChild(opt);
  sel.value = String(p);
  sel.disabled = true;
  sel.title = '载入视频后可选分 P';
}

function renderParts() {
  const sel = $('part');
  const pages = (state.video && state.video.pages) || [];
  sel.textContent = '';

  if (!pages.length) {
    const opt = document.createElement('option');
    opt.textContent = '仅 1 个分 P';
    opt.value = '1';
    opt.title = '仅 1 个分 P';
    sel.appendChild(opt);
    sel.value = '1';
    sel.disabled = true;
    sel.title = '仅 1 个分 P';
    return;
  }

  sel.disabled = false;
  const total = pages.length;
  let curLabel = '';
  for (const pg of pages) {
    const opt = document.createElement('option');
    opt.value = String(pg.page);
    // 和浮窗的下拉保持一致：把「第几 P / 共几 P」写进文本，当前项加 ▶
    const label = `P${pg.page}/${total} ${pg.part || ''}`.trim();
    const cur = !!(state.video && pg.page === state.video.p);
    opt.textContent = cur ? `▶ ${label}` : label;
    opt.title = label;
    sel.appendChild(opt);
    if (cur) curLabel = label;
  }
  sel.value = String(state.video ? state.video.p : 1);
  sel.title = curLabel ? `当前 ${curLabel}` : '分 P';
}

/* ------------------------------------------------------------ 上次看到 */

/** 时间戳 → 今天 / 昨天 / M月D日，带上时分；老记录没有时间戳就返回空 */
function fmtWatchedAt(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `昨天 ${hm}`;
  // 同一年内才省掉年份；否则「去年 12 月」会显示成「12月31日」被误读成今年
  if (diff > 1 && d.getFullYear() === now.getFullYear())
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 纯逻辑：从设置里挑出「上次看到」要显示的三段信息，便于离线回归 */
function lastWatchedLabel(s) {
  const name = String((s && (s.lastTitle || s.lastVideoId || s.lastText)) || '').trim();
  if (!name) return null;
  const p = Math.max(1, Number(s && s.lastPart) || 1);
  const total = Number(s && s.lastPageCount) || 0;
  return { name, part: `P${p}${total ? '/' + total : ''}`, when: fmtWatchedAt(s && s.lastWatchedAt) };
}

function coverSource(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value.startsWith('//') ? 'https:' + value : value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
      !/\.(hdslb|biliimg)\.com$/i.test(url.hostname)) return '';
    url.protocol = 'https:';
    return url.href;
  } catch {
    return '';
  }
}

function renderLastWatched(settings) {
  const bar = $('resumeBar');
  const info = lastWatchedLabel(settings);
  bar.hidden = !info || !settings.lastText;
  if (bar.hidden) return;
  $('resumeInfo').textContent = info.name;
  $('resumeInfo').title = [info.name, info.part, info.when].filter(Boolean).join(' · ');
  $('resumePart').textContent = info.part;
  $('resumeWhen').textContent = info.when;

  const cover = $('resumeCover');
  const src = coverSource(settings.lastCover);
  if ((cover.getAttribute('src') || '') !== src) {
    cover.hidden = true;
    if (src) cover.src = src;
    else cover.removeAttribute('src');
  }
}

function updateVideoMeta() {
  const video = state.video;
  const fallback = lastWatchedLabel(state.boot.settings);
  const label = video ? video.title || video.id : fallback?.name || '等待载入视频';
  const field = $('videoMeta');
  field.hidden = !$('resumeBar').hidden && label === fallback?.name;
  field.textContent = label;
  field.title = label;
}

function setFloatState(next) {
  const current = typeof next === 'boolean' ? { running: next } : next || {};
  if (state.floatRunning && !current.running) renderPlaceButton(false);
  state.floatRunning = !!current.running;
  state.immersion = state.floatRunning && !!current.immersion;
  state.hoverFaded = state.immersion && !!current.hoverFaded;
  const badge = $('floatState');
  badge.textContent = !state.floatRunning
    ? '浮窗未启动'
    : state.immersion
      ? state.hoverFaded ? '沉浸中 · 已变淡' : '沉浸模式'
      : '浮窗运行中';
  badge.className = 'badge ' + (state.floatRunning ? 'on' : 'off');
  $('playingControls').hidden = !state.floatRunning;
  $('btnStop').disabled = !state.floatRunning;
  renderLaunchLabel();
  $('setImmersion').checked = state.immersion;
}

/* ---------------------------------------------------------------- 设置 */

function currentLayout() {
  const bearing = state.boot.settings.bearing;
  return bearing.layouts.find((layout) => layout.id === bearing.activeLayoutId);
}

function renderLayouts(bearing) {
  const select = $('bearingLayout');
  const current = currentLayout();
  const options = bearing.layouts.map((layout) => {
    const option = document.createElement('option');
    option.value = layout.id;
    option.textContent = layout.name;
    return option;
  });
  select.replaceChildren(...options);
  select.value = current?.id || '';
  const defaultButton = $('btnLayoutDefault');
  defaultButton.disabled = !current || current.id === bearing.defaultLayoutId;
  defaultButton.textContent = current?.id === bearing.defaultLayoutId ? '启动默认布局' : '设为启动默认';
  const canEdit = current && !current.builtIn;
  for (const id of ['btnPickRoi', 'btnRenameLayout', 'btnDeleteLayout']) $(id).disabled = !canEdit;
  $('layoutStatus').textContent = current?.centered
    ? '当前布局已对准圆心，可用于同布局的视频。'
    : '启用方位箭头后，播放含小地图的片段即可自动定心。';
}

/**
 * 滑块左侧「已走过」的部分要填强调色，但 Chromium 的 range 没有对应的伪元素，
 * 只能把当前百分比写进 CSS 变量，由 console.css 里的渐变背景去画。
 */
function paintRange(el) {
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--fill', `${Math.min(100, Math.max(0, pct))}%`);
}

function renderPlaybackHints() {
  const hotkeys = state.boot.settings.hotkeys || {};
  const immersionKey = prettify(hotkeys.toggleImmersion ?? 'Alt+I');
  const holdKey = prettify(hotkeys.holdSpeed ?? 'F8');
  const cycleKey = prettify(hotkeys.cycleSpeed ?? 'Alt+S');
  $('homePlayKey').textContent = prettify(hotkeys.togglePlay ?? 'Alt+Space');
  $('homeHideKey').textContent = prettify(hotkeys.toggleVisible ?? 'Alt+H');
  $('immersionHint').textContent =
    `按 ${immersionKey} 进入或退出。窗口贴合视频比例并穿透鼠标，退出后恢复原位置和大小。`;
  $('holdRateHint').textContent =
    `按住 ${holdKey} 使用这个倍速，松开恢复。`;
  $('cycleSpeedHint').textContent =
    `${cycleKey} 在 1、1.25、1.5 和 2 倍之间切换。常规倍速会自动保存。`;
}

function renderGamepadDevices(settings) {
  const enabled = settings.gamepad?.enabled !== false;
  const models = state.boot.gamepadModels || [];
  const names = Array.from(new Set(models.map((model) => GAMEPAD_NAMES.get(model)).filter(Boolean)));
  const text = !enabled ? '后台手柄检测已关闭' : names.length
    ? `已识别 ${names.join('、')}`
    : '等待手柄输入。连接后动一下摇杆即可检查识别状态。';
  const status = $('gamepadStatus');
  if (status.textContent !== text) status.textContent = text;
}

function fillSettings(settings) {
  $('setPin').checked = !!settings.pinned;
  $('setPass').checked = !!settings.clickThrough;

  // 沉浸模式防遮挡（我方自用开关）
  $('setStoryHide').checked = !!(settings.storyAutoHide && settings.storyAutoHide.enabled);
  // 老 settings.json 可能没有 showBox 字段，默认显示（排查期需要它）
  $('setStoryBox').checked = !(settings.storyAutoHide && settings.storyAutoHide.showBox === false);
  $('setAvoidHide').checked = settings.avoidHideEnabled !== false;
  setRange('setAvoidHold', 'avoidHoldVal', settings.avoidHideHold, 4, 's');
  $('setCombatFade').checked = settings.combatFadeEnabled !== false;
  setRange('setCombatOpacity', 'combatOpacityVal', settings.combatOpacity, 75, '%');
  // 上游：手柄开关
  $('setGamepadEnabled').checked = settings.gamepad?.enabled !== false;
  renderGamepadDevices(settings);
  $('setImmersion').checked = state.immersion;
  $('setHoverFade').checked = settings.hoverFadeEnabled !== false;
  const holdRate = Number(settings.holdPlaybackRate);
  $('setHoldRate').value = String(HOLD_RATES.includes(holdRate) ? holdRate : 2);
  renderPlaybackHints();
  // 老 settings.json 没这个字段，默认视为开启
  $('setResumeOnLaunch').checked = settings.resumeOnLaunch !== false;

  const op = Math.round((settings.opacity ?? 1) * 100);
  $('setOpacity').value = String(op);
  $('opacityVal').textContent = op + '%';

  const vol = settings.volume ?? 100;
  $('setVolume').value = String(vol);
  $('volumeVal').textContent = vol + '%';

  const b = settings.bearing || {};
  $('setBearing').checked = !!b.enabled;
  $('setBearingSize').value = String(b.radius ?? 110);
  $('sizeVal').textContent = String(b.radius ?? 110);

  renderLayouts(b);

  // 所有滑块都要刷 --fill：只刷写死的那三个，其余滑块加载时
  // 左边那段蓝色会停在 CSS 默认的 50%，和右边显示的数字对不上
  for (const el of document.querySelectorAll('input[type="range"]')) paintRange(el);

  // 魔改扩展：字幕 / 弹幕开关回填
  $('setSubtitleSprite').checked = settings.enableSubtitleSprite === true;
  $('setSubHideNative').checked = settings.subtitleHideNative !== false;
  $('setDanmaku').checked = settings.enableDanmakuProjection === true;

  // 字幕外观
  setRange('setSubScale', 'subScaleVal', settings.subtitleScale, 100, '%');
  setRange('setSubOffset', 'subOffsetVal', settings.subtitleOffset, 230, 'px');
  setRange('setSubBg', 'subBgVal', settings.subtitleBgOpacity, 70, '%');
  setRange('setSubRadius', 'subRadiusVal', settings.subtitleRadius, 8, 'px');
  setRange('setSubWeight', 'subWeightVal', settings.subtitleWeight, 800, '');
  setRange('setSubMaxWidth', 'subMaxWidthVal', settings.subtitleMaxWidth, 88, '%');
  setRange('setSubHold', 'subHoldVal', settings.subtitleHold, 3, 's');
  $('setSubColor').value = /^#[0-9a-f]{6}$/i.test(settings.subtitleColor || '')
    ? settings.subtitleColor
    : '#ffffff';
  $('setSubStroke').value = settings.subtitleStroke || 'outline';

  // 弹幕外观
  setRange('setDmArea', 'dmAreaVal', settings.danmakuArea, 50, '%');
  setRange('setDmOpacity', 'dmOpacityVal', settings.danmakuOpacity, 80, '%');
  setRange('setDmScale', 'dmScaleVal', settings.danmakuScale, 100, '%');
  setRange('setDmSpeed', 'dmSpeedVal', settings.danmakuSpeed, 50, '');
  setRange('setDmWeight', 'dmWeightVal', settings.danmakuWeight, 700, '');
  setRange('setDmMax', 'dmMaxVal', settings.danmakuMax, 60, '');
  $('setDmStroke').checked = settings.danmakuStroke !== false;
  $('setDmHideNative').checked = settings.danmakuHideNative !== false;

  // 视觉绿弧
  $('setGreenArc').checked = settings.enableVisionGreenArc === true;
  $('setOverlayRadar').checked = settings.overlayRadar === true;
  $('setAlertEnabled').checked = settings.alertEnabled === true;

  // 播放与托盘
  $('setPlaybackRate').value = String(settings.playbackRate ?? 1);
  $('setRatioLock').checked = settings.ratioLocked === true;
  setRange('setSnapAdjust', 'snapAdjustVal', settings.snapAdjustment, 0, 'px');
  $('setMuted').checked = settings.muted === true;
  $('setCloseToTray').checked = settings.closeToTray !== false;
  $('setTrayClickFloat').checked = settings.trayClickAction === 'float';

  // 转向提醒
  $('setTurnReminder').checked = settings.enableTurnReminder !== false;
  $('setTurnLR').checked = settings.turnEnableLR !== false;
  $('setTurnUD').checked = settings.turnEnableUD !== false;

  // 字幕行为开关
  $('setSubUseApi').checked = settings.subtitleUseApi !== false;
  $('setSubMergeOverlap').checked = settings.subtitleMergeOverlap !== false;
  $('setSubHideOnPause').checked = settings.subtitleHideOnPause === true;
  $('setSubAutoOpen').checked = settings.subtitleAutoOpen !== false;
  $('setSubPos').value = settings.subtitlePos || 'center';
  $('setSubKeepRatio').checked = settings.subtitleKeepRatio !== false;
  $('setSubFade').checked = settings.subtitleFade !== false;

  // 转向外观
  setRange('setTurnOffset', 'turnOffsetVal', settings.turnOffset, 400, 'px');
  setRange('setTurnScale', 'turnScaleVal', settings.turnScale, 100, '%');
  setRange('setTurnDuration', 'turnDurationVal', settings.turnDuration, 2, 's');
  setRange('setTurnOpacity', 'turnOpacityVal', settings.turnOpacity, 85, '%');
  setRange('setTurnPosY', 'turnPosYVal', settings.turnPosY, 50, '%');
  setRange('setTurnPosX', 'turnPosXVal', settings.turnPosX, 50, '%');
  $('setTurnColor').value = /^#[0-9a-f]{6}$/i.test(settings.turnColor || '')
    ? settings.turnColor
    : '#49b2fc';
}

/**
 * 字幕来源状态：每秒刷一次。
 *
 * 三种情况要能一眼分清 —— API 拿到字幕轨 / 接口没给而降级抓网页 / 两边都没有，
 * 否则用户只会看到「屏幕上没有字幕」，不知道是哪一环出的问题。
 */
async function pollSubtitleStatus() {
  const el = $('subSourceText');
  if (!el) return;
  try {
    const st = await window.api.subtitleStatus();
    if (!st) {
      el.textContent = '等待视频载入…';
      return;
    }
    if (!st.enabled) {
      el.textContent = '字幕精灵未开启';
      return;
    }
    if (st.mode === 'api') el.textContent = `官方接口加载成功（${st.count} 条）`;
    else if (st.mode === 'dom') el.textContent = '接口无字幕，已降级为网页抓取';
    else el.textContent = '未识别到字幕';
  } catch {
    el.textContent = '读取状态失败';
  }
}

/** 把范围控件的值写进去，同时刷新右侧数值 */
function setRange(id, valId, value, fallback, suffix) {
  const el = $(id);
  if (!el) return;
  const v = Number.isFinite(Number(value)) ? Number(value) : fallback;
  el.value = String(v);
  const label = $(valId);
  if (label) label.textContent = `${v}${suffix}`;
  // 设完值必须重画填充条，否则蓝色那段还停在旧位置
  paintRange(el);
}

/**
 * 绑定一个字幕/弹幕外观滑块：拖动时实时下发，松手才落盘。
 *
 * 用 input 事件做实时预览、change 事件做持久化，避免拖动过程中
 * 每一帧都写一次 settings.json。
 */
function bindStyleRange(id, valId, suffix, makePatch) {
  const el = $(id);
  if (!el) return;
  const label = $(valId);
  const paint = () => {
    if (label) label.textContent = `${el.value}${suffix}`;
  };
  el.addEventListener('input', () => {
    paint();
    window.api.save(makePatch(Number(el.value)));
  });
  el.addEventListener('change', () => {
    paint();
    window.api.save(makePatch(Number(el.value)));
  });
}

/**
 * 识别健康度：最近 60 帧的成功率与失败分类。
 * 用来回答「为什么画面上没有箭头」—— 区分「识别停了」和「在跑但认不出来」。
 */
function renderHealth(st) {
  const sum = $('healthSummary');
  const ok = $('healthLastOk');
  const why = $('healthReason');
  if (!sum || !ok || !why) return;

  if (!st) {
    sum.textContent = '等待视频载入…';
    sum.classList.remove('bad');
    ok.textContent = '—';
    why.textContent = '—';
    return;
  }

  const win = st.window || 0;
  const good = st.ok || 0;
  const pct = win ? Math.round((good / win) * 100) : 0;
  const parts = [`最近 ${win} 帧 成功 ${good}（${pct}%）`];
  if (st.noMap) parts.push(`无小地图 ${st.noMap}`);
  if (st.noRoi) parts.push(`未框选 ${st.noRoi}`);
  if (st.hold) parts.push(`疑似反向 ${st.hold}`);
  sum.textContent = parts.join(' · ');
  sum.classList.toggle('bad', win > 0 && good === 0);

  // 超过 5 秒没有更新：识别循环停了（视频暂停 / 开关关闭）
  if (st.ageMs != null && st.ageMs > 5000) {
    ok.textContent = `识别已停止更新（${Math.round(st.ageMs / 1000)} 秒前）`;
    ok.classList.add('bad');
  } else if (st.lastOkAt) {
    const agoSec = Math.max(0, Math.round((Date.now() - st.lastOkAt) / 100) / 10);
    ok.textContent = `${agoSec} 秒前`;
    ok.classList.remove('bad');
  } else {
    ok.textContent = '还没成功过';
    ok.classList.add('bad');
  }

  why.textContent = st.lastReason || (good ? '正常' : '—');
  why.classList.toggle('bad', !!st.lastReason);
}

async function pollHealth() {
  try {
    renderHealth(await window.api.bearingStats());
  } catch {
    /* 主进程还没就绪 */
  }
}

function wireSettings() {
  /* ---- 魔改扩展：字幕 / 弹幕 ---- */
  $('setSubtitleSprite').addEventListener('change', (event) => {
    const on = event.target.checked;
    state.boot.settings.enableSubtitleSprite = on;
    window.api.save({ enableSubtitleSprite: on });
    toast(on ? '已启用底部字幕精灵' : '已关闭字幕精灵');
    pollSubtitleStatus();
  });
  $('setSubHideNative').addEventListener('change', (event) => {
    const on = event.target.checked;
    state.boot.settings.subtitleHideNative = on;
    window.api.save({ subtitleHideNative: on });
    toast(on ? '已隐藏播放器原生字幕' : '原生字幕恢复显示');
  });
  $('setDanmaku').addEventListener('change', (event) => {
    const on = event.target.checked;
    state.boot.settings.enableDanmakuProjection = on;
    window.api.save({ enableDanmakuProjection: on });
    toast(on ? '已启用全屏弹幕投影' : '已关闭弹幕投影');
  });
  $('btnSubRefetch').addEventListener('click', async () => {
    const btn = $('btnSubRefetch');
    btn.disabled = true;
    try {
      const r = await window.api.subtitleRefetch();
      if (!r || !r.ok) {
        const why =
          r && r.reason === 'no-video'
            ? '还没有载入视频'
            : r && r.reason === 'api-off'
              ? '官方字幕接口已关闭'
              : '读取失败';
        toast(why, true);
      } else if (r.count) {
        toast(`已读取 ${r.count} 条字幕`);
      } else {
        toast('该视频没有可用字幕轨，继续使用网页抓取', true);
      }
    } catch {
      toast('读取失败', true);
    } finally {
      btn.disabled = false;
      pollSubtitleStatus();
    }
  });

  /* ---- 魔改扩展：字幕外观 ---- */
  bindStyleRange('setSubScale', 'subScaleVal', '%', (v) => ({ subtitle: { scale: v } }));
  bindStyleRange('setSubOffset', 'subOffsetVal', 'px', (v) => ({ subtitle: { offset: v } }));
  bindStyleRange('setSubBg', 'subBgVal', '%', (v) => ({ subtitle: { bgOpacity: v } }));
  bindStyleRange('setSubRadius', 'subRadiusVal', 'px', (v) => ({ subtitle: { radius: v } }));
  bindStyleRange('setSubWeight', 'subWeightVal', '', (v) => ({ subtitle: { weight: v } }));
  bindStyleRange('setSubMaxWidth', 'subMaxWidthVal', '%', (v) => ({ subtitle: { maxWidth: v } }));
  bindStyleRange('setSubHold', 'subHoldVal', 's', (v) => ({ subtitle: { hold: v } }));

  $('setSubColor').addEventListener('change', (event) => {
    window.api.save({ subtitle: { color: event.target.value } });
  });
  $('setSubStroke').addEventListener('change', (event) => {
    window.api.save({ subtitle: { stroke: event.target.value } });
  });

  /* ---- 魔改扩展：弹幕外观 ---- */
  bindStyleRange('setDmArea', 'dmAreaVal', '%', (v) => ({ danmaku: { area: v } }));
  bindStyleRange('setDmOpacity', 'dmOpacityVal', '%', (v) => ({ danmaku: { opacity: v } }));
  bindStyleRange('setDmScale', 'dmScaleVal', '%', (v) => ({ danmaku: { scale: v } }));
  bindStyleRange('setDmSpeed', 'dmSpeedVal', '', (v) => ({ danmaku: { speed: v } }));
  bindStyleRange('setDmWeight', 'dmWeightVal', '', (v) => ({ danmaku: { weight: v } }));
  bindStyleRange('setDmMax', 'dmMaxVal', '', (v) => ({ danmaku: { max: v } }));
  $('setDmHideNative').addEventListener('change', (event) => {
    state.boot.settings.danmakuHideNative = event.target.checked;
    window.api.save({ danmakuHideNative: event.target.checked });
    toast(event.target.checked ? '已隐藏播放器原生弹幕' : '原生弹幕恢复显示');
  });
  $('setDmStroke').addEventListener('change', (event) => {
    window.api.save({ danmaku: { stroke: event.target.checked } });
  });

  /* ---- 魔改扩展：数据目录 / 字幕外观重置 ---- */
  $('btnOpenData').addEventListener('click', () => {
    window.api.action('open-data');
  });

  $('btnSubReset').addEventListener('click', () => {
    // 字幕外观恢复出厂：只动外观，不动开关和来源设置
    const def = {
      scale: 100,
      color: '#ffffff',
      stroke: 'outline',
      pos: 'center',
      offset: 230,
      bgOpacity: 70,
      keepRatio: true,
      fade: true,
      hold: 3,
      maxWidth: 88,
      weight: 800,
      radius: 8
    };
    window.api.save({ subtitle: def }).then(() => {
      state.boot.settings = {
        ...state.boot.settings,
        subtitleScale: def.scale,
        subtitleColor: def.color,
        subtitleStroke: def.stroke,
        subtitlePos: def.pos,
        subtitleOffset: def.offset,
        subtitleBgOpacity: def.bgOpacity,
        subtitleKeepRatio: def.keepRatio,
        subtitleFade: def.fade,
        subtitleHold: def.hold,
        subtitleMaxWidth: def.maxWidth,
        subtitleWeight: def.weight,
        subtitleRadius: def.radius
      };
      fillSettings(state.boot.settings);
      toast('字幕外观已恢复默认');
    });
  });

  /* ---- 魔改扩展：视觉绿弧 / 播放 / 托盘 ---- */
  $('setAlertEnabled').addEventListener('change', (event) => {
    const on = event.target.checked;
    state.boot.settings.alertEnabled = on;
    window.api.save({ alertEnabled: on });
    toast(on ? '已开启放大提醒' : '已关闭放大提醒');
  });


  $('btnAlertPlace').addEventListener('click', async () => {
    if (!state.boot.settings.alertEnabled) {
      toast('先打开「放大提醒」再拖位置', true);
      return;
    }
    const placing = await window.api.alertPlace();
    $('btnAlertPlace').textContent = placing ? '完成（点这里锁定）' : '拖动提醒窗位置';
    toast(placing ? '直接拖动屏幕上的提醒窗，拖好再点一次' : '提醒窗位置已记住');
  });

  $('setOverlayRadar').addEventListener('change', (event) => {
    const on = event.target.checked;
    state.boot.settings.overlayRadar = on;
    window.api.save({ overlayRadar: on });
    toast(on ? '已切换到四轴罗盘雷达' : '已切回原版圆环箭头');
  });

  $('setGreenArc').addEventListener('change', (event) => {
    const on = event.target.checked;
    state.boot.settings.enableVisionGreenArc = on;
    window.api.save({ enableVisionGreenArc: on });
    toast(on ? '已开启镜头朝向绿弧（可能乱飘）' : '已关闭绿弧，扇形识别不再运行');
  });

  $('setPlaybackRate').addEventListener('change', (event) => {
    const rate = Number(event.target.value);
    state.boot.settings.playbackRate = rate;
    window.api.playbackUpdate({ playbackRate: rate });
    toast(`常规倍速 ${rate}×`);
  });

  bindStyleRange('setSnapAdjust', 'snapAdjustVal', 'px', (v) => ({ snapAdjustment: v }));

  $('setRatioLock').addEventListener('change', (event) => {
    const on = event.target.checked;
    state.boot.settings.ratioLocked = on;
    window.api.save({ ratioLocked: on });
    toast(on ? '已锁定 16:9' : '已解除比例锁定');
  });

  $('setMuted').addEventListener('change', (event) => {
    state.boot.settings.muted = event.target.checked;
    window.api.playbackUpdate({ muted: event.target.checked });
  });

  $('setCloseToTray').addEventListener('change', (event) => {
    state.boot.settings.closeToTray = event.target.checked;
    window.api.save({ closeToTray: event.target.checked });
    toast(event.target.checked ? '关闭启动器时会收进托盘' : '关闭启动器会直接退出');
  });

  $('setTrayClickFloat').addEventListener('change', (event) => {
    const action = event.target.checked ? 'float' : 'launcher';
    state.boot.settings.trayClickAction = action;
    window.api.save({ trayClickAction: action });
    toast(event.target.checked ? '托盘单击切换浮窗' : '托盘单击显示启动器');
  });

  /* ---- 魔改扩展：字幕行为开关 ---- */
  const subSwitch = (id, key, onText, offText) => {
    $(id).addEventListener('change', (event) => {
      const on = event.target.checked;
      state.boot.settings[key] = on;
      window.api.save({ [key]: on });
      if (onText) toast(on ? onText : offText);
    });
  };
  subSwitch('setSubUseApi', 'subtitleUseApi', '优先使用官方字幕接口', '只用网页抓取');
  subSwitch('setSubMergeOverlap', 'subtitleMergeOverlap', '多行字幕合并显示', '只显示最新一条');
  subSwitch('setSubHideOnPause', 'subtitleHideOnPause', '暂停时隐藏字幕', '暂停时保持显示');
  subSwitch('setSubAutoOpen', 'subtitleAutoOpen', '会自动点开播放器字幕', '不会改动播放器字幕按钮');

  $('setSubPos').addEventListener('change', (event) => {
    window.api.save({ subtitle: { pos: event.target.value } });
  });
  $('setSubKeepRatio').addEventListener('change', (event) => {
    window.api.save({ subtitle: { keepRatio: event.target.checked } });
  });
  $('setSubFade').addEventListener('change', (event) => {
    window.api.save({ subtitle: { fade: event.target.checked } });
  });

  /* ---- 魔改扩展：转向外观 ---- */
  bindStyleRange('setTurnOffset', 'turnOffsetVal', 'px', (v) => ({ turn: { offset: v } }));
  bindStyleRange('setTurnScale', 'turnScaleVal', '%', (v) => ({ turn: { scale: v } }));
  bindStyleRange('setTurnDuration', 'turnDurationVal', 's', (v) => ({ turn: { duration: v } }));
  bindStyleRange('setTurnOpacity', 'turnOpacityVal', '%', (v) => ({ turn: { opacity: v } }));
  bindStyleRange('setTurnPosY', 'turnPosYVal', '%', (v) => ({ turn: { posY: v } }));
  bindStyleRange('setTurnPosX', 'turnPosXVal', '%', (v) => ({ turn: { posX: v } }));
  $('setTurnColor').addEventListener('change', (event) => {
    window.api.save({ turn: { color: event.target.value } });
  });

  /* ---- 魔改扩展：转向提醒 ---- */
  $('setTurnReminder').addEventListener('change', (event) => {
    state.boot.settings.enableTurnReminder = event.target.checked;
    window.api.save({ enableTurnReminder: event.target.checked });
    toast(event.target.checked ? '已启用转向提醒' : '已关闭转向提醒');
  });
  $('setTurnLR').addEventListener('change', (event) => {
    state.boot.settings.turnEnableLR = event.target.checked;
    window.api.save({ turn: { enableLR: event.target.checked } });
  });
  $('setTurnUD').addEventListener('change', (event) => {
    state.boot.settings.turnEnableUD = event.target.checked;
    window.api.save({ turn: { enableUD: event.target.checked } });
  });

  $('setImmersion').addEventListener('change', async (event) => {
    try {
      await window.api.action('immersion', event.target.checked);
    } catch {
      $('setImmersion').checked = state.immersion;
      toast('切换沉浸模式失败，请重试', true);
    }
  });
  $('setHoverFade').addEventListener('change', (event) => {
    const enabled = event.target.checked;
    state.boot.settings.hoverFadeEnabled = enabled;
    window.api.save({ hoverFadeEnabled: enabled });
  });
  $('setHoldRate').addEventListener('change', (event) => {
    const holdRate = Number(event.target.value);
    if (!HOLD_RATES.includes(holdRate)) return;
    state.boot.settings.holdPlaybackRate = holdRate;
    window.api.save({ holdPlaybackRate: holdRate });
  });

  $('setResumeOnLaunch').addEventListener('change', (e) => {
    state.boot.settings.resumeOnLaunch = e.target.checked;
    window.api.save({ resumeOnLaunch: e.target.checked });
    updateVideoMeta();
  });

  $('setPin').addEventListener('change', (e) => window.api.action('pin', e.target.checked));

  $('setAvoidHide').addEventListener('change', (e) => {
    const on = e.target.checked;
    state.boot.settings.avoidHideEnabled = on;
    window.api.save({ avoidHideEnabled: on });
  });

  bindStyleRange('setAvoidHold', 'avoidHoldVal', 's', (v) => ({ avoidHideHold: v }));

  $('setStoryHide').addEventListener('change', (e) => {
    const on = e.target.checked;
    state.boot.settings.storyAutoHide = state.boot.settings.storyAutoHide || {};
    state.boot.settings.storyAutoHide.enabled = on;
    // 浮窗隐藏并进这个总开关：用户要的是「剧情时全部收起」，
    // 分成两个开关只会让人不确定该开哪个。
    state.boot.settings.storyAutoHide.hideFloat = on;
    window.api.save({ storyAutoHide: { enabled: on, hideFloat: on } });
  });

  $('setStoryBox').addEventListener('change', (e) => {
    const on = e.target.checked;
    state.boot.settings.storyAutoHide = state.boot.settings.storyAutoHide || {};
    state.boot.settings.storyAutoHide.showBox = on;
    window.api.save({ storyAutoHide: { showBox: on } });
  });

  $('setCombatFade').addEventListener('change', (e) => {
    const on = e.target.checked;
    state.boot.settings.combatFadeEnabled = on;
    window.api.save({ combatFadeEnabled: on });
  });

  bindStyleRange('setCombatOpacity', 'combatOpacityVal', '%', (v) => ({ combatOpacity: v }));

  $('setPass').addEventListener('change', (e) => {
    window.api.action('pass', e.target.checked);
    if (e.target.checked) toast('鼠标穿透已开启，按 Alt+L 关闭');
  });

  $('setOpacity').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('opacityVal').textContent = v + '%';
    window.api.action('opacity', v / 100);
  });

  $('setVolume').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('volumeVal').textContent = v + '%';
    state.boot.settings.volume = v;
    window.api.save({ volume: v, muted: v === 0 });
  });

  $('btnLogin').addEventListener('click', () => window.api.action('login'));
}

/**
 * 按钮文案只认主进程返回的真实状态，界面不自行推断。
 * 主进程是唯一真相源：关掉箭头开关、启动器重开都会改变放置状态。
 */
function renderPlaceButton(placing) {
  state.placing = !!placing;
  $('btnPlace').textContent = placing ? '锁定位置' : '摆放方位标记';
  // 摆放中整颗按钮高亮，提醒「再点一次才算锁定」
  $('btnPlace').classList.toggle('active', !!placing);
}

async function syncPlaceButton() {
  try {
    renderPlaceButton(await window.api.overlayPlaceState());
  } catch (_) {
    // 老版主进程没有查询接口时保持默认文案，不影响其它设置
  }
}

async function changeLayout(command, message) {
  try {
    const result = await window.api.updateBearingLayout(command);
    if (result.bearing) state.boot.settings.bearing = result.bearing;
    fillSettings(state.boot.settings);
    if (!result.ok) toast(LAYOUT_FAIL[result.reason] || '布局未保存，请重试', true);
    else if (message) toast(message);
    return result.ok;
  } catch {
    fillSettings(state.boot.settings);
    toast('布局未保存，请重试', true);
    return false;
  }
}

function showLayoutNameForm(mode) {
  const form = $('layoutNameForm');
  const layout = currentLayout();
  form.dataset.mode = mode;
  form.dataset.id = layout?.id || '';
  $('layoutName').value = mode === 'rename' ? layout.name : '';
  $('btnSaveLayoutName').textContent = mode === 'rename' ? '保存名称' : '去框选';
  form.hidden = false;
  $('layoutName').focus();
  $('layoutName').select();
}

async function startLayoutCalibration(command) {
  try {
    const result = await window.api.action('calib', command);
    if (result === true) return true;
    if (result === 'click-through') {
      toast('请先在「浮窗」关闭鼠标穿透，再框选', true);
      return false;
    }
  } catch {
    toast('未能打开框选，请重试', true);
    return false;
  }
  toast('请先启动跟跑并找到视频里的小地图', true);
  return false;
}

function wireBearing() {
  $('setBearing').addEventListener('change', async (event) => {
    const on = event.target.checked;
    state.boot.settings.bearing = await window.api.overlayEnable(on);
    if (on) toast(`已开启方位箭头 · ${currentLayout().name}`);
    fillSettings(state.boot.settings);
    await syncPlaceButton();
  });

  $('setBearingSize').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('sizeVal').textContent = String(v);
    window.api.overlayRadius(v);
  });

  $('bearingLayout').addEventListener('change', (event) => {
    $('layoutNameForm').hidden = true;
    changeLayout({ op: 'select', id: event.target.value });
  });
  $('btnLayoutDefault').addEventListener('click', () => {
    changeLayout({ op: 'default', id: currentLayout().id }, '下次启动会使用此布局');
  });
  $('btnNewLayout').addEventListener('click', () => showLayoutNameForm('create'));
  $('btnRenameLayout').addEventListener('click', () => showLayoutNameForm('rename'));
  $('btnCancelLayoutName').addEventListener('click', () => { $('layoutNameForm').hidden = true; });
  $('layoutNameForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = $('layoutName').value.trim().replace(/\s+/g, ' ');
    if (!name) return toast(LAYOUT_FAIL.name, true);
    const op = form.dataset.mode;
    const id = form.dataset.id;
    if (state.boot.settings.bearing.layouts.some((layout) =>
      (op !== 'rename' || layout.id !== id) && layout.name.toLowerCase() === name.toLowerCase()
    )) return toast(LAYOUT_FAIL.duplicate, true);
    const ok = op === 'rename'
      ? await changeLayout({ op, id, name }, '已保存布局名称')
      : await startLayoutCalibration({ op: 'create', name });
    if (ok) form.hidden = true;
  });
  $('btnDeleteLayout').addEventListener('click', () => {
    const layout = currentLayout();
    if (layout && window.confirm(`删除布局「${layout.name}」？`)) {
      changeLayout({ op: 'remove', id: layout.id }, '已删除布局');
    }
  });
  $('btnPickRoi').addEventListener('click', () => {
    const layout = currentLayout();
    if (layout) startLayoutCalibration({ op: 'calibrate', id: layout.id });
  });

  $('btnAutoCenter').addEventListener('click', async () => {
    if (!state.boot.settings.bearing.enabled) return toast(AUTO_CENTER_FAIL.disabled, true);
    if (!(await window.api.action('autocenter'))) toast(AUTO_CENTER_FAIL['no-video'], true);
    else toast('正在对准：请保持视频播放，有转向的画面更容易成功');
  });

  $('btnPlace').addEventListener('click', async () => {
    if (!state.boot.settings.bearing.enabled) {
      toast('先打开「显示方位箭头」', true);
      return;
    }
    // 关键：不传参数，让主进程按当前状态切换。
    // 以前这里硬写 true，第二下点「锁定位置」只是又进了一次放置模式，
    // 红圈永远退出不了拖动状态，看起来就像「怎么点都锁不上」。
    const placing = await window.api.overlayPlace();
    renderPlaceButton(placing);
    toast(
      placing
        ? '把红圈拖到游戏里的小地图上，再点一次「锁定位置」'
        : '已锁定位置，红圈不会再被拖动；下次启动仍在这里'
    );
  });

  $('btnDumpRoi').addEventListener('click', () => {
    window.api.action('dump');
    toast('正在抓取识别区域…');
  });

  $('btnOpenDump').addEventListener('click', async () => {
    const dir = await window.api.revealDump();
    toast(`导出目录：${dir}`);
  });

}

/* --------------------------------------------------------------- 热键 */

function wireHotkeys() {
  $('setGamepadEnabled').addEventListener('change', async (event) => {
    const input = event.currentTarget;
    try {
      await window.api.save({ gamepadEnabled: input.checked });
    } catch {
      input.checked = state.boot.settings.gamepad?.enabled !== false;
      toast('手柄开关未保存，请重试', true);
    }
  });
  $('btnResetHk').addEventListener('click', async () => {
    const res = await window.api.resetHotkeys();
    state.boot.settings.hotkeys = res.hotkeys;
    state.boot.hookRunning = res.hookRunning;
    renderHotkeys();
    reportFailed(res.failed);
  });

  $('btnResetGp').addEventListener('click', async () => {
    state.boot.settings.gamepad = await window.api.resetGamepad();
    renderGamepad();
    toast('手柄方位已恢复出厂映射');
  });
}

function renderHotkeys() {
  const list = $('hkList');
  const hotkeys = state.boot.settings.hotkeys || {};
  list.textContent = '';

  for (const meta of state.boot.hotkeys) {
    const row = document.createElement('div');
    row.className = 'hk-row';

    const label = document.createElement('span');
    label.textContent = meta.label;

    const kbd = document.createElement('button');
    kbd.className = 'kbd';
    kbd.setAttribute('aria-label', `${meta.label}，${prettify(hotkeys[meta.key])}，点击改键`);
    paintKeys(kbd, hotkeys[meta.key]);
    kbd.addEventListener('click', () => captureHotkey(kbd, meta.key));

    row.append(label, kbd);
    list.appendChild(row);
  }

  renderHookState();
  renderPlaybackHints();
}

/**
 * 手柄八方向的动作绑定表。可选项来自 app:boot 的白名单，圆盘不认的动作不会出现在这里；
 * 「未绑定」是合法选择，圆盘上那一格显示「未绑定」，松杆什么都不做。
 * 行名用映射表里的方位 key（n / ne / e…），和左边参考图扇区上的字是同一串。
 */
function renderGamepad() {
  const list = $('gpList');
  const map = (state.boot.settings.gamepad || {}).map || {};
  const labelByKey = new Map(state.boot.hotkeys.map((meta) => [meta.key, meta.label]));
  const options = [
    { value: '', text: '未绑定' },
    ...(state.boot.gamepadActions || []).map((key) => ({ value: key, text: labelByKey.get(key) || key }))
  ];

  list.textContent = '';
  for (const dir of state.boot.gamepadDirs || []) {
    const row = document.createElement('div');
    row.className = 'hk-row';

    const label = document.createElement('span');
    label.className = 'gp-key';
    label.textContent = dir.key;

    const select = document.createElement('select');
    select.className = 'sel';
    select.title = `${dir.label}方向绑定的动作`;
    select.setAttribute('aria-label', select.title);
    for (const option of options) {
      const item = document.createElement('option');
      item.value = option.value;
      item.textContent = option.text;
      select.appendChild(item);
    }
    select.value = map[dir.key] || '';
    select.addEventListener('change', async () => {
      // 用主进程返回值重画：非法动作被白名单挡掉的结果也能立刻看得见
      state.boot.settings.gamepad = await window.api.updateGamepad({ [dir.key]: select.value });
      renderGamepad();
    });

    row.append(label, select);
    list.appendChild(row);
  }
}

/** 参考图边长（CSS 像素）。写在 JS 里：非活动的标签页是 display:none，从样式上量不到尺寸 */
const GP_DISC_SIZE = 232;

/**
 * 卡片左边那张圆盘参考图。画法用的是浮窗同一份 disc-draw.js，不传 labels 时扇区
 * 就退回方位 key，于是图上标的 n / ne / e 和右边行名一一对上。
 */
function paintGamepadDisc() {
  const canvas = $('gpDisc');
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${GP_DISC_SIZE}px`;
  canvas.style.height = `${GP_DISC_SIZE}px`;
  canvas.width = Math.round(GP_DISC_SIZE * dpr);
  canvas.height = Math.round(GP_DISC_SIZE * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  window.GdiscDraw.drawDisc(ctx, {
    width: GP_DISC_SIZE,
    height: GP_DISC_SIZE,
    hint: '按住左摇杆'
  });
}

/**
 * 把加速器画成一组键帽：Alt+Space → [Alt] + [空格]。
 * 一整串「Alt+空格」塞在一个按钮里，扫一眼分不清是几个键；拆开后和键盘上的样子对得上。
 * 鼠标侧键是一个整体，不按 + 拆。
 */
function paintKeys(kbd, acc) {
  kbd.textContent = '';
  kbd.title = '点击后按下新的键位';
  if (!acc) {
    kbd.textContent = '未设置';
    return;
  }
  const parts = /^(RMB\+)?Mouse[45]$/i.test(acc) ? [acc] : String(acc).split('+');
  parts.forEach((part, i) => {
    if (i) {
      const plus = document.createElement('span');
      plus.className = 'plus';
      plus.textContent = '+';
      kbd.appendChild(plus);
    }
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = prettify(part);
    kbd.appendChild(key);
  });
}

/**
 * 单键、侧键、循环倍速及长按动作依赖系统钩子；倍速组合键也使用被动监听。
 */
function renderHookState() {
  const el = $('hkState');
  if (!el) return;
  // 提权提示与「有没有单键绑定」无关：Alt 组合键走 RegisterHotKey，
  // 在提权窗口（原神）前台时同样收不到（UIPI），所以永远要在首屏提示
  renderElevateState();

  const hotkeys = state.boot.settings.hotkeys || {};
  const hookActions = new Set((state.boot.hotkeys || [])
    .filter((meta) => meta.hold || meta.key === 'cycleSpeed').map((meta) => meta.key));
  const hookKeys = Object.entries(hotkeys).filter(([action, accelerator]) =>
    accelerator &&
    (hookActions.has(action) ||
      !String(accelerator).includes('+') ||
      // 右键+侧键是带 + 的，但它走钩子而不是 globalShortcut
      /^RMB\+Mouse[45]$/i.test(accelerator)));
  const running = !!state.boot.hookRunning;

  if (!hookKeys.length) {
    el.className = 'hk-state';
    el.textContent = '当前没有单键、侧键、循环倍速或长按绑定，全部走系统独占组合键';
    return;
  }
  el.className = 'hk-state ' + (running ? 'ok' : 'bad');
  el.textContent = running
    ? `单键、侧键与倍速监听已启动（${hookKeys.length} 个键位）${
        state.boot.elevated ? '，在游戏里也能触发' : '，但游戏内需管理员身份（见上）'
      }`
    : '单键、侧键与倍速监听未启动，这些键位目前不会响应（可能被杀毒软件拦截）';
}

/**
 * 没提权时，游戏里的热键必然不响 —— 这是 Windows 的 UIPI 规则，不是程序坏了：
 * 原神这类游戏以管理员启动，非提权进程的低级钩子收不到「提权窗口在前台」时的按键。
 * 与其让用户反复试，不如把原因和办法直接写在键盘位下面。
 */
function renderElevateState() {
  const el = $('elevBanner');
  if (!el) return;
  if (state.boot.elevated) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const text = $('elevBannerText');
  if (text) {
    text.textContent =
      '当前未以管理员身份运行，在游戏内使用全局快捷键可能不生效。';
  }

  const btn = $('btnElevate');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '正在请求权限…';
      // 成功时主进程会退出本实例，UAC 确认后以管理员身份重新拉起；
      // 失败基本只有一种原因：用户在 UAC 弹窗上点了「否」
      const r = await window.api.relaunchElevated();
      if (!r || !r.ok) {
        btn.disabled = false;
        btn.textContent = r && r.reason === 'uac-cancelled' ? '已取消，重试' : label;
      }
    });
  }
}

/** 当前正在录制的那一个键位，点别的键位时先取消它，避免监听器叠加 */
let activeCapture = null;

function captureHotkey(kbd, key) {
  if (activeCapture) activeCapture();

  // 录制期间把全局单键热键挡掉，否则按 J 会先暂停视频再被录进去，顺序全靠运气
  window.api.capturing(true);

  kbd.classList.add('capturing');
  kbd.textContent = '按键位、侧键，或按住右键再按侧键…';

  // 录制期间右键是否按着：用来拼「右键 + 侧键」
  let rightDown = false;

  const cleanup = () => {
    window.api.capturing(false);
    kbd.classList.remove('capturing');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onMouse, true);
    document.removeEventListener('mouseup', onMouseUp, true);
    if (activeCapture === cleanup) activeCapture = null;
  };

  const commit = async (acc) => {
    cleanup();
    const res = await window.api.updateHotkeys({ [key]: acc });
    state.boot.settings.hotkeys = res.hotkeys;
    state.boot.hookRunning = res.hookRunning;
    renderHotkeys();

    // 注册被系统否决时主进程已经把旧键位还原了，这里要说清楚，别让用户以为改成了
    if (res.rejected && res.rejected.includes(key)) {
      toast(`${prettify(acc)} 被系统或其他程序占用，已保留原来的键位`, true);
      return;
    }
    // 撞到别的动作时主进程做了互换，得提示一句，否则用户会发现自己另一个热键变了却不知道为什么
    if (res.swapped && res.swapped.length && !(res.failed || []).length) {
      toast(`已设置为 ${prettify(acc)}，原来占用它的动作已和它互换`);
      return;
    }
    reportFailed(res.failed, key);
  };

  const onKey = async (e) => {
    // 只按住 Ctrl/Alt/Shift/Win 时不算一次录入，继续等真正的按键
    if (/^(Control|Shift|Alt|Meta)(Left|Right)?$/.test(e.code || '')) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      cleanup();
      renderHotkeys();
      return;
    }

    const acc = toAccelerator(e);
    if (!acc) {
      kbd.textContent = '这个键不支持，换一个';
      return;
    }
    await commit(acc);
  };

  // 鼠标：DOM 里 button 2 = 右键、3 = 后退侧键、4 = 前进侧键
  const onMouse = async (e) => {
    if (e.button === 2) {
      rightDown = true; // 右键本身不当作键位，只作为组合前缀
      return;
    }
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    e.stopPropagation();
    await commit(`${rightDown ? 'RMB+' : ''}Mouse${e.button + 1}`);
  };

  const onMouseUp = (e) => {
    if (e.button === 2) rightDown = false;
  };

  activeCapture = cleanup;
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onMouse, true);
  document.addEventListener('mouseup', onMouseUp, true);
}

function reportFailed(failed, focusKey) {
  if (!failed || !failed.length) return;
  const hit = focusKey ? failed.find((f) => f.key === focusKey) : failed[0];
  if (!hit) return;
  if (hit.unsupported) {
    toast(`${prettify(hit.accelerator)} 这个键钩子认不出来，换成字母、数字、F 键或方向键试试`, true);
    return;
  }
  if (hit.hook) {
    toast('被动监听依赖系统钩子，当前钩子启动失败；循环倍速和长按加速即使使用组合键也需要钩子，其他动作可先改用 Alt/Ctrl 组合', true);
    return;
  }
  toast(`${prettify(hit.accelerator)} 被系统或其他程序占用，请换一个`, true);
}

function toAccelerator(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  const k = keyName(e);
  if (!k) return '';
  // 单键（不带修饰键）现在也允许：它们走低级钩子被动监听，不会把键从别的程序里抢走
  return [...mods, k].join('+');
}

function keyName(e) {
  const code = e.code || '';
  let m;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1];
  if ((m = code.match(/^Digit(\d)$/))) return m[1];
  if ((m = code.match(/^F(\d{1,2})$/))) return 'F' + m[1];

  const map = {
    Space: 'Space',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    Escape: 'Esc',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Comma: ',',
    Period: '.',
    Slash: '/'
  };
  if (map[code]) return map[code];
  if (e.key && e.key.length === 1) return e.key.toUpperCase();
  return '';
}

function prettify(acc) {
  if (!acc) return '未设置';
  if (/^Mouse4$/i.test(acc)) return '鼠标侧键 ◀';
  if (/^Mouse5$/i.test(acc)) return '鼠标侧键 ▶';
  if (/^RMB\+Mouse4$/i.test(acc)) return '右键+侧键 ◀';
  if (/^RMB\+Mouse5$/i.test(acc)) return '右键+侧键 ▶';
  return String(acc)
    .replace(/\bSuper\b/g, 'Win')
    .replace(/\bLeft\b/g, '←')
    .replace(/\bRight\b/g, '→')
    .replace(/\bUp\b/g, '↑')
    .replace(/\bDown\b/g, '↓')
    .replace(/\bSpace\b/g, '空格');
}

/* ---------------------------------------------------------------- 账号 */

function applyNav(nav) {
  const button = $('btnLogin');
  const label = $('accountLine');
  button.classList.toggle('on', !!nav?.loggedIn);
  if (nav?.loggedIn) {
    label.textContent = nav.uname || 'B 站已登录';
    button.title = `已登录 ${nav.uname || 'B 站'}${nav.vip ? '（大会员）' : ''} · 点击登录或切换账号`;
  } else {
    label.textContent = '登录 B 站';
    button.title = nav?.ok === false ? '暂未能确认登录状态，点击打开登录窗口' : '登录 B 站以观看完整视频和高清画质';
  }
  button.setAttribute('aria-label', nav?.loggedIn ? `切换 B 站账号，当前为${nav.uname || '已登录账号'}` : '登录 B 站');
}

/* ---------------------------------------------------------------- 杂项 */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(text, bad) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('bad', !!bad);
  el.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}
