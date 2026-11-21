'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('boxApi', {
  // 主进程每次识别完把「识别区域 + 命中位置 + 分数」发过来，这里只负责画
  onDraw: (cb) => ipcRenderer.on('storybox:draw', (_e, data) => cb(data))
});
