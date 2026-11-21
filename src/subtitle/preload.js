'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 只暴露「收字幕 / 收外观配置」两件事：这个窗口不需要其他权限
contextBridge.exposeInMainWorld('subtitleLayer', {
  onText: (cb) => ipcRenderer.on('subtitle:text', (_e, payload) => cb(payload)),
  onConfig: (cb) => ipcRenderer.on('subtitle:config', (_e, cfg) => cb(cfg)),
  onTurn: (cb) => ipcRenderer.on('turn:hint', (_e, p) => cb(p)),
  onTurnConfig: (cb) => ipcRenderer.on('turn:config', (_e, cfg) => cb(cfg)),
  // 没有内容要画了：告诉主进程可以把整个窗口藏起来，省掉全屏透明层的合成开销
  idle: () => ipcRenderer.send('subtitle:idle')
});
