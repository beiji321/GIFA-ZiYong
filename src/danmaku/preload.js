'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('danmakuLayer', {
  onConfig: (cb) => ipcRenderer.on('danmaku:config', (_e, cfg) => cb(cfg)),
  onSlice: (cb) => ipcRenderer.on('danmaku:slice', (_e, p) => cb(p)),
  onTime: (cb) => ipcRenderer.on('danmaku:time', (_e, p) => cb(p)),
  onReset: (cb) => ipcRenderer.on('danmaku:reset', () => cb())
});
