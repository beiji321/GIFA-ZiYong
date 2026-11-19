'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  onBearing: (cb) => ipcRenderer.on('bearing', (_e, payload) => cb(payload)),
  onMode: (cb) => ipcRenderer.on('mode', (_e, mode) => cb(mode)),
  // 雷达圈几何：标定圆心半径（决定雷达圈直径 = 标定半径 + 15px）
  onRadar: (cb) => ipcRenderer.on('radar:config', (_e, cfg) => cb(cfg)),
  // 字幕里出现的绝对方位（东北/往东/右下角…）：点亮对应扇形并高亮文字
  onCompassCue: (cb) => ipcRenderer.on('compass:cue', (_e, cue) => cb(cue)),
  // 脚本就绪握手：radar.js / overlay.js 是动态插入的，加载完成时间不定，
  // 主进程在 did-finish-load 时下发的配置可能比监听注册还早，消息会直接丢掉。
  // 由这边加载完再主动要一次，主进程收到才推配置。
  ready: () => ipcRenderer.send('overlay:ready'),
  // 状态自报：叠加层是透明窗口，画没画出来肉眼很难判断，
  // 打包版又没有控制台。让它自己把关键状态报回去，排查时看日志就够，
  // 不用让用户盯着屏幕描述现象。
  report: (state) => ipcRenderer.send('overlay:state', state),
  // 把画布存成 PNG 落盘一次：唯一能确认「屏幕上到底该长什么样」的办法
  dump: (dataUrl, tag) => ipcRenderer.send('overlay:dump', dataUrl, tag),
  // 请求主进程抖一下窗口尺寸，逼 DWM 重新合成透明窗口
  nudge: () => ipcRenderer.send('overlay:nudge'),
  // 自绘拖动：不经过系统标题栏拖动，避免 Aero Snap 把窗口弹回原位
  dragStart: (p) => ipcRenderer.send('overlay:drag-start', p),
  dragMove: (p) => ipcRenderer.send('overlay:drag-move', p),
  dragEnd: () => ipcRenderer.send('overlay:drag-end')
});
