'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('danmakuLayer', {
  onConfig: (cb) => ipcRenderer.on('danmaku:config', (_e, cfg) => cb(cfg)),
  onSlice: (cb) => ipcRenderer.on('danmaku:slice', (_e, p) => cb(p)),
  onTime: (cb) => ipcRenderer.on('danmaku:time', (_e, p) => cb(p)),
  onReset: (cb) => ipcRenderer.on('danmaku:reset', () => cb()),
  // 状态自报：弹幕层是全屏透明窗口，「看不到」可能是没数据、
  // 也可能是有数据但没画出来、被盖住。让它自己报，不用靠肉眼判断。
  report: (state) => ipcRenderer.send('danmaku:state', state)
});
