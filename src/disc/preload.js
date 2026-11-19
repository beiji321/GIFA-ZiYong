'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('discApi', {
  onState: (cb) => ipcRenderer.on('disc:ui', (_e, payload) => cb(payload))
});
