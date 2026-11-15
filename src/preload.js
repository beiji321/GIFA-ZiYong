'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  boot: () => ipcRenderer.invoke('app:boot'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  action: (name, payload) => ipcRenderer.invoke('win:action', name, payload),
  load: (payload) => ipcRenderer.invoke('bili:load', payload),
  nav: () => ipcRenderer.invoke('bili:nav'),
  // 游戏内热键需要管理员身份（UIPI），由用户在启动器里按需触发 UAC 提权重启
  relaunchElevated: () => ipcRenderer.invoke('app:relaunch-elevated'),
  updateHotkeys: (hotkeys) => ipcRenderer.invoke('hotkeys:update', hotkeys),
  resetHotkeys: () => ipcRenderer.invoke('hotkeys:reset'),

  // 方位标记：角度是高频数据，用单向 send 避免 invoke 的往返开销
  bearing: (payload) => ipcRenderer.send('overlay:bearing', payload),
  overlayEnable: (on) => ipcRenderer.invoke('overlay:enable', on),
  // 不传参数即切换；传布尔值是幂等设置
  overlayPlace: (on) => ipcRenderer.invoke('overlay:place', on),
  overlayPlaceState: () => ipcRenderer.invoke('overlay:place-state'),
  overlayRadius: (r) => ipcRenderer.invoke('overlay:radius', r),
  // 手动自动定心的结果：由浮窗转交主进程，把修正写进该视频的标定
  autoCenterResult: (r) => ipcRenderer.invoke('bearing:auto-center-result', r),
  onAutoCenterResult: (cb) => ipcRenderer.on('auto-center-result', (_e, r) => cb(r)),
  saveDump: (p) => ipcRenderer.invoke('overlay:dump-save', p),
  revealDump: () => ipcRenderer.invoke('overlay:reveal-dump'),
  onBearingState: (cb) => ipcRenderer.on('bearing:state', (_e, s) => cb(s)),
  // 识别健康度：启动器轮询，显示「最近 N 帧成功/失败分类」
  bearingStats: () => ipcRenderer.invoke('bearing:stats'),

  // 输入状态：告诉主进程现在是不是在输入框里打字、是不是在录制新热键，
  // 这两段时间单键热键要让路，其余情况（包括窗口在前台）都该正常触发
  typing: (on) => ipcRenderer.send('ui:typing', !!on),
  capturing: (on) => ipcRenderer.send('ui:capture', !!on),

  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, action) => cb(action)),
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, state) => cb(state)),
  // 贴边吸附：主进程告诉渲染层哪几条边的提示线该亮
  onSnapEdges: (cb) => ipcRenderer.on('snap:edges', (_e, p) => cb(p)),
  // 字幕文本转交给主进程，由独立的全屏字幕窗口绘制
  subtitle: (payload) => ipcRenderer.send('subtitle:update', payload),
  // 字幕转向提醒：把匹配到的方向转给字幕层画大箭头
  turn: (payload) => ipcRenderer.send('turn:update', payload),
  // 字幕里的绝对方位（东北/往东/右下角…）：点亮叠加层雷达圈对应的扇区
  compassCue: (payload) => ipcRenderer.send('compass:cue', payload),
  // 弹幕按播放进度驱动：浮窗把 <video> 的时间报给主进程切片段
  danmakuTime: (payload) => ipcRenderer.send('danmaku:time', payload),
  // 主进程是比例锁定的权威状态：窗口重建后用它校正 UI，避免图标和实际行为不一致
  onRatioState: (cb) => ipcRenderer.on('ratio:state', (_e, s) => cb(s)),
  // 窗口拖动缩放期间的高频通知：用来冻结 webview、避免露出黑底
  onResizePhase: (cb) => ipcRenderer.on('win:resize-phase', (_e, s) => cb(s)),
  onLogin: (cb) => ipcRenderer.on('login:state', (_e, nav) => cb(nav)),

  // 启动器 ↔ 浮窗
  onFloatState: (cb) => ipcRenderer.on('float:state', (_e, s) => cb(s)),
  onFloatCmd: (cb) => ipcRenderer.on('float:cmd', (_e, c) => cb(c)),
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (_e, s) => cb(s))
});
