'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  onBearing: (cb) => ipcRenderer.on('bearing', (_e, payload) => cb(payload)),
  onMode: (cb) => ipcRenderer.on('mode', (_e, mode) => cb(mode)),
  // 雷达圈几何：标定圆心半径（决定雷达圈直径 = 标定半径 + 15px）
  onRadar: (cb) => ipcRenderer.on('radar:config', (_e, cfg) => cb(cfg)),
  // 字幕里出现的绝对方位（东北/往东/右下角…）：点亮对应扇形并高亮文字
  onCompassCue: (cb) => ipcRenderer.on('compass:cue', (_e, cue) => cb(cue)),
  // 自绘拖动：不经过系统标题栏拖动，避免 Aero Snap 把窗口弹回原位
  dragStart: (p) => ipcRenderer.send('overlay:drag-start', p),
  dragMove: (p) => ipcRenderer.send('overlay:drag-move', p),
  dragEnd: () => ipcRenderer.send('overlay:drag-end')
});
