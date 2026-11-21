'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  boot: () => ipcRenderer.invoke('app:boot'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  action: (name, payload) => ipcRenderer.invoke('win:action', name, payload),
  load: (payload) => ipcRenderer.invoke('bili:load', payload),
  /* 渲染层没有写 startup.log 的通道。「方向识别明明在跑，但箭头不出现」
   * 这类问题必须能看到浮窗发给访客页的配置到底是什么，否则只能猜。
   * 合并上游时这条通道被冲掉过一次。 */
  diag: (tag, payload) => ipcRenderer.invoke('app:diag', tag, payload),
  // 自动连播换 P：只换 cid/弹幕/字幕，不重新载入播放器
  part: (payload) => ipcRenderer.invoke('bili:part', payload),
  nav: () => ipcRenderer.invoke('bili:nav'),
  // 游戏内热键需要管理员身份（UIPI），由用户在启动器里按需触发 UAC 提权重启
  relaunchElevated: () => ipcRenderer.invoke('app:relaunch-elevated'),
  updateHotkeys: (hotkeys) => ipcRenderer.invoke('hotkeys:update', hotkeys),
  resetHotkeys: () => ipcRenderer.invoke('hotkeys:reset'),
  // 手柄八方向圆盘的动作绑定；map 是「方位名 → 动作名」，缺的方位沿用当前设置
  updateGamepad: (map) => ipcRenderer.invoke('gamepad:update', map),
  resetGamepad: () => ipcRenderer.invoke('gamepad:reset'),

  // 方位标记：角度是高频数据，用单向 send 避免 invoke 的往返开销
  bearing: (payload) => ipcRenderer.send('overlay:bearing', payload),
  overlayEnable: (on) => ipcRenderer.invoke('overlay:enable', on),
  // 不传参数即切换；传布尔值是幂等设置
  overlayPlace: (on) => ipcRenderer.invoke('overlay:place', on),
  // 放大提醒窗：进入/退出拖动模式
  alertPlace: (on) => ipcRenderer.invoke('alert:place', on),
  overlayPlaceState: () => ipcRenderer.invoke('overlay:place-state'),
  overlayRadius: (r) => ipcRenderer.invoke('overlay:radius', r),
  updateBearingLayout: (command) => ipcRenderer.invoke('bearing:layout', command),
  autoCenterResult: (r) => ipcRenderer.invoke('bearing:auto-center-result', r),
  onAutoCenterResult: (cb) => ipcRenderer.on('auto-center-result', (_e, r) => cb(r)),
  saveDump: (p) => ipcRenderer.invoke('overlay:dump-save', p),
  revealDump: () => ipcRenderer.invoke('overlay:reveal-dump'),

  // 输入状态：告诉主进程现在是不是在输入框里打字、是不是在录制新热键，
  // 这两段时间单键热键要让路，其余情况（包括窗口在前台）都该正常触发
  typing: (on) => ipcRenderer.send('ui:typing', !!on),
  capturing: (on) => ipcRenderer.send('ui:capture', !!on),

  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, action) => cb(action)),
  onNotice: (cb) => ipcRenderer.on('app:notice', (_e, text) => cb(text)),
  onPlaybackState: (cb) => ipcRenderer.on('playback:state', (_e, state) => cb(state)),
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, state) => cb(state)),
  onLogin: (cb) => ipcRenderer.on('login:state', (_e, nav) => cb(nav)),

  // 启动器 ↔ 浮窗
  onFloatState: (cb) => ipcRenderer.on('float:state', (_e, s) => cb(s)),
  onFloatCmd: (cb) => ipcRenderer.on('float:cmd', (_e, c) => cb(c)),
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (_e, s) => cb(s)),
  // 主进程把「这句字幕要判方位」送过来（接口字幕模式不走访客页）
  onCompassText: (cb) => ipcRenderer.on('compass-text', (_e, p) => cb(p)),

  /* ---- 魔改扩展：字幕层 / 弹幕层 / 托盘 / 播放控件 ---- */

  // 字幕：访客页抓到的文本转给主进程，由独立字幕层窗口绘制
  subtitle: (payload) => ipcRenderer.send('subtitle:update', payload),
  // 官方字幕模式：主进程拉到字幕轨后通知浮窗，浮窗再让访客页按进度报时间
  onSubtitleApi: (cb) => ipcRenderer.on('subtitle:api', (_e, s) => cb(s)),
  subtitleTime: (payload) => ipcRenderer.send('subtitle:time', payload),
  // 字幕来源状态 + 手动重读
  subtitleStatus: () => ipcRenderer.invoke('subtitle:status'),
  subtitleRefetch: () => ipcRenderer.invoke('subtitle:refetch'),

  // 转向提醒：浮窗匹配到方向词后转给字幕层画大箭头
  turn: (payload) => ipcRenderer.send('turn:update', payload),

  // 弹幕投影：浮窗上报播放进度，主进程按进度切片下发
  danmakuTime: (payload) => ipcRenderer.send('danmaku:time', payload),

  // 字幕点亮的绝对方位：转给叠加层画雷达
  compassCue: (cue) => ipcRenderer.send('compass:cue', cue),
  // 这句字幕没点亮：带上原文和原因，排查「说了方位却不亮」
  compassNone: (cue) => ipcRenderer.send('compass:none', cue),
  // 智能防遮挡：字幕里出现看地图类的词
  avoidHide: () => ipcRenderer.send('avoid:mark'),
  // 识别健康度：最近 60 帧成功率与失败原因，控制台每秒轮询
  bearingStats: () => ipcRenderer.invoke('bearing:stats'),

  // 播放控件（启动器的静音 / 倍速）
  playbackGet: () => ipcRenderer.invoke('playback:get'),
  playbackUpdate: (patch) => ipcRenderer.invoke('playback:update', patch),

  // 窗口比例状态：浮窗贴边吸附后回报，启动器据此更新微调滑块
  onRatioState: (cb) => ipcRenderer.on('ratio:state', (_e, s) => cb(s)),
  onResizePhase: (cb) => ipcRenderer.on('resize:phase', (_e, p) => cb(p)),
  onSnapEdges: (cb) => ipcRenderer.on('snap:edges', (_e, e) => cb(e))
});
