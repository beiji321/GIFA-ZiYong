'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('alertApi', {
  // 屏幕捕获源 + 要显示的区域（叠加层底下那块）
  onStream: (cb) => ipcRenderer.on('alert:stream', (_e, cfg) => cb(cfg)),
  // 方向来了：亮起来
  onShow: (cb) => ipcRenderer.on('alert:show', (_e, payload) => cb(payload)),
  // 放置模式：窗口变成可拖动，同时常亮
  onPlacing: (cb) => ipcRenderer.on('alert:placing', (_e, on) => cb(on))
});
